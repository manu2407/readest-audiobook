import React, { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useResetViewSettings } from '@/hooks/useResetSettings';
import { useTranslation } from '@/hooks/useTranslation';
import { saveViewSettings } from '@/helpers/settings';
import { SettingsPanelPanelProp } from './SettingsDialog';
import { TTSHighlightGranularity, TTSMediaMetadataMode } from '@/services/tts/types';
import { BoxedList, SettingsRow, SettingsSelect } from './primitives';
import TTSHighlightStyleEditor, { TTSHighlightStyle } from './color/TTSHighlightStyleEditor';
import { TTSUtils } from '@/services/tts/TTSUtils';
import { KOKORO_VOICES } from '@/services/tts/KokoroTTSClient';
import { eventDispatcher } from '@/utils/event';
import { useBookDataStore } from '@/store/bookDataStore';

// Static engine metadata — the TTSController client `name` values.
const TTS_ENGINES = [
  { id: 'kokoro', label: 'Kokoro (Local)' },
  { id: 'edge-tts', label: 'Edge TTS' },
  { id: 'web-speech', label: 'Web Speech' },
  { id: 'native-tts', label: 'Native (Android / iOS)' },
] as const;

type EngineId = (typeof TTS_ENGINES)[number]['id'];

// Group Kokoro voices by language for the settings voice picker.
const KOKORO_LANG_LABELS: Record<string, string> = {
  en: 'English (US)',
  'en-gb': 'English (UK)',
  es: 'Spanish',
  fr: 'French',
  hi: 'Hindi',
  it: 'Italian',
  ja: 'Japanese',
  pt: 'Portuguese',
  zh: 'Chinese',
};

