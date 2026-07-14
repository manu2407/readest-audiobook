import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useAuth } from '@/context/AuthContext';
import { useThemeStore } from '@/store/themeStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useBookProgress } from '@/store/readerProgressStore';
import { useProofreadStore } from '@/store/proofreadStore';
import { TransformContext } from '@/services/transformers/types';
import { proofreadTransformer } from '@/services/transformers/proofread';
import { useTranslation } from '@/hooks/useTranslation';
import {
  ensureSharedAudioContext,
  TTSController,
  TTSHighlightOptions,
  TTSVoicesGroup,
} from '@/services/tts';
import { DEFAULT_SENTENCE_GAP_SEC } from '@/services/tts/EdgeTTSClient';
import { DEFAULT_PARAGRAPH_GAP_SEC } from '@/services/tts/TTSController';
import { eventDispatcher } from '@/utils/event';
import { genSSMLRaw, parseSSMLLang } from '@/utils/ssml';
import { throttle } from '@/utils/throttle';
import { isCfiInLocation } from '@/utils/cfi';
import { getLocale } from '@/utils/misc';
import { estimateTTSTime } from '@/utils/ttsTime';
import { releaseUnblockAudio, ttsMediaBridge, unblockAudio } from '@/services/tts/ttsMediaBridge';
import { getBookHashFromKey, ttsSessionManager } from '@/services/tts/TTSSessionManager';
import { TTSUtils } from '@/services/tts/TTSUtils';
import { escapeNarrationForSSML } from '@/services/tts/aiScript';
import { createRejectFilter } from '@/utils/node';

interface UseTTSControlProps {
  bookKey: string;
  onRequestHidePanel?: () => void;
}

