import { TTSGranularity, TTSMark, TTSVoice, TTSVoicesGroup } from './types';
import { TTSClient, TTSMessageEvent } from './TTSClient';
import { parseSSMLMarks } from '@/utils/ssml';
import { TTSUtils } from './TTSUtils';
import { WebAudioPlayer, TTSAudioBuffer, WebAudioPlayerEvent } from './WebAudioPlayer';

export const KOKORO_VOICES: { id: string; name: string; gender: string; lang: string }[] = [
  { id: 'af_alloy', name: 'Alloy', gender: 'female', lang: 'en' },
  { id: 'af_aoede', name: 'Aoede', gender: 'female', lang: 'en' },
  { id: 'af_bella', name: 'Bella', gender: 'female', lang: 'en' },
  { id: 'af_heart', name: 'Heart', gender: 'female', lang: 'en' },
  { id: 'af_jessica', name: 'Jessica', gender: 'female', lang: 'en' },
  { id: 'af_kore', name: 'Kore', gender: 'female', lang: 'en' },
  { id: 'af_nicole', name: 'Nicole', gender: 'female', lang: 'en' },
  { id: 'af_nova', name: 'Nova', gender: 'female', lang: 'en' },
  { id: 'af_river', name: 'River', gender: 'female', lang: 'en' },
  { id: 'af_sarah', name: 'Sarah', gender: 'female', lang: 'en' },
  { id: 'af_sky', name: 'Sky', gender: 'female', lang: 'en' },
  { id: 'am_adam', name: 'Adam', gender: 'male', lang: 'en' },
  { id: 'am_echo', name: 'Echo', gender: 'male', lang: 'en' },
  { id: 'am_eric', name: 'Eric', gender: 'male', lang: 'en' },
  { id: 'am_fenrir', name: 'Fenrir', gender: 'male', lang: 'en' },
  { id: 'am_liam', name: 'Liam', gender: 'male', lang: 'en' },
  { id: 'am_michael', name: 'Michael', gender: 'male', lang: 'en' },
  { id: 'am_onyx', name: 'Onyx', gender: 'male', lang: 'en' },
  { id: 'am_puck', name: 'Puck', gender: 'male', lang: 'en' },
  { id: 'am_santa', name: 'Santa', gender: 'male', lang: 'en' },
  { id: 'bf_alice', name: 'Alice', gender: 'female', lang: 'en-gb' },
  { id: 'bf_emma', name: 'Emma', gender: 'female', lang: 'en-gb' },
  { id: 'bf_isabella', name: 'Isabella', gender: 'female', lang: 'en-gb' },
  { id: 'bf_lily', name: 'Lily', gender: 'female', lang: 'en-gb' },
  { id: 'bm_daniel', name: 'Daniel', gender: 'male', lang: 'en-gb' },
  { id: 'bm_fable', name: 'Fable', gender: 'male', lang: 'en-gb' },
  { id: 'bm_george', name: 'George', gender: 'male', lang: 'en-gb' },
  { id: 'bm_lewis', name: 'Lewis', gender: 'male', lang: 'en-gb' },
  { id: 'ef_dora', name: 'Dora', gender: 'female', lang: 'es' },
  { id: 'em_alex', name: 'Alex', gender: 'male', lang: 'es' },
  { id: 'em_santa', name: 'Santa', gender: 'male', lang: 'es' },
  { id: 'ff_siwis', name: 'Siwis', gender: 'female', lang: 'fr' },
  { id: 'hf_alpha', name: 'Alpha', gender: 'female', lang: 'hi' },
  { id: 'hf_beta', name: 'Beta', gender: 'female', lang: 'hi' },
  { id: 'hm_omega', name: 'Omega', gender: 'male', lang: 'hi' },
  { id: 'hm_psi', name: 'Psi', gender: 'male', lang: 'hi' },
  { id: 'if_sara', name: 'Sara', gender: 'female', lang: 'it' },
  { id: 'im_nicola', name: 'Nicola', gender: 'male', lang: 'it' },
  { id: 'jf_alpha', name: 'Alpha', gender: 'female', lang: 'ja' },
  { id: 'jf_gongitsune', name: 'Gongitsune', gender: 'female', lang: 'ja' },
  { id: 'jf_nezumi', name: 'Nezumi', gender: 'female', lang: 'ja' },
  { id: 'jf_tebukuro', name: 'Tebukuro', gender: 'female', lang: 'ja' },
  { id: 'jm_kumo', name: 'Kumo', gender: 'male', lang: 'ja' },
  { id: 'pf_dora', name: 'Dora', gender: 'female', lang: 'pt' },
  { id: 'pm_alex', name: 'Alex', gender: 'male', lang: 'pt' },
  { id: 'pm_santa', name: 'Santa', gender: 'male', lang: 'pt' },
  { id: 'zf_xiaobei', name: 'Xiaobei', gender: 'female', lang: 'zh' },
  { id: 'zf_xiaoni', name: 'Xiaoni', gender: 'female', lang: 'zh' },
  { id: 'zf_xiaoxiao', name: 'Xiaoxiao', gender: 'female', lang: 'zh' },
  { id: 'zf_xiaoyi', name: 'Xiaoyi', gender: 'female', lang: 'zh' },
];