const TTSPanel: React.FC<SettingsPanelPanelProp> = ({ bookKey, onRegisterReset }) => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const { getViewSettings } = useReaderStore();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const viewSettings = getViewSettings(bookKey) || settings.globalViewSettings;

  // — Existing highlight / media metadata state —
  const [ttsMediaMetadata, setTtsMediaMetadata] = useState<TTSMediaMetadataMode>(
    viewSettings.ttsMediaMetadata ?? 'sentence',
  );
  const [ttsHighlightGranularity, setTtsHighlightGranularity] = useState<TTSHighlightGranularity>(
    viewSettings.ttsHighlightGranularity ?? 'word',
  );
  const [ttsHighlightStyle, setTtsHighlightStyle] = useState(
    viewSettings.ttsHighlightOptions.style,
  );
  const [ttsHighlightColor, setTtsHighlightColor] = useState(
    viewSettings.ttsHighlightOptions.color,
  );
  const [customTtsHighlightColors, setCustomTtsHighlightColors] = useState(
    settings.globalReadSettings.customTtsHighlightColors || [],
  );

  // — Engine / voice selection state —
  const [selectedEngine, setSelectedEngine] = useState<EngineId>(() => {
    return (TTSUtils.getPreferredClient() as EngineId) || 'kokoro';
  });
  const [selectedVoice, setSelectedVoice] = useState<string>(() => {
    const engine = TTSUtils.getPreferredClient() || 'kokoro';
    return TTSUtils.getPreferredVoice(engine, 'en') || 'af_heart';
  });
  const [ttsAiScriptEnabled, setTtsAiScriptEnabled] = useState<boolean>(
    viewSettings.ttsAiScriptEnabled ?? false,
  );
  const [kokoroStatus, setKokoroStatus] = useState<'checking' | 'online' | 'offline'>('checking');

  // — Kokoro health check —
  const checkKokoroHealth = useCallback(async () => {
    setKokoroStatus('checking');
    try {
      const resp = await fetch('/api/tts/kokoro', {
        method: 'OPTIONS',
        signal: AbortSignal.timeout(5000),
      });
      setKokoroStatus(resp.ok || resp.status === 204 ? 'online' : 'offline');
    } catch {
      setKokoroStatus('offline');
    }
  }, []);

  useEffect(() => {
    checkKokoroHealth();
  }, [checkKokoroHealth]);

  // — Reset handler —
  const resetToDefaults = useResetViewSettings();

  const handleReset = () => {
    resetToDefaults({
      ttsMediaMetadata: setTtsMediaMetadata as React.Dispatch<React.SetStateAction<string>>,
      ttsHighlightGranularity: setTtsHighlightGranularity as React.Dispatch<
        React.SetStateAction<string>
      >,
    });
  };

  useEffect(() => {
    onRegisterReset(handleReset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // — Persist highlight / media metadata —
  useEffect(() => {
    if (ttsMediaMetadata === viewSettings.ttsMediaMetadata) return;
    saveViewSettings(envConfig, bookKey, 'ttsMediaMetadata', ttsMediaMetadata, false, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsMediaMetadata]);

  useEffect(() => {
    if (ttsHighlightGranularity === viewSettings.ttsHighlightGranularity) return;
    saveViewSettings(
      envConfig,
      bookKey,
      'ttsHighlightGranularity',
      ttsHighlightGranularity,
      false,
      false,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsHighlightGranularity]);

  useEffect(() => {
    if (ttsAiScriptEnabled === viewSettings.ttsAiScriptEnabled) return;
    saveViewSettings(envConfig, bookKey, 'ttsAiScriptEnabled', ttsAiScriptEnabled, false, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsAiScriptEnabled]);

  const isAiConfigured = !!settings.aiSettings?.enabled;

  // — Preprocessing state & event integration —
  const [isPreprocessed, setIsPreprocessed] = useState(false);
  const [isPreprocessing, setIsPreprocessing] = useState(false);
  const [preprocessingProgress, setPreprocessingProgress] = useState<number | null>(null);

  const checkPreprocessed = useCallback(async () => {
    if (!bookKey) return;
    const book = useBookDataStore.getState().getBookData(bookKey)?.book;
    if (!book) return;

    const { getBookProgress } = await import('@/store/readerProgressStore');
    const progress = getBookProgress(bookKey);
    const sectionIndex = progress?.index ?? 0;

    const preprocessedPath = `${book.hash}/ai-chapters/${sectionIndex}.json`;
    const appService = await envConfig.getAppService();
    if (appService) {
      const exists = await appService.exists(preprocessedPath, 'Books');
      setIsPreprocessed(exists);
    }
  }, [bookKey, envConfig]);

  useEffect(() => {
    eventDispatcher.dispatch('tts-request-preprocess-status', { bookKey });
    checkPreprocessed();

    const onStatus = (e: Event) => {
      const customEvent = e as CustomEvent<{
        bookKey?: string;
        isPreprocessed: boolean;
        isPreprocessing: boolean;
        preprocessingProgress: number | null;
      }>;
      if (customEvent.detail?.bookKey === bookKey) {
        setIsPreprocessed(customEvent.detail.isPreprocessed);
        setIsPreprocessing(customEvent.detail.isPreprocessing);
        setPreprocessingProgress(customEvent.detail.preprocessingProgress);
      }
    };

    eventDispatcher.on('tts-preprocess-status', onStatus);

    return () => {
      eventDispatcher.off('tts-preprocess-status', onStatus);
    };
  }, [bookKey, checkPreprocessed]);

  const handlePreprocess = () => {
    eventDispatcher.dispatch('tts-preprocess-chapter', { bookKey });
  };

  const handleDeletePreprocessed = () => {
    eventDispatcher.dispatch('tts-delete-preprocess', { bookKey });
  };
  // — Handlers: highlight style/color —
  const handleTTSStyleChange = (style: TTSHighlightStyle) => {
    setTtsHighlightStyle(style);
    saveViewSettings(envConfig, bookKey, 'ttsHighlightOptions', {
      style,
      color: ttsHighlightColor,
    });
  };

  const handleTTSColorChange = (color: string) => {
    setTtsHighlightColor(color);
    saveViewSettings(envConfig, bookKey, 'ttsHighlightOptions', {
      style: ttsHighlightStyle,
      color,
    });
  };

  const handleCustomTtsColorsChange = (colors: string[]) => {
    setCustomTtsHighlightColors(colors);
    settings.globalReadSettings.customTtsHighlightColors = colors;
    setSettings(settings);
    saveSettings(envConfig, settings);
  };

  const handleMediaMetadataChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setTtsMediaMetadata(event.target.value as TTSMediaMetadataMode);
  };

  const handleTTSGranularityChange = (granularity: TTSHighlightGranularity) => {
    setTtsHighlightGranularity(granularity);
  };

  // — Handlers: engine / voice —
  const handleEngineChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const engine = event.target.value as EngineId;
    setSelectedEngine(engine);
    TTSUtils.setPreferredClient(engine);

    // Restore the last-used voice for this engine (if any).
    const savedVoice = TTSUtils.getPreferredVoice(engine, 'en');
    if (savedVoice) {
      setSelectedVoice(savedVoice);
    }
  };

  const handleVoiceSelect = (voiceId: string, lang: string) => {
    setSelectedVoice(voiceId);
    TTSUtils.setPreferredClient(selectedEngine);
    TTSUtils.setPreferredVoice(selectedEngine, lang, voiceId);
  };

  // — Build Kokoro voice groups by language —
  const kokoroVoicesByLang = KOKORO_VOICES.reduce(
    (acc, v) => {
      const key = v.lang;
      if (!acc[key]) acc[key] = [];
      acc[key]!.push(v);
      return acc;
    },
    {} as Record<string, typeof KOKORO_VOICES>,
  );

  return (
    <div className='my-4 w-full space-y-6'>
      {/* ─── TTS Engine ─── */}
      <BoxedList title={_('TTS Engine')} data-setting-id='settings.tts.engine'>
        <SettingsRow label={_('Engine')}>
          <SettingsSelect
            value={selectedEngine}
            onChange={handleEngineChange}
            ariaLabel={_('TTS Engine')}
            options={TTS_ENGINES.map((e) => ({ value: e.id, label: e.label }))}
          />
        </SettingsRow>

        {selectedEngine === 'kokoro' && (
          <SettingsRow
            label={_('Kokoro Server')}
            description={
              kokoroStatus === 'checking'
                ? _('Checking...')
                : kokoroStatus === 'online'
                  ? _('localhost:17600')
                  : _('Not running — start the Kokoro server')
            }
          >
            <div className='flex items-center gap-2'>
              <span
                className={clsx(
                  'inline-block h-2.5 w-2.5 rounded-full',
                  kokoroStatus === 'online' && 'bg-emerald-500',
                  kokoroStatus === 'offline' && 'bg-red-400',
                  kokoroStatus === 'checking' && 'bg-amber-400 animate-pulse',
                )}
              />
              <span className='text-base-content/70 text-sm'>
                {kokoroStatus === 'online'
                  ? _('Connected')
                  : kokoroStatus === 'offline'
                    ? _('Offline')
                    : _('Checking')}
              </span>
              {kokoroStatus === 'offline' && (
                <button
                  type='button'
                  onClick={checkKokoroHealth}
                  className='btn btn-ghost btn-xs'
                  aria-label={_('Retry')}
                >
                  {_('Retry')}
                </button>
              )}
            </div>
          </SettingsRow>
        )}
      </BoxedList>

      {/* ─── Voice Picker (Kokoro only — others need a live controller) ─── */}
      {selectedEngine === 'kokoro' && (
        <BoxedList
          title={_('Kokoro Voice')}
          description={
            kokoroStatus === 'offline'
              ? _('Start the Kokoro model server on localhost:17600 to use these voices.')
              : undefined
          }
          data-setting-id='settings.tts.kokoroVoice'
        >
          {Object.entries(kokoroVoicesByLang).map(([lang, voices]) => (
            <div key={lang}>
              <div className='text-base-content/60 px-0 pb-0.5 pt-2.5 text-xs font-semibold uppercase tracking-wide'>
                {KOKORO_LANG_LABELS[lang] ?? lang}
              </div>
              {voices.map((voice) => (
                <button
                  key={voice.id}
                  type='button'
                  onClick={() => handleVoiceSelect(voice.id, voice.lang)}
                  className={clsx(
                    'flex w-full items-center gap-2.5 rounded-lg px-0 py-2 text-start transition-colors',
                    'hover:bg-base-200/60',
                    selectedVoice === voice.id && 'bg-base-200/40',
                  )}
                >
                  <span className='flex h-5 w-5 flex-shrink-0 items-center justify-center'>
                    {selectedVoice === voice.id && (
                      <span className='text-primary text-sm font-bold'>✓</span>
                    )}
                  </span>
                  <span className='text-sm'>
                    {voice.name}
                    <span className='text-base-content/50 ml-1.5 text-xs'>
                      {voice.gender === 'female' ? '♀' : '♂'}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </BoxedList>
      )}

      {selectedEngine !== 'kokoro' && (
        <BoxedList
          title={_('Voice')}
          description={_(
            'Open a book and tap the TTS play button to pick a voice for this engine.',
          )}
          data-setting-id='settings.tts.voiceHint'
        >
          <SettingsRow
            label={_('Voice Selection')}
            description={_("Available from the reader's TTS player sheet")}
          >
            <span className='text-base-content/50 text-sm'>{_('In Reader')}</span>
          </SettingsRow>
        </BoxedList>
      )}

      {/* ─── Highlight Style (existing) ─── */}
      <TTSHighlightStyleEditor
        granularity={ttsHighlightGranularity}
        style={ttsHighlightStyle}
        color={ttsHighlightColor}
        customColors={customTtsHighlightColors}
        onGranularityChange={handleTTSGranularityChange}
        onStyleChange={handleTTSStyleChange}
        onColorChange={handleTTSColorChange}
        onCustomColorsChange={handleCustomTtsColorsChange}
        data-setting-id='settings.tts.ttsHighlightStyle'
      />

      {/* ─── AI Scripting ─── */}
      <BoxedList title={_('AI Scripting')} data-setting-id='settings.tts.aiScript'>
        <SettingsRow
          label={_('AI Audiobook Script')}
          description={
            isAiConfigured
              ? _(
                  'Polishes character names, pronunciations, and phrasing using your selected AI provider before speech synthesis.',
                )
              : _('To enable, configure an AI provider in the AI Settings Panel.')
          }
        >
          <input
            type='checkbox'
            className='toggle'
            checked={ttsAiScriptEnabled}
            onChange={(e) => setTtsAiScriptEnabled(e.target.checked)}
            disabled={!isAiConfigured}
            aria-label={_('Enable AI Audiobook Script')}
          />
        </SettingsRow>

        {ttsAiScriptEnabled && isAiConfigured && (
          <SettingsRow
            label={_('Pre-process Current Chapter')}
            description={
              isPreprocessing
                ? `${_('Processing chapter...')} (${preprocessingProgress ?? 0}%)`
                : isPreprocessed
                  ? _('Offline narrator script is cached and ready.')
                  : _(
                      'Pre-process this chapter in one go to enable offline playback and smooth out pronunciations.',
                    )
            }
          >
            {isPreprocessing ? (
              <div className='flex w-32 flex-col gap-1.5'>
                <div className='h-1.5 w-full overflow-hidden rounded-full bg-base-300'>
                  <div
                    className='h-full bg-primary transition-all duration-300'
                    style={{ width: `${preprocessingProgress ?? 0}%` }}
                  />
                </div>
              </div>
            ) : isPreprocessed ? (
              <button
                type='button'
                onClick={handleDeletePreprocessed}
                className='btn btn-error btn-outline btn-sm'
              >
                {_('Delete Offline Script')}
              </button>
            ) : (
              <button type='button' onClick={handlePreprocess} className='btn btn-primary btn-sm'>
                {_('Pre-process')}
              </button>
            )}
          </SettingsRow>
        )}
      </BoxedList>

      {/* ─── Media Info (existing) ─── */}
      <BoxedList title={_('Media Info')} data-setting-id='settings.tts.mediaMetadata'>
        <SettingsRow label={_('Update Frequency')}>
          <SettingsSelect
            value={ttsMediaMetadata}
            onChange={handleMediaMetadataChange}
            ariaLabel={_('Update Frequency')}
            options={[
              { value: 'sentence', label: _('Every Sentence') },
              { value: 'paragraph', label: _('Every Paragraph') },
              { value: 'chapter', label: _('Every Chapter') },
            ]}
          />
        </SettingsRow>
      </BoxedList>
    </div>
  );
};

export default TTSPanel;