export const useTTSControl = ({ bookKey, onRequestHidePanel }: UseTTSControlProps) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { user } = useAuth();
  const { isDarkMode } = useThemeStore();
  const getBookData = useBookDataStore((s) => s.getBookData);
  const getView = useReaderStore((s) => s.getView);
  const getProgress = useReaderStore((s) => s.getProgress);
  const getViewSettings = useReaderStore((s) => s.getViewSettings);
  const setViewSettings = useReaderStore((s) => s.setViewSettings);
  const setTTSEnabled = useReaderStore((s) => s.setTTSEnabled);
  const { getMergedRules } = useProofreadStore();

  const [ttsLang, setTtsLang] = useState<string>('en');
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [showIndicator, setShowIndicator] = useState(false);
  const [showBackToCurrentTTSLocation, setShowBackToCurrentTTSLocation] = useState(false);

  const [timeoutOption, setTimeoutOption] = useState(0);
  const [timeoutTimestamp, setTimeoutTimestamp] = useState(0);

  const [isPreprocessed, setIsPreprocessed] = useState(false);
  const [isPreprocessing, setIsPreprocessing] = useState(false);
  const [preprocessingProgress, setPreprocessingProgress] = useState<number | null>(null);

  const followingTTSLocationRef = useRef(true);
  const sectionChangingTimestampRef = useRef(0);
  const previousSectionLabelRef = useRef<string | undefined>(undefined);
  const ttsControllerRef = useRef<TTSController | null>(null);
  const ttsAiCacheRef = useRef<Map<string, string>>(new Map());
  const ttsAiFullScriptRef = useRef<string | null>(null);
  const ttsAiSectionIndexRef = useRef<number>(-1);
  const isStartingTTSRef = useRef(false);
  // Last broadcast playback state, so a follower engaging mid-session can be
  // replayed the current state on demand (see handleTTSSyncRequest).
  const playbackStateRef = useRef<'playing' | 'paused' | 'stopped'>('stopped');
  const [ttsController, setTtsController] = useState<TTSController | null>(null);
  const [ttsClientsInited, setTtsClientsInitialized] = useState(false);

  // Broadcast playback transitions on the app-wide bus so consumers that
  // can't read the hook-local isPlaying flag (RSVP, paragraph mode) can react.
  const emitPlaybackState = (state: 'playing' | 'paused' | 'stopped') => {
    playbackStateRef.current = state;
    eventDispatcher.dispatch('tts-playback-state', { bookKey, state });
  };

  // A follower (paragraph / RSVP mode) that engages mid-session asks the
  // controller to re-broadcast its current playback state and position, so it
  // can sync immediately instead of waiting for the next word/sentence boundary
  // (or forcing the user to stop and restart TTS inside the mode). Replays only
  // when a session actually exists (playing or paused).
  const handleTTSSyncRequest = (event: CustomEvent) => {
    const detail = event.detail as { bookKey?: string } | undefined;
    if (detail?.bookKey !== bookKey) return;
    const state = playbackStateRef.current;
    if (state !== 'playing' && state !== 'paused') return;
    if (!ttsControllerRef.current) return;
    // Position first, then state: RSVP's 'paused' handler drops following, which
    // would discard a position arriving after it. Position-first lets the
    // follower sync the current word/paragraph before a (possibly paused) state
    // lands. Only the entering mode listens to these events, so the order is
    // deterministic. The live flow (separate emits) is unaffected.
    ttsControllerRef.current.redispatchPosition();
    emitPlaybackState(state);
  };

  const handleTTSForward = async (event: CustomEvent) => {
    const detail = event.detail as { bookKey: string; byMark?: boolean } | undefined;
    if (detail?.bookKey !== bookKey) return;
    const ttsController = ttsControllerRef.current;
    if (ttsController) {
      await ttsController.forward(detail?.byMark ?? false);
    }
  };

  const handleTTSBackward = async (event: CustomEvent) => {
    const detail = event.detail as { bookKey: string; byMark?: boolean } | undefined;
    if (detail?.bookKey !== bookKey) return;
    const ttsController = ttsControllerRef.current;
    if (ttsController) {
      await ttsController.backward(detail?.byMark ?? false);
    }
  };

  const handleTTSHighlightSentence = (event: CustomEvent) => {
    const detail = event.detail as { bookKey: string } | undefined;
    if (detail?.bookKey !== bookKey) return;
    const sentence = ttsControllerRef.current?.getSpokenSentence();
    if (!sentence) return;
    eventDispatcher.dispatch('create-tts-highlight', { bookKey, ...sentence });
  };

  // Set the TTS rate from the app bus. The RSVP overlay is full-screen, so its
  // rate picker can't reach the TTS panel; it dispatches `tts-set-rate` and we
  // reuse the same controller rate-change path the panel uses (handleSetRate,
  // defined below — stop→setRate→start while playing, throttled). Also persists
  // the value to viewSettings so it survives like a panel change.
  const handleTTSSetRate = (event: CustomEvent) => {
    const detail = event.detail as { bookKey: string; rate?: number } | undefined;
    if (detail?.bookKey !== bookKey || typeof detail.rate !== 'number') return;
    const viewSettings = getViewSettings(bookKey);
    if (viewSettings) {
      viewSettings.ttsRate = detail.rate;
      setViewSettings(bookKey, viewSettings);
    }
    handleSetRate(detail.rate);
  };

  const handleTTSTogglePlay = async (event: CustomEvent) => {
    const detail = event.detail as { bookKey: string } | undefined;
    if (detail?.bookKey !== bookKey) return;
    const ttsController = ttsControllerRef.current;
    if (!ttsController) return;
    if (ttsController.state === 'playing') {
      setIsPlaying(false);
      setIsPaused(true);
      emitPlaybackState('paused');
      await ttsController.pause();
    } else {
      setIsPlaying(true);
      setIsPaused(false);
      emitPlaybackState('playing');
      if (ttsController.state === 'paused') {
        await ttsController.resume();
      } else {
        await ttsController.start();
      }
    }
  };

  useEffect(() => {
    eventDispatcher.on('tts-speak', handleTTSSpeak);
    eventDispatcher.on('tts-stop', handleTTSStop);
    eventDispatcher.on('tts-close-book', handleTTSCloseBook);
    eventDispatcher.on('tts-forward', handleTTSForward);
    eventDispatcher.on('tts-backward', handleTTSBackward);
    eventDispatcher.on('tts-toggle-play', handleTTSTogglePlay);
    eventDispatcher.on('tts-set-rate', handleTTSSetRate);
    eventDispatcher.on('tts-highlight-sentence', handleTTSHighlightSentence);
    eventDispatcher.on('tts-sync-request', handleTTSSyncRequest);
    return () => {
      eventDispatcher.off('tts-speak', handleTTSSpeak);
      eventDispatcher.off('tts-stop', handleTTSStop);
      eventDispatcher.off('tts-close-book', handleTTSCloseBook);
      eventDispatcher.off('tts-forward', handleTTSForward);
      eventDispatcher.off('tts-backward', handleTTSBackward);
      eventDispatcher.off('tts-toggle-play', handleTTSTogglePlay);
      eventDispatcher.off('tts-set-rate', handleTTSSetRate);
      eventDispatcher.off('tts-highlight-sentence', handleTTSHighlightSentence);
      eventDispatcher.off('tts-sync-request', handleTTSSyncRequest);
      if (ttsControllerRef.current) {
        const controller = ttsControllerRef.current;
        const bookHash = getBookHashFromKey(bookKey);
        const session = ttsSessionManager.getSessionByHash(bookHash);
        if (session?.controller === controller && !controller.terminated) {
          // Ownership transfers to the manager: the session keeps playing
          // headless (route unmount, deep-link book switch, split-view pane
          // close all funnel through this cleanup).
          ttsSessionManager.detach(bookHash);
        } else {
          controller.shutdown();
          ttsSessionManager.release(bookHash);
        }
        ttsControllerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Manager-driven stops (sleep timer, end of book, headless error, replaced
  // by another book) must reconcile this reader's UI when it is mounted.
  useEffect(() => {
    const onSessionChanged = (e: Event) => {
      const { reason } = (e as CustomEvent<{ reason: string }>).detail;
      if (reason !== 'stopped' || !ttsControllerRef.current) return;
      ttsControllerRef.current = null;
      setTtsController(null);
      setIsPlaying(false);
      setIsPaused(false);
      setShowIndicator(false);
      setShowBackToCurrentTTSLocation(false);
      setTTSEnabled(bookKey, false);
      setTimeoutOption(0);
      setTimeoutTimestamp(0);
      onRequestHidePanel?.();
    };
    ttsSessionManager.addEventListener('session-changed', onSessionChanged);
    return () => ttsSessionManager.removeEventListener('session-changed', onSessionChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKey]);

  // Opening a book whose hash doesn't match the active session stops it —
  // unless that session's book is still mounted elsewhere (split view).
  useEffect(() => {
    const active = ttsSessionManager.getActiveSession();
    if (!active) return;
    const mountedHashes = useReaderStore.getState().bookKeys.map(getBookHashFromKey);
    if (!mountedHashes.includes(active.bookHash)) {
      void ttsSessionManager.stopActive('replaced');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKey]);

  // Seamless reattach: adopt a live background session for this book (same
  // hash, fresh bookKey) once its view is ready. Audio never stops; the view
  // catches up. Adoption runs only in the primary pane for the hash.
  useEffect(() => {
    const bookHash = getBookHashFromKey(bookKey);
    const session = ttsSessionManager.getSessionByHash(bookHash);
    if (!session || session.controller.terminated) return;
    if (ttsControllerRef.current === session.controller) return;
    const primaryKey = useReaderStore
      .getState()
      .bookKeys.find((k) => getBookHashFromKey(k) === bookHash);
    if (primaryKey !== bookKey) return;

    let cancelled = false;
    const tryAdopt = async (): Promise<boolean> => {
      if (cancelled || isStartingTTSRef.current) return false;
      const view = getView(bookKey);
      if (!view) return false;
      isStartingTTSRef.current = true;
      try {
        const controller = session.controller;
        ttsControllerRef.current = controller;
        setTtsController(controller);
        // Indicator on at adoption START so it never flickers in after the
        // async attach resolves.
        setShowIndicator(true);
        setTtsClientsInitialized(true);
        setTTSEnabled(bookKey, true);
        const paused = controller.state.includes('paused');
        setIsPlaying(!paused);
        setIsPaused(paused);
        emitPlaybackState(paused ? 'paused' : 'playing');
        const timer = ttsSessionManager.getSleepTimer();
        setTimeoutOption(timer?.timeoutSec ?? 0);
        setTimeoutTimestamp(timer?.firesAt ?? 0);
        const bookData = getBookData(bookKey);
        if (bookData?.book) {
          ttsSessionManager.adopt(bookKey, {
            bookKey,
            title: bookData.book.title,
            author: bookData.book.author,
            coverImageUrl: bookData.book.coverImageUrl || null,
            metadataMode: getViewSettings(bookKey)?.ttsMediaMetadata ?? 'sentence',
            getSectionLabel: () => getProgress(bookKey)?.sectionLabel,
          });
        }
        await controller.attachView(view, {
          bookKey,
          preprocessCallback: preprocessSSMLForTTS,
          onSectionChange: handleSectionChange,
        });
        const speakingLang = controller.getSpeakingLang();
        if (speakingLang) setTtsLang(speakingLang);
      } catch (err) {
        console.warn('TTS session adoption failed:', err);
      } finally {
        isStartingTTSRef.current = false;
      }
      return true;
    };

    const interval = setInterval(() => {
      void tryAdopt().then((done) => {
        if (done) clearInterval(interval);
      });
    }, 300);
    void tryAdopt().then((done) => {
      if (done) clearInterval(interval);
    });
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKey]);

  // Controller event listeners (re-registered when ttsController changes)
  useEffect(() => {
    if (!ttsController || !bookKey) return;
    const handleNeedAuth = () => {
      eventDispatcher.dispatch('toast', {
        message: _('Please log in to use advanced TTS features'),
        type: 'error',
        timeout: 5000,
      });
    };

    const handleHighlightMark = (e: Event) => {
      const { cfi } = (e as CustomEvent<{ cfi: string }>).detail;
      const view = getView(bookKey);
      const progress = getProgress(bookKey);
      const viewSettings = getViewSettings(bookKey);
      const { location } = progress || {};
      if (!cfi || !view || !location || !viewSettings) return;

      viewSettings.ttsLocation = cfi;
      setViewSettings(bookKey, viewSettings);

      const hlContents = view.renderer.getContents();
      const hlPrimaryIdx = view.renderer.primaryIndex;
      // getContents() is empty when the mark fires mid-relocate (the section is
      // still loading, or the view was torn down). Bail instead of destructuring
      // `doc` off undefined (READEST-19).
      const hlContent = hlContents.find((x) => x.index === hlPrimaryIdx) ?? hlContents[0];
      if (!hlContent) return;
      const { doc, index: viewSectionIndex } = hlContent as {
        doc: Document;
        index?: number;
      };

      const { anchor, index: ttsSectionIndex } = view.resolveCFI(cfi);
      if (viewSectionIndex !== ttsSectionIndex) {
        // TTS crossed into a new section before the view caught up. The
        // `await onSectionChange` path in TTSController fires renderer.goTo
        // via handleSectionChange, but the new paginator's #goTo can resolve
        // before the visible page actually flips when the target section is
        // already preloaded as an adjacent view — leaving the user stuck on
        // the last page of the previous chapter while audio continues. Drive
        // navigation from the highlight cfi directly, stamping the timestamp
        // so the "back-to-TTS" button stays suppressed while progress.location
        // catches up. Skip only when the user is actively selecting text.
        if (hlContents.some(({ doc }) => (doc.getSelection()?.toString().length ?? 0) > 0)) {
          return;
        }
        sectionChangingTimestampRef.current = Date.now();
        followingTTSLocationRef.current = true;
        view.goTo?.(cfi);
        return;
      }

      if (!followingTTSLocationRef.current) return;

      if (hlContents.some(({ doc }) => (doc.getSelection()?.toString().length ?? 0) > 0)) {
        return;
      }

      const range = anchor(doc);
      // The cfi may not resolve to a range in this doc (stale/cross-realm doc,
      // detached node). A null range would crash scrollToAnchor (foliate reads
      // range.startContainer) or getBoundingClientRect below (READEST-21).
      if (!range) return;
      if (!view.renderer.scrolled) {
        view.renderer.scrollToAnchor?.(range);
      } else {
        const rect = range.getBoundingClientRect();
        const { start, end, sideProp } = view.renderer;
        const rangeTop = rect[sideProp === 'height' ? 'y' : 'x'];
        const rangeBottom = rangeTop + rect[sideProp === 'height' ? 'height' : 'width'];

        const showHeader = viewSettings.showHeader;
        const showFooter = viewSettings.showFooter;
        const headerScrollOverlap = showHeader ? viewSettings.marginTopPx : 0;
        const footerScrollOverlap = showFooter ? viewSettings.marginBottomPx : 0;
        const scrollingOverlap = viewSettings.scrollingOverlap;
        const outOfView =
          rangeBottom > end - footerScrollOverlap - scrollingOverlap ||
          rangeTop < start + headerScrollOverlap + scrollingOverlap;
        if (outOfView) {
          view.renderer.scrollToAnchor?.(range);
        }
      }
    };

    // Word-level page following: turn the page as soon as the spoken word
    // moves off the visible page, instead of waiting for the next sentence's
    // mark. Only navigates when the word is outside the visible range, so
    // on-page words don't trigger relocations.
    const handleHighlightWord = (e: Event) => {
      const { cfi } = (e as CustomEvent<{ cfi: string }>).detail;
      const view = getView(bookKey);
      if (!cfi || !view || !followingTTSLocationRef.current) return;

      const hlContents = view.renderer.getContents();
      const hlPrimaryIdx = view.renderer.primaryIndex;
      const { doc, index: viewSectionIndex } = (hlContents.find((x) => x.index === hlPrimaryIdx) ??
        hlContents[0]) as { doc: Document; index?: number };

      const { anchor, index: ttsSectionIndex } = view.resolveCFI(cfi);
      // Cross-section navigation is driven by the sentence-level mark handler.
      if (viewSectionIndex !== ttsSectionIndex) return;
      if (hlContents.some(({ doc }) => (doc.getSelection()?.toString().length ?? 0) > 0)) return;

      const wordRange = anchor(doc);
      const visibleRange = getProgress(bookKey)?.range as Range | undefined;
      if (!wordRange || !visibleRange) return;

      try {
        const ahead = wordRange.compareBoundaryPoints(Range.END_TO_START, visibleRange) > 0;
        const behind = wordRange.compareBoundaryPoints(Range.START_TO_END, visibleRange) < 0;
        if (ahead || behind) {
          view.renderer.scrollToAnchor?.(wordRange);
        }
      } catch {
        // Ranges may briefly belong to different documents during a section
        // change; the mark handler takes over in that case.
      }
    };

    // Republish the controller's canonical position signal onto the app-wide
    // bus so paragraph mode + RSVP can follow TTS without touching the
    // controller. This MUST be its own listener: handleHighlightMark /
    // handleHighlightWord early-return on following-suppression and text
    // selection, which would silently stop the modes from following. The
    // forward fires on every controller 'tts-position', gated only by the
    // listener's lifecycle (it exists only while the controller does).
    const handlePosition = (e: Event) => {
      eventDispatcher.dispatch('tts-position', {
        bookKey,
        ...(e as CustomEvent).detail,
      });
    };

    // Lock-screen play/pause acts on the controller through the media
    // bridge; the panel derives its state from the controller, not from
    // local optimistic taps. Transit 'stopped' (every paragraph advance) is
    // ignored; terminal stops arrive via explicit stop paths.
    const handleStateChange = (e: Event) => {
      const { state } = (e as CustomEvent<{ state: string }>).detail;
      if (state === 'playing') {
        setIsPlaying(true);
        setIsPaused(false);
        playbackStateRef.current = 'playing';
      } else if (state.includes('paused')) {
        setIsPlaying(false);
        setIsPaused(true);
        playbackStateRef.current = 'paused';
      }
    };

    ttsController.addEventListener('tts-need-auth', handleNeedAuth);
    ttsController.addEventListener('tts-highlight-mark', handleHighlightMark);
    ttsController.addEventListener('tts-highlight-word', handleHighlightWord);
    ttsController.addEventListener('tts-position', handlePosition);
    ttsController.addEventListener('tts-state-change', handleStateChange);
    return () => {
      ttsController.removeEventListener('tts-need-auth', handleNeedAuth);
      ttsController.removeEventListener('tts-highlight-mark', handleHighlightMark);
      ttsController.removeEventListener('tts-highlight-word', handleHighlightWord);
      ttsController.removeEventListener('tts-position', handlePosition);
      ttsController.removeEventListener('tts-state-change', handleStateChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsController, bookKey]);

  // Location tracking — re-highlight when progress changes.
  // Reactive subscription via readerProgressStore so the effect below
  // re-runs on page turns without dragging in the whole readerStore.
  const progress = useBookProgress(bookKey);
  useEffect(() => {
    const ttsController = ttsControllerRef.current;
    if (!ttsController) return;

    const viewSettings = getViewSettings(bookKey);
    const ttsLocation = viewSettings?.ttsLocation;
    const { location } = progress || {};
    if (!location || !ttsLocation) return;

    // Check the actual highlighted position against the view. During
    // word-by-word playback the word can sit on a different page than the
    // sentence's ttsLocation (a sentence spanning a page break), so the word
    // position is the correct reference — otherwise the back-to-TTS button
    // wrongly appears after the view follows the word onto the next page.
    const highlightCfi = ttsController.getCurrentHighlightCfi() ?? ttsLocation;
    if (isCfiInLocation(highlightCfi, location)) {
      setShowBackToCurrentTTSLocation(false);
      // Word-aware re-apply: re-draws the current word during word-by-word
      // playback instead of redrawing the whole sentence over it.
      ttsController.reapplyCurrentHighlight();
    } else {
      const msSinceSectionChange = Date.now() - sectionChangingTimestampRef.current;
      if (msSinceSectionChange < 2000) return;
      setShowBackToCurrentTTSLocation(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress]);

  // Location tracking — keep followingTTSLocationRef in sync with showBackToCurrentTTSLocation
  useEffect(() => {
    if (showBackToCurrentTTSLocation) {
      followingTTSLocationRef.current = false;
    } else {
      followingTTSLocationRef.current = true;
    }
  }, [showBackToCurrentTTSLocation]);

  const checkPreprocessedStatus = useCallback(async () => {
    const book = getBookData(bookKey)?.book;
    const sectionIndex = progress?.index ?? 0;
    if (!book || !appService) {
      setIsPreprocessed(false);
      return;
    }
    const preprocessedPath = `${book.hash}/ai-chapters/${sectionIndex}.txt`;
    try {
      const exists = await appService.exists(preprocessedPath, 'Books');
      // Also check old .json format for backward compat
      const oldExists =
        !exists &&
        (await appService.exists(`${book.hash}/ai-chapters/${sectionIndex}.json`, 'Books'));
      setIsPreprocessed(exists || oldExists);
    } catch {
      setIsPreprocessed(false);
    }
  }, [bookKey, progress?.index, getBookData, appService]);

  useEffect(() => {
    checkPreprocessedStatus();
  }, [checkPreprocessedStatus]);

  // Location tracking — handleBackToCurrentTTSLocation
  const handleBackToCurrentTTSLocation = () => {
    const view = getView(bookKey);
    const viewSettings = getViewSettings(bookKey);
    const ttsLocation = viewSettings?.ttsLocation;
    if (!view || !ttsLocation) return;

    const resolved = view.resolveNavigation(ttsLocation);
    view.renderer.goTo?.(resolved);
  };

  const viewSettings = getViewSettings(bookKey);
  const bookData = getBookData(bookKey);
  const ttsTime = useMemo(() => {
    const rate = viewSettings?.ttsRate ?? 1;
    return estimateTTSTime(progress, rate);
  }, [progress, viewSettings?.ttsRate]);

  const getTTSTargetLang = useCallback((): string | null => {
    const vs = getViewSettings(bookKey);
    const ttsReadAloudText = vs?.ttsReadAloudText;
    if (vs?.translationEnabled && ttsReadAloudText === 'translated') {
      return vs?.translateTargetLang || getLocale();
    } else if (vs?.translationEnabled && ttsReadAloudText === 'source') {
      return bookData?.book?.primaryLanguage || '';
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    bookKey,
    getBookData,
    getViewSettings,
    viewSettings?.translationEnabled,
    viewSettings?.ttsReadAloudText,
    viewSettings?.translateTargetLang,
  ]);

  useEffect(() => {
    ttsControllerRef.current?.setTargetLang(getTTSTargetLang() || '');
  }, [getTTSTargetLang]);

  // SSML preprocessing
  const transformCtx: TransformContext = useMemo(
    () => ({
      bookKey,
      viewSettings: getViewSettings(bookKey)!,
      userLocale: getLocale(),
      isFixedLayout: bookData?.isFixedLayout || false,
      content: '',
      transformers: [],
      reversePunctuationTransform: true,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const preprocessSSMLForTTS = useCallback(
    async (ssml: string) => {
      const rules = getMergedRules(bookKey);
      const viewSettings = getViewSettings(bookKey)!;
      const ttsOnlyRules = rules.filter(
        (rule) =>
          rule.enabled && rule.onlyForTTS && (rule.scope === 'book' || rule.scope === 'library'),
      );

      let processedSSML = ssml;
      if (ttsOnlyRules.length > 0) {
        transformCtx['content'] = ssml;
        transformCtx['viewSettings'] = viewSettings;
        processedSSML = await proofreadTransformer.transform(transformCtx, {
          docType: 'text/xml',
          onlyForTTS: true,
        });
      }

      if (viewSettings.ttsAiScriptEnabled || appService) {
        // Check for pre-processed AI chapter script or on-the-fly AI Audiobook Script
        try {
          const { parseSSMLMarks, parseSSMLLang } = await import('@/utils/ssml');
          const { marks } = parseSSMLMarks(processedSSML);
          if (marks.length > 0) {
            const controller = ttsControllerRef.current;
            const sectionIndex = controller?.ttsSectionIndex ?? -1;
            const book = getBookData(bookKey)?.book;

            // 1. If section changed, try loading a pre-saved full script.
            if (sectionIndex !== ttsAiSectionIndexRef.current) {
              ttsAiCacheRef.current.clear();
              ttsAiFullScriptRef.current = null;
              ttsAiSectionIndexRef.current = sectionIndex;

              if (book && appService) {
                const preprocessedPath = `${book.hash}/ai-chapters/${sectionIndex}.txt`;
                if (await appService.exists(preprocessedPath, 'Books')) {
                  try {
                    const content = await appService.readFile(preprocessedPath, 'Books', 'text');
                    ttsAiFullScriptRef.current = content as string;
                    console.log(
                      `[useTTSControl] Loaded full AI audiobook script for section ${sectionIndex} (${(content as string).length} chars).`,
                    );
                  } catch (e) {
                    console.error('[useTTSControl] Failed to load preprocessed AI script:', e);
                  }
                }
              }
            }

            // 2. If a full preprocessed audiobook script exists, chunk it by ~400 words
            //    so Kokoro processes each chunk fast. The ~20-40ms gap between chunks
            //    from mark-to-mark advancement is imperceptible.
            //    Split at sentence boundaries so each chunk starts clean.
            if (ttsAiFullScriptRef.current) {
              const lang = parseSSMLLang(processedSSML) || 'en';
              const fullScript = ttsAiFullScriptRef.current;
              const sentenceEnd = /(?<=[.!?])\s+/g;
              const sentences = fullScript.split(sentenceEnd).filter(Boolean);
              if (sentences.length > 0) {
                const CHUNK_WORDS = 400;
                const chunks: string[] = [];
                let current: string[] = [];
                let currentWords = 0;
                for (const s of sentences) {
                  const sw = s.split(/\s+/).filter(Boolean).length;
                  if (currentWords + sw > CHUNK_WORDS && current.length > 0) {
                    chunks.push(current.join(' '));
                    current = [s];
                    currentWords = sw;
                  } else {
                    current.push(s);
                    currentWords += sw;
                  }
                }
                if (current.length > 0) chunks.push(current.join(' '));
                let body = '';
                for (let ci = 0; ci < chunks.length; ci++) {
                  body += `<mark name="chunk-${ci}"/>${escapeNarrationForSSML(chunks[ci]!)} `;
                }
                processedSSML = `<speak xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">${body}</speak>`;
                console.log(
                  `[useTTSControl] Using full preprocessed script: ${chunks.length} chunks (~${CHUNK_WORDS} words each)`,
                );
              }
            }
          }
        } catch (err) {
          console.warn('[useTTSControl] AI script transformation failed, falling back:', err);
        }
      }

      return processedSSML;
    },
    [appService, bookKey, getMergedRules, getViewSettings, transformCtx],
  );

  // Section change callback
  const handleSectionChange = useCallback(
    async (sectionIndex: number) => {
      if (!followingTTSLocationRef.current) return;
      const view = getView(bookKey);
      const sections = view?.book.sections;
      if (!sections || sectionIndex < 0 || sectionIndex >= sections.length) return;
      sectionChangingTimestampRef.current = Date.now();
      const resolved = view.resolveNavigation(sectionIndex);
      // Await so TTSController's `await onSectionChange` doesn't proceed to
      // speak the new section before the view has finished navigating to it.
      await view.renderer.goTo?.(resolved);
    },
    [bookKey, getView],
  );

  // TTS highlight options
  const getTTSHighlightOptions = useCallback(
    (ttsHighlightOptions: TTSHighlightOptions, isEink: boolean) => {
      const einkBgColor = isDarkMode ? '#000000' : '#ffffff';
      const color = isEink ? einkBgColor : ttsHighlightOptions.color;
      return {
        ...ttsHighlightOptions,
        color,
      };
    },
    [isDarkMode],
  );

  useEffect(() => {
    const ttsHighlightOptions = viewSettings?.ttsHighlightOptions;
    if (ttsControllerRef.current && ttsHighlightOptions) {
      ttsControllerRef.current.updateHighlightOptions(
        getTTSHighlightOptions(ttsHighlightOptions, viewSettings!.isEink),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewSettings?.ttsHighlightOptions, viewSettings?.isEink, getTTSHighlightOptions]);

  useEffect(() => {
    if (ttsControllerRef.current && viewSettings?.ttsHighlightGranularity) {
      ttsControllerRef.current.setHighlightGranularity(viewSettings.ttsHighlightGranularity);
    }
  }, [viewSettings?.ttsHighlightGranularity]);

  // handleStop (defined before handleTTSSpeak/handleTTSStop which reference it)
  const handleStop = useCallback(
    async (bookKey: string) => {
      const ttsController = ttsControllerRef.current;
      // Reset all UI/session state up front — including the TTS toggle
      // (ttsEnabled) and indicator that color the TTS icon — so disabling TTS
      // always takes effect immediately. The teardown below is best-effort and
      // must never block or skip these resets if it hangs or throws, which was
      // observed with iOS system TTS (Edge TTS was unaffected). See #4676.
      ttsControllerRef.current = null;
      setTtsController(null);
      setIsPlaying(false);
      emitPlaybackState('stopped');
      onRequestHidePanel?.();
      setShowIndicator(false);
      setShowBackToCurrentTTSLocation(false);
      previousSectionLabelRef.current = undefined;
      setTTSEnabled(bookKey, false);
      getView(bookKey)?.deselect();
      releaseUnblockAudio();

      // Tear down the controller, the lock-screen media session, and the
      // background-audio session best-effort and IN PARALLEL. The controller's
      // own shutdown can stall on iOS system TTS, and it must NOT gate the media
      // session / background-audio teardown — otherwise the lock-screen Now
      // Playing keeps running after TTS is disabled (Edge TTS was unaffected
      // because it never hits the stalling native path). See #4676.
      await Promise.all([
        ttsController
          ? Promise.resolve()
              .then(() => ttsController.shutdown())
              .catch((error) => console.warn('TTS shutdown failed:', error))
          : Promise.resolve(),
        Promise.resolve()
          .then(() => ttsMediaBridge.unbind())
          .catch(() => {}),
      ]);
      ttsSessionManager.release(getBookHashFromKey(bookKey));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appService],
  );

  // handleTTSSpeak / handleTTSStop (plain functions, registered once at mount via closure)
  const handleTTSSpeak = async (event: CustomEvent) => {
    const { bookKey: ttsBookKey, range, index, oneTime = false } = event.detail;
    console.log(
      '[useTTSControl] handleTTSSpeak triggered for active book:',
      bookKey,
      'event details:',
      { ttsBookKey, oneTime, index },
    );
    if (bookKey !== ttsBookKey) {
      console.log(
        '[useTTSControl] handleTTSSpeak ignored: active bookKey',
        bookKey,
        'does not match target',
        ttsBookKey,
      );
      return;
    }
    // Guard against concurrent starts (e.g. rapid double-clicks on the TTS
    // icon). Without this, both invocations race past the `await`s below and
    // end up creating two TTSController instances that speak simultaneously.
    if (isStartingTTSRef.current) {
      console.log('[useTTSControl] handleTTSSpeak ignored: start sequence already in progress');
      return;
    }
    isStartingTTSRef.current = true;

    try {
      const view = getView(bookKey);
      const progress = getProgress(bookKey);
      const viewSettings = getViewSettings(bookKey);
      const bookData = getBookData(bookKey);
      const { location } = progress || {};
      if (!view || !progress || !viewSettings || !bookData || !bookData.book) {
        console.warn('[useTTSControl] Missing reader dependencies for TTS start:', {
          view: !!view,
          progress: !!progress,
          viewSettings: !!viewSettings,
          bookData: !!bookData,
        });
        return;
      }
      const ttsSpeakRange = range as Range | null;
      let ttsFromRange = ttsSpeakRange;
      let ttsFromIndex = typeof index === 'number' ? index : null;
      if (!ttsFromRange && viewSettings.ttsLocation) {
        const ttsCfi = viewSettings.ttsLocation;
        if (isCfiInLocation(ttsCfi, location)) {
          const { index, anchor } = view.resolveCFI(ttsCfi);
          const { doc } = view.renderer.getContents().find((x) => x.index === index) || {};
          if (doc) {
            ttsFromRange = anchor(doc);
            ttsFromIndex = index;
          }
        }
      }

      if (!ttsFromIndex) {
        ttsFromIndex = progress.index;
      }

      if (!ttsFromRange && !bookData.isFixedLayout) {
        ttsFromRange = progress.range;
      }

      const currentSection = view.renderer.getContents().find((x) => x.index === ttsFromIndex);
      if (ttsFromRange && currentSection) {
        const ttsLocation = view.getCFI(currentSection?.index || 0, ttsFromRange);
        viewSettings.ttsLocation = ttsLocation;
        setViewSettings(bookKey, viewSettings);
        if (isCfiInLocation(ttsLocation, location)) {
          setShowBackToCurrentTTSLocation(false);
        }
      }

      const primaryLang = bookData.book.primaryLanguage;

      if (ttsControllerRef.current) {
        console.log('[useTTSControl] Stopping existing ttsController session.');
        ttsControllerRef.current.stop();
        ttsControllerRef.current = null;
      }

      try {
        // Gesture-path audio unlocks, BEFORE any network/plugin await: WebKit
        // rejects AudioContext.resume() outside the user-gesture window, and
        // speak() itself only runs after preprocessing and preload fetches.
        // The silent keep-alive element runs on ALL platforms — desktop
        // Chromium only surfaces hardware media keys while an
        // HTMLMediaElement is playing, and Edge playback no longer has one.
        unblockAudio();
        void ensureSharedAudioContext();
        // No use_background_audio here: on iOS the native-tts media session
        // claims the audio session itself on activation (non-mixable
        // .playback/.spokenAudio). The old call set .mixWithOthers, which
        // disqualifies the app from Now Playing and fought the claim.
        setTtsClientsInitialized(false);

        setShowIndicator(true);
        console.log('[useTTSControl] Creating new TTSController instance.');
        const ttsController = new TTSController(
          appService,
          view,
          !!user?.id,
          preprocessSSMLForTTS,
          handleSectionChange,
        );
        ttsControllerRef.current = ttsController;
        setTtsController(ttsController);
        ttsSessionManager.claim(bookKey, ttsController, {
          bookKey,
          title: bookData.book.title,
          author: bookData.book.author,
          coverImageUrl: bookData.book.coverImageUrl || null,
          metadataMode: viewSettings.ttsMediaMetadata ?? 'sentence',
          getSectionLabel: () => getProgress(bookKey)?.sectionLabel,
        });

        console.log('[useTTSControl] Initializing ttsController...');
        await ttsController.init();

        // Match the initial voice choice from viewSettings or defaults
        const currentVoice =
          viewSettings.ttsVoice ||
          TTSUtils.getPreferredVoice(
            ttsController.ttsClient?.name ?? 'kokoro',
            primaryLang || 'en',
          ) ||
          '';
        console.log(
          '[useTTSControl] Applying initial voice choice:',
          currentVoice,
          'lang:',
          primaryLang,
        );
        await ttsController.setVoice(currentVoice, primaryLang || 'en');

        console.log('[useTTSControl] Initializing section:', ttsFromIndex);
        await ttsController.initViewTTS(ttsFromIndex);
        ttsController.updateHighlightOptions(
          getTTSHighlightOptions(viewSettings.ttsHighlightOptions, viewSettings.isEink),
        );
        ttsController.setHighlightGranularity(viewSettings.ttsHighlightGranularity ?? 'word');
        const ssml =
          oneTime && ttsSpeakRange
            ? genSSMLRaw(ttsSpeakRange.toString().trim())
            : ttsFromRange
              ? view.tts?.from(ttsFromRange)
              : view.tts?.start();
        if (ssml) {
          const lang = parseSSMLLang(ssml, primaryLang) || 'en';
          setIsPlaying(true);
          emitPlaybackState('playing');
          setTtsLang(lang);

          console.log('[useTTSControl] Calling ttsController.speak() for lang:', lang);
          ttsController.setLang(lang);
          ttsController.setRate(viewSettings.ttsRate);
          ttsController.setSentenceGap(viewSettings.ttsSentenceGap ?? DEFAULT_SENTENCE_GAP_SEC);
          ttsController.setParagraphGap(viewSettings.ttsParagraphGap ?? DEFAULT_PARAGRAPH_GAP_SEC);
          ttsController.speak(ssml, oneTime, () => handleStop(bookKey));
          ttsController.setTargetLang(getTTSTargetLang() || '');
        }
        setTtsClientsInitialized(true);
        setTTSEnabled(bookKey, true);
        console.log('[useTTSControl] TTS start sequence completed successfully.');
      } catch (error) {
        eventDispatcher.dispatch('toast', {
          message: _('TTS not supported for this document'),
          type: 'error',
        });
        console.error('[useTTSControl] TTS start sequence failed:', error);
      }
    } finally {
      isStartingTTSRef.current = false;
    }
  };

  const handleTTSStop = async (event: CustomEvent) => {
    const { bookKey: ttsBookKey } = event.detail;
    if (ttsControllerRef.current && bookKey === ttsBookKey) {
      handleStop(bookKey);
    }
  };

  // Book close (back to library): a live session goes headless instead of
  // dying. Gate on `terminated`, NOT the state value — chapter transitions
  // sit in transit 'stopped' for seconds and closing during one must detach.
  const handleTTSCloseBook = async (event: CustomEvent) => {
    const { bookKey: closingKey } = event.detail;
    if (bookKey !== closingKey) return;
    const controller = ttsControllerRef.current;
    if (!controller) return;
    if (!controller.terminated) {
      ttsSessionManager.detach(getBookHashFromKey(bookKey));
    } else {
      await handleStop(bookKey);
    }
  };

  // Sentence-snapped seek used by the lock-screen scrubber and the panel.
  const handleSeekTo = useCallback(async (seconds: number) => {
    const ttsController = ttsControllerRef.current;
    if (!ttsController) return;
    await ttsController.seekToTime(seconds);
  }, []);

  const handleGetPlaybackInfo = useCallback(() => {
    const ttsController = ttsControllerRef.current;
    if (!ttsController) return null;
    // Kick the lazy timeline build (off the playback critical path); the
    // first polls return null until it lands and the UI shows a
    // disabled/reserved row for that state.
    void ttsController.ensureTimeline();
    return ttsController.getPlaybackInfo();
  }, []);

  const handleSupportsPlaybackInfo = useCallback(() => {
    return ttsControllerRef.current?.supportsPlaybackInfo() ?? false;
  }, []);

  const handleSupportsGapControl = useCallback(() => {
    return ttsControllerRef.current?.supportsGapControl() ?? false;
  }, []);

  // Playback callbacks
  const handleTogglePlay = useCallback(async () => {
    const ttsController = ttsControllerRef.current;
    if (!ttsController) return;

    if (isPlaying) {
      setIsPlaying(false);
      setIsPaused(true);
      emitPlaybackState('paused');
      await ttsController.pause();
    } else if (isPaused) {
      setIsPlaying(true);
      setIsPaused(false);
      emitPlaybackState('playing');
      // start for forward/backward/setvoice-paused
      // set rate don't pause the tts
      if (ttsController.state === 'paused') {
        await ttsController.resume();
      } else {
        await ttsController.start();
      }
    }
  }, [isPlaying, isPaused]);

  const handleBackward = useCallback(async (byMark = false) => {
    const ttsController = ttsControllerRef.current;
    if (ttsController) {
      await ttsController.backward(byMark);
    }
  }, []);

  const handleForward = useCallback(async (byMark = false) => {
    const ttsController = ttsControllerRef.current;
    if (ttsController) {
      await ttsController.forward(byMark);
    }
  }, []);

  const handlePause = useCallback(async () => {
    const ttsController = ttsControllerRef.current;
    if (ttsController) {
      setIsPlaying(false);
      setIsPaused(true);
      emitPlaybackState('paused');
      await ttsController.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rate/voice/timeout/bar controls
  // rate range: 0.5 - 3, 1.0 is normal speed
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleSetRate = useCallback(
    throttle(async (rate: number) => {
      const ttsController = ttsControllerRef.current;
      if (ttsController) {
        if (ttsController.state === 'playing') {
          await ttsController.stop();
          await ttsController.setRate(rate);
          await ttsController.start();
        } else {
          await ttsController.setRate(rate);
        }
      }
    }, 3000),
    [],
  );

  // Inter-sentence gap: read live at schedule time by the controller, so
  // changing it must not stop/restart playback like handleSetRate does.
  const handleSetSentenceGap = useCallback((sec: number) => {
    ttsControllerRef.current?.setSentenceGap(sec);
  }, []);

  // Paragraph gap: applies to every TTS client (not Edge-only), read live by
  // the controller when auto-advancing, so no stop/restart here either.
  const handleSetParagraphGap = useCallback((sec: number) => {
    ttsControllerRef.current?.setParagraphGap(sec);
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleSetVoice = useCallback(
    throttle(async (voice: string, lang: string) => {
      const ttsController = ttsControllerRef.current;
      if (ttsController) {
        if (ttsController.state === 'playing') {
          await ttsController.stop();
          await ttsController.setVoice(voice, lang);
          await ttsController.start();
        } else {
          await ttsController.setVoice(voice, lang);
        }
      }
    }, 3000),
    [],
  );

  const handleGetVoices = async (lang: string): Promise<TTSVoicesGroup[]> => {
    const ttsController = ttsControllerRef.current;
    if (ttsController) {
      return ttsController.getVoices(lang);
    }
    return [];
  };

  const handleGetVoiceId = () => {
    const ttsController = ttsControllerRef.current;
    if (ttsController) {
      return ttsController.getVoiceId();
    }
    return '';
  };

  // The timer lives in the session manager so it survives reader unmount and
  // stops a background session (a hook-local timer would fire into a dead
  // closure and orphan the audio).
  const handleSelectTimeout = (_bookKey: string, value: number) => {
    setTimeoutOption(value);
    ttsSessionManager.setSleepTimer(value);
    setTimeoutTimestamp(value > 0 ? Date.now() + value * 1000 : 0);
  };

  const handlePreprocessChapter = async () => {
    if (isPreprocessing) return;

    const bookData = getBookData(bookKey);
    const book = bookData?.book;
    const sectionIndex = progress?.index ?? 0;
    if (!book || !bookData?.bookDoc) {
      eventDispatcher.dispatch('toast', { type: 'error', message: _('Book metadata not loaded') });
      return;
    }

    const { settings } = useSettingsStore.getState();
    const aiSettings = settings.aiSettings;
    if (!aiSettings?.enabled) {
      eventDispatcher.dispatch('toast', {
        type: 'warning',
        message: _('To preprocess, configure an AI provider in the AI Settings Panel.'),
      });
      return;
    }

    setIsPreprocessing(true);
    setPreprocessingProgress(0);

    try {
      const section = bookData.bookDoc.sections[sectionIndex];
      if (!section) {
        throw new Error('Section not found');
      }

      // 1. Load section document
      const doc = await section.createDocument();

      // 2. Extract sentences
      const { getSentences } = await import('foliate-js/tts.js');
      const { textWalker } = await import('foliate-js/text-walker.js');

      const filter = createRejectFilter({
        tags: ['rt', 'canvas', 'br'],
        classes: [
          'annotationLayer',
          'epubtype-footnote',
          'duokan-footnote-content',
          'duokan-footnote-item',
        ],
        attributeTokens: [
          {
            tag: 'aside',
            attribute: 'epub:type',
            tokens: ['footnote', 'endnote', 'note', 'rearnote'],
          },
        ],
        contents: [{ tag: 'a', content: /^[\[\(]?[\*\d]+[\)\]]?$/ }],
      });

      const sentences: string[] = [];
      for (const entry of getSentences(doc, textWalker, filter, 'sentence')) {
        const text = entry.range.toString().trim();
        if (text) {
          sentences.push(text);
        }
      }

      if (sentences.length === 0) {
        eventDispatcher.dispatch('toast', {
          type: 'info',
          message: _('No sentences found in this chapter'),
        });
        setIsPreprocessing(false);
        return;
      }

      console.log(`[useTTSControl] Full Preprocess: Found ${sentences.length} sentences.`);

      // 3. Join all sentences into a single text block and send to AI.
      setPreprocessingProgress(50);

      const fullText = sentences.join(' ');
      const wordCount = fullText.split(/\s+/).filter(Boolean).length;
      console.log(
        `[useTTSControl] Sending full chapter text (~${wordCount} words) to AI in one prompt...`,
      );

      const systemPrompt = `You are an audiobook adaptation engine that converts source prose into a narration-ready script for Kokoro-82M, a small open-weight TTS model (StyleTTS 2 + ISTFTNet, no SSML, no built-in emphasis/pause tags — prosody comes only from punctuation, line breaks, and phrasing).

CORE GOAL
Produce a professionally prepared audiobook manuscript: natural spoken flow, faithful to the source, clean enough for a small TTS model to perform without mispronunciation or awkward pacing. Not a screenplay. Not fragmented poetry.

FIDELITY RULES
- Preserve meaning, tone, atmosphere, and word choice as written.
- Do not summarize, condense, or add content, commentary, or analysis.
- Only alter text for spoken-flow reasons: splitting a run-on sentence, normalizing a number/date/abbreviation for pronunciation, adding punctuation for rhythm. Never change meaning or omit content.
- Before returning output, confirm nothing was cut or summarized.

FORMATTING RULES
1. Default to normal paragraphs. Do not put ordinary narration on separate lines.
2. Isolate a line only for: dialogue, a shouted reaction, a whispered/shocked thought, a major realization, an important name reveal, a scene-ending reveal, or a strong emotional punch. If in doubt, keep it in the paragraph.
3. Dialogue normally stands on its own line, with its tag ("he said") kept adjacent — split the tag from the line only when the silence itself is the point.
4. System/spell messages are always isolated and wrapped exactly as:
   [SYSTEM]
   message text exactly as written
   [/SYSTEM]
5. Control rhythm with commas, periods, em dashes, semicolons, ellipses — not extra line breaks.
6. Give genuine scene/mood shifts breathing room (a blank line); otherwise keep flowing.
7. Never insert stage directions like "(pause)", "(whisper)", "(shout)" — convey tone through phrasing and punctuation only, since Kokoro has no tag to act on them.

PRONUNCIATION NORMALIZATION (Kokoro-specific)
- Spell out numbers, dates, and units in words ("twenty-three", "the third of March").
- Expand ambiguous abbreviations ("Dr." → "Doctor" unless context makes the letter-form correct).
- For proper names or Sanskrit/non-English terms likely to be mispronounced, add an inline IPA hint the first time they appear, using Kokoro's supported syntax: [word](/IPA-here/). Leave it unmarked on repeat occurrences.

EXAMPLE
Source:
"Get out," she whispered, though her hands were already shaking. The building groaned, then went silent. Ashadev stepped forward.

Output:
The building groaned, then went silent.

"Get out," she whispered, though her hands were already shaking.

[Ashadev](/ɑːʃəˈdeɪv/) stepped forward.

OUTPUT FORMAT
Return only the adapted script. No notes, no headers, no bullet points, no explanation.`;

      let polishedScript = '';
      // Try the configured AI provider first; fall back to agy CLI tool if it fails.
      try {
        const { getAIProvider } = await import('@/services/ai/providers');
        const provider = getAIProvider(aiSettings);
        const model = provider.getModel();
        const { generateText } = await import('ai');
        const response = await generateText({
          model,
          system: systemPrompt,
          prompt: fullText,
          abortSignal: AbortSignal.timeout(300000),
        });
        polishedScript = response.text.trim();
      } catch (providerErr) {
        console.warn('[useTTSControl] AI provider failed, trying agy CLI:', providerErr);
        try {
          const agyRes = await fetch('/api/ai/agy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ system: systemPrompt, prompt: fullText }),
          });
          if (!agyRes.ok) throw new Error(`agy API returned ${agyRes.status}`);
          const agyData = await agyRes.json();
          polishedScript = (agyData.text ?? '').trim();
        } catch (agyErr) {
          console.error('[useTTSControl] agy fallback also failed:', agyErr);
          throw agyErr;
        }
      }

      console.log(
        `[useTTSControl] AI returned full script (${polishedScript.length} chars). First 200: ${polishedScript.slice(0, 200)}`,
      );

      // 4. Save full script to file system
      if (!appService) {
        throw new Error('App service not available');
      }
      const dirPath = `${book.hash}/ai-chapters`;
      await appService.createDir(dirPath, 'Books', true);
      const preprocessedPath = `${dirPath}/${sectionIndex}.txt`;
      await appService.writeFile(preprocessedPath, 'Books', polishedScript);

      // Clean up old .json format if present
      const oldJsonPath = `${dirPath}/${sectionIndex}.json`;
      if (await appService.exists(oldJsonPath, 'Books')) {
        await appService.deleteFile(oldJsonPath, 'Books');
      }

      // 5. Populate in-memory full script if playing this section
      const controller = ttsControllerRef.current;
      const activeSectionIndex = controller?.ttsSectionIndex ?? -1;
      if (activeSectionIndex === sectionIndex) {
        ttsAiFullScriptRef.current = polishedScript;
      }

      setIsPreprocessed(true);
      eventDispatcher.dispatch('toast', {
        type: 'success',
        message: _('Chapter pre-processed successfully!'),
      });
    } catch (err) {
      console.error('[useTTSControl] Pre-processing failed:', err);
      eventDispatcher.dispatch('toast', {
        type: 'error',
        message: _('AI pre-processing failed. Please try again.'),
      });
    } finally {
      setIsPreprocessing(false);
      setPreprocessingProgress(null);
    }
  };

  const handleDeletePreprocessed = async () => {
    const book = getBookData(bookKey)?.book;
    const sectionIndex = progress?.index ?? 0;
    if (!book || !appService) return;

    const preprocessedPath = `${book.hash}/ai-chapters/${sectionIndex}.txt`;
    try {
      const hasTxt = await appService.exists(preprocessedPath, 'Books');
      const oldJsonPath = `${book.hash}/ai-chapters/${sectionIndex}.json`;
      const hasJson = await appService.exists(oldJsonPath, 'Books');

      if (hasTxt || hasJson) {
        if (hasTxt) await appService.deleteFile(preprocessedPath, 'Books');
        if (hasJson) await appService.deleteFile(oldJsonPath, 'Books');

        // Clear in-memory cache if it is active
        const controller = ttsControllerRef.current;
        const activeSectionIndex = controller?.ttsSectionIndex ?? -1;
        if (activeSectionIndex === sectionIndex) {
          ttsAiCacheRef.current.clear();
          ttsAiFullScriptRef.current = null;
        }

        setIsPreprocessed(false);
        eventDispatcher.dispatch('toast', {
          type: 'success',
          message: _('Pre-processed script deleted'),
        });
      }
    } catch (err) {
      console.error('[useTTSControl] Failed to delete preprocessed script:', err);
      eventDispatcher.dispatch('toast', {
        type: 'error',
        message: _('Failed to delete pre-processed script'),
      });
    }
  };
  // Listen to external pre-process trigger events (e.g. from Settings panel)
  useEffect(() => {
    const onPreprocess = (e: Event) => {
      const customEvent = e as CustomEvent<{ bookKey?: string }>;
      if (customEvent.detail?.bookKey === bookKey) {
        handlePreprocessChapter();
      }
    };
    const onDelete = (e: Event) => {
      const customEvent = e as CustomEvent<{ bookKey?: string }>;
      if (customEvent.detail?.bookKey === bookKey) {
        handleDeletePreprocessed();
      }
    };
    const onRequestStatus = (e: Event) => {
      const customEvent = e as CustomEvent<{ bookKey?: string }>;
      if (customEvent.detail?.bookKey === bookKey) {
        eventDispatcher.dispatch('tts-preprocess-status', {
          bookKey,
          isPreprocessed,
          isPreprocessing,
          preprocessingProgress,
        });
      }
    };

    eventDispatcher.on('tts-preprocess-chapter', onPreprocess);
    eventDispatcher.on('tts-delete-preprocess', onDelete);
    eventDispatcher.on('tts-request-preprocess-status', onRequestStatus);

    return () => {
      eventDispatcher.off('tts-preprocess-chapter', onPreprocess);
      eventDispatcher.off('tts-delete-preprocess', onDelete);
      eventDispatcher.off('tts-request-preprocess-status', onRequestStatus);
    };
  }, [
    bookKey,
    handlePreprocessChapter,
    handleDeletePreprocessed,
    isPreprocessed,
    isPreprocessing,
    preprocessingProgress,
  ]);

  // Dispatch preprocessing status updates whenever they change
  useEffect(() => {
    eventDispatcher.dispatch('tts-preprocess-status', {
      bookKey,
      isPreprocessed,
      isPreprocessing,
      preprocessingProgress,
    });
  }, [bookKey, isPreprocessed, isPreprocessing, preprocessingProgress]);

  const refreshTtsLang = useCallback(() => {
    const speakingLang = ttsControllerRef.current?.getSpeakingLang();
    if (speakingLang) {
      setTtsLang(speakingLang);
    }
  }, []);

  return {
    isPlaying,
    isPaused,
    ttsLang,
    ttsClientsInited,
    isTTSActive: ttsController !== null,
    showIndicator,
    showBackToCurrentTTSLocation,
    timeoutOption,
    timeoutTimestamp,
    chapterRemainingSec: ttsTime.chapterRemainingSec,
    bookRemainingSec: ttsTime.bookRemainingSec,
    finishAtTimestamp: ttsTime.finishAtTimestamp,
    isPreprocessed,
    isPreprocessing,
    preprocessingProgress,
    handlePreprocessChapter,
    handleDeletePreprocessed,
    handleTogglePlay,
    handleBackward,
    handleForward,
    handlePause,
    handleSetRate,
    handleSetSentenceGap,
    handleSetParagraphGap,
    handleSetVoice,
    handleGetVoices,
    handleGetVoiceId,
    handleSelectTimeout,
    handleBackToCurrentTTSLocation,
    handleSeekTo,
    handleGetPlaybackInfo,
    handleSupportsPlaybackInfo,
    handleSupportsGapControl,
    refreshTtsLang,
  };
};