const INTER_CHUNK_GAP_SEC = 0.12;

type SpeakQueueEvent =
  | { kind: 'chunk-start'; index: number }
  | { kind: 'chunk-skip'; markName: string }
  | { kind: 'session-end' }
  | { kind: 'error'; message: string };

interface TTSControllerBridge {
  dispatchSpeakMark(mark: TTSMark): void;
}

class AsyncQueue<T> {
  #items: T[] = [];
  #resolvers: Array<(item: T) => void> = [];

  push(item: T): void {
    const resolve = this.#resolvers.shift();
    if (resolve) resolve(item);
    else this.#items.push(item);
  }

  next(): Promise<T> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => this.#resolvers.push(resolve));
  }
}

export class KokoroTTSClient implements TTSClient {
  name = 'kokoro';
  initialized = false;
  controller?: TTSControllerBridge;

  #voices: TTSVoice[] = [];
  #primaryLang = 'en';
  #speakingLang = '';
  #currentVoiceId = 'af_heart';
  #rate = 1.0;
  #endpoint = '';

  #player = new WebAudioPlayer();
  #activeGeneration: number | null = null;
  #activeQueue: AsyncQueue<SpeakQueueEvent> | null = null;
  // #chunkMeta: { mark: TTSMark }[] = [];

  constructor(controller?: TTSControllerBridge) {
    this.controller = controller;
    this.#endpoint = process.env.NEXT_PUBLIC_KOKORO_TTS_ENDPOINT || '/api/tts/kokoro';
    this.#voices = KOKORO_VOICES.map((v) => ({
      id: v.id,
      name: v.name,
      lang: v.lang,
    }));
  }

  async init(): Promise<boolean> {
    try {
      const resp = await fetch(this.#endpoint, {
        method: 'OPTIONS',
        signal: AbortSignal.timeout(8000),
      });
      if (resp.ok || resp.status === 204) {
        this.initialized = true;
        return true;
      }
    } catch {
      // endpoint not available
    }
    this.initialized = false;
    return false;
  }

  async shutdown(): Promise<void> {
    await this.stop();
    await this.#player.shutdown();
    this.initialized = false;
  }

  async *speak(ssml: string, signal: AbortSignal, preload = false): AsyncIterable<TTSMessageEvent> {
    console.log(
      '[KokoroTTSClient] speak() called. Preload:',
      preload,
      'Voice:',
      this.#currentVoiceId,
    );
    const { marks } = parseSSMLMarks(ssml, this.#primaryLang);
    if (marks.length === 0) {
      console.log('[KokoroTTSClient] No marks found in SSML.');
      yield { code: 'end', message: 'No marks to speak' };
      return;
    }

    if (preload) {
      console.log(
        '[KokoroTTSClient] Preloading marks:',
        marks.slice(0, 2).map((m) => m.name),
      );
      yield* this.#preload(marks, signal);
      return;
    }

    console.log('[KokoroTTSClient] Stopping current play session if active.');
    await this.stop();

    const queue = new AsyncQueue<SpeakQueueEvent>();
    const chunkMeta: { mark: TTSMark }[] = [];
    this.#activeQueue = queue;
    // this.#chunkMeta = chunkMeta;

    console.log('[KokoroTTSClient] Creating new WebAudioPlayer session.');
    const generation = this.#player.startSession((event: WebAudioPlayerEvent) => {
      if (event.type === 'chunk-start') {
        queue.push({ kind: 'chunk-start', index: event.chunkIndex! });
      } else if (event.type === 'session-end') {
        queue.push({ kind: 'session-end' });
      } else {
        queue.push({ kind: 'error', message: event.message || 'unknown error' });
      }
    });
    this.#activeGeneration = generation;
    await this.#player.ensureContext();

    this.#runScheduler(marks, signal, generation, queue, chunkMeta);

    let abortHandler: (() => void) | null = null;
    try {
      if (signal.aborted) {
        yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
        return;
      }
      abortHandler = () => queue.push({ kind: 'error', message: 'Aborted' });
      signal.addEventListener('abort', abortHandler);

      for (;;) {
        const event = await queue.next();
        if (event.kind === 'chunk-start') {
          const meta = chunkMeta[event.index];
          if (!meta) continue;
          console.log('[KokoroTTSClient] chunk-start event received. Mark:', meta.mark.name);
          this.controller?.dispatchSpeakMark(meta.mark);
          yield {
            code: 'boundary',
            message: `Start chunk: ${meta.mark.name}`,
            mark: meta.mark.name,
          } as TTSMessageEvent;
        } else if (event.kind === 'chunk-skip') {
          yield {
            code: 'end',
            message: `Chunk skipped: ${event.markName}`,
          } as TTSMessageEvent;
        } else if (event.kind === 'session-end') {
          console.log('[KokoroTTSClient] session-end event received.');
          yield { code: 'end', message: 'Speak finished' } as TTSMessageEvent;
          return;
        } else {
          console.warn('[KokoroTTSClient] error event received in queue:', event.message);
          yield { code: 'error', message: event.message } as TTSMessageEvent;
          return;
        }
      }
    } finally {
      if (abortHandler) signal.removeEventListener('abort', abortHandler);
      if (this.#activeGeneration === generation) {
        this.#activeGeneration = null;
        this.#activeQueue = null;
        this.#player.abortSession();
      }
    }
  }

  async #runScheduler(
    marks: TTSMark[],
    signal: AbortSignal,
    generation: number,
    queue: AsyncQueue<SpeakQueueEvent>,
    chunkMeta: { mark: TTSMark }[],
  ): Promise<void> {
    try {
      for (const mark of marks) {
        if (signal.aborted || this.#activeGeneration !== generation) return;

        let audioBuffer: ArrayBuffer | null = null;
        try {
          console.log('[KokoroTTSClient] Synthesizing mark:', mark.name, 'Text:', mark.text);
          audioBuffer = await this.#synthesizeChunk(mark, signal);
        } catch (err) {
          console.warn('[KokoroTTSClient] Synthesis failed for mark:', mark.name, err);
          queue.push({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
          return;
        }

        if (!audioBuffer || signal.aborted || this.#activeGeneration !== generation) return;

        let decoded: TTSAudioBuffer;
        try {
          console.log(
            '[KokoroTTSClient] Decoding WAV buffer for mark:',
            mark.name,
            'Size:',
            audioBuffer.byteLength,
          );
          decoded = await this.#player.decode(audioBuffer);
        } catch (err) {
          console.warn('[KokoroTTSClient] Decode failed, skipping chunk for mark:', mark.name, err);
          continue;
        }

        const ready = await this.#player.waitUntilReady(generation);
        if (!ready || signal.aborted || this.#activeGeneration !== generation) return;

        this.#speakingLang = mark.language;
        console.log(
          '[KokoroTTSClient] Scheduling chunk play for mark:',
          mark.name,
          'Duration:',
          decoded.duration,
        );
        chunkMeta.push({ mark });
        this.#player.scheduleChunk(generation, decoded, {
          trimStartSec: 0,
          mediaScale: 1,
          gapSec: INTER_CHUNK_GAP_SEC / this.#rate,
        });
      }

      if (!signal.aborted && this.#activeGeneration === generation) {
        console.log('[KokoroTTSClient] Scheduler finished. Ending player session.');
        this.#player.endSession(generation);
      }
    } catch (error) {
      console.error('[KokoroTTSClient] Scheduler crash:', error);
      const message = error instanceof Error ? error.message : String(error);
      queue.push({ kind: 'error', message });
    }
  }

  async *#preload(marks: TTSMark[], signal: AbortSignal): AsyncIterable<TTSMessageEvent> {
    const count = Math.min(2, marks.length);
    for (let i = 0; i < count; i++) {
      if (signal.aborted) break;
      try {
        console.log('[KokoroTTSClient] Preload synthesis for mark:', marks[i]!.name);
        await this.#synthesizeChunk(marks[i]!, signal);
      } catch (err) {
        console.warn('[KokoroTTSClient] Preload synthesis failed:', err);
      }
    }
    yield { code: 'end', message: 'Preload finished' };
  }

  async #synthesizeChunk(mark: TTSMark, signal: AbortSignal): Promise<ArrayBuffer | null> {
    const payload = {
      model: 'kokoro',
      input: mark.text,
      voice: this.#currentVoiceId,
      response_format: 'wav',
    };
    console.log('[KokoroTTSClient] Sending POST request to:', this.#endpoint, 'Payload:', payload);
    const start = Date.now();
    const resp = await fetch(this.#endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    const elapsed = Date.now() - start;
    console.log('[KokoroTTSClient] POST response received in', elapsed, 'ms. Status:', resp.status);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.warn('[KokoroTTSClient] POST response not OK:', resp.status, errText);
      return null;
    }
    const buf = await resp.arrayBuffer();
    console.log('[KokoroTTSClient] Audio buffer fetched. Length:', buf.byteLength, 'bytes');
    return buf;
  }

  async pause(): Promise<boolean> {
    await this.#player.pauseContext();
    return true;
  }

  async resume(): Promise<boolean> {
    await this.#player.resumeContext();
    return true;
  }

  async stop(): Promise<void> {
    if (this.#activeGeneration !== null) {
      this.#activeQueue?.push({ kind: 'session-end' });
      this.#activeGeneration = null;
      this.#activeQueue = null;
      this.#player.abortSession();
    }
  }

  setPrimaryLang(lang: string): void {
    this.#primaryLang = lang;
  }

  async setRate(rate: number): Promise<void> {
    this.#rate = rate;
  }

  async setPitch(_pitch: number): Promise<void> {
    // pitch control not supported by Kokoro TTS endpoint
  }

  async setVoice(voice: string): Promise<void> {
    const found = this.#voices.find((v) => v.id === voice);
    if (found) this.#currentVoiceId = found.id;
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    return this.#voices.map((v) => ({ ...v }));
  }

  async getVoices(lang: string): Promise<TTSVoicesGroup[]> {
    const normalized = lang.toLowerCase().split('-')[0]!;
    const matching = this.#voices.filter((v) => {
      const vLang = v.lang.toLowerCase().split('-')[0]!;
      return vLang === normalized;
    });
    const sorted = matching.sort(TTSUtils.sortVoicesPreferLocaleFunc(lang));
    return [
      {
        id: 'kokoro',
        name: 'Kokoro',
        voices: sorted,
        disabled: !this.initialized,
      },
    ];
  }

  getGranularities(): TTSGranularity[] {
    return ['sentence'];
  }

  supportsWordBoundaries(): boolean {
    return false;
  }

  getVoiceId(): string {
    return this.#currentVoiceId;
  }

  getSpeakingLang(): string {
    return this.#speakingLang;
  }
}
