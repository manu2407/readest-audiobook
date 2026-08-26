import { TTSGranularity, TTSMark, TTSVoice, TTSVoicesGroup } from './types';
import { TTSClient, TTSMessageEvent } from './TTSClient';
import { parseSSMLMarks } from '@/utils/ssml';
import { TTSUtils } from './TTSUtils';
import { WebAudioPlayer, TTSAudioBuffer, WebAudioPlayerEvent } from './WebAudioPlayer';

export const VIBEVOICE_MODEL = 'cstr/vibevoice-realtime-0.5b-GGUF';

export const VIBEVOICE_QUANTIZATIONS = [
  { id: 'q4_k', name: 'Q4_K (Recommended, 4-bit, ~607 MB)', size: '607 MB' },
  { id: 'q8_0', name: 'Q8_0 (Near Lossless, 8-bit, ~1.1 GB)', size: '1.1 GB' },
  { id: 'f16', name: 'F16 (Full Precision, 16-bit, ~2.0 GB)', size: '2.0 GB' },
] as const;

export type VibeVoiceQuantizationId = (typeof VIBEVOICE_QUANTIZATIONS)[number]['id'];

export const VIBEVOICE_VOICES: { id: string; name: string; gender: string; lang: string }[] = [
  { id: 'vv_emma', name: 'Emma (Warm)', gender: 'female', lang: 'en' },
  { id: 'vv_carter', name: 'Carter (Narrator)', gender: 'male', lang: 'en' },
  { id: 'vv_davis', name: 'Davis (Conversational)', gender: 'male', lang: 'en' },
  { id: 'vv_frank', name: 'Frank (Deep)', gender: 'male', lang: 'en' },
  { id: 'vv_grace', name: 'Grace (Clear)', gender: 'female', lang: 'en' },
  { id: 'vv_henry', name: 'Henry (Calm)', gender: 'male', lang: 'en' },
  { id: 'vv_isabella', name: 'Isabella (Expressive)', gender: 'female', lang: 'en' },
  { id: 'vv_jack', name: 'Jack (Energetic)', gender: 'male', lang: 'en' },
  { id: 'vv_katherine', name: 'Katherine (Soft)', gender: 'female', lang: 'en' },
  { id: 'vv_liam', name: 'Liam (Friendly)', gender: 'male', lang: 'en' },
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

export class VibeVoiceTTSClient implements TTSClient {
  name = 'vibevoice';
  initialized = false;
  controller?: TTSControllerBridge;

  #voices: TTSVoice[] = [];
  #primaryLang = 'en';
  #speakingLang = '';
  #currentVoiceId = 'vv_emma';
  #quantization: VibeVoiceQuantizationId = 'q4_k';
  #rate = 1.0;
  #endpoint = '';

  #player = new WebAudioPlayer();
  #activeGeneration: number | null = null;
  #activeQueue: AsyncQueue<SpeakQueueEvent> | null = null;

  constructor(controller?: TTSControllerBridge) {
    this.controller = controller;
    this.#endpoint = process.env['NEXT_PUBLIC_VIBEVOICE_TTS_ENDPOINT'] || '/api/tts/vibevoice';
    this.#voices = VIBEVOICE_VOICES.map((v) => ({
      id: v.id,
      name: v.name,
      lang: v.lang,
    }));
    this.#loadQuantization();
  }

  #loadQuantization(): void {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('vibevoiceQuantization') as VibeVoiceQuantizationId;
      if (saved && VIBEVOICE_QUANTIZATIONS.some((q) => q.id === saved)) {
        this.#quantization = saved;
      }
    }
  }

  getQuantization(): VibeVoiceQuantizationId {
    return this.#quantization;
  }

  setQuantization(quantization: VibeVoiceQuantizationId): void {
    this.#quantization = quantization;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('vibevoiceQuantization', quantization);
    }
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
      '[VibeVoiceTTSClient] speak() called. Preload:',
      preload,
      'Voice:',
      this.#currentVoiceId,
      'Quantization:',
      this.#quantization,
    );
    const { marks } = parseSSMLMarks(ssml, this.#primaryLang);
    if (marks.length === 0) {
      console.log('[VibeVoiceTTSClient] No marks found in SSML.');
      yield { code: 'end', message: 'No marks to speak' };
      return;
    }

    if (preload) {
      console.log(
        '[VibeVoiceTTSClient] Preloading marks:',
        marks.slice(0, 2).map((m) => m.name),
      );
      yield* this.#preload(marks, signal);
      return;
    }

    console.log('[VibeVoiceTTSClient] Stopping current play session if active.');
    await this.stop();

    const queue = new AsyncQueue<SpeakQueueEvent>();
    const chunkMeta: { mark: TTSMark }[] = [];
    this.#activeQueue = queue;

    console.log('[VibeVoiceTTSClient] Creating new WebAudioPlayer session.');
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
          console.log('[VibeVoiceTTSClient] chunk-start event received. Mark:', meta.mark.name);
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
          console.log('[VibeVoiceTTSClient] session-end event received.');
          yield { code: 'end', message: 'Speak finished' } as TTSMessageEvent;
          return;
        } else {
          console.warn('[VibeVoiceTTSClient] error event received in queue:', event.message);
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
          console.log('[VibeVoiceTTSClient] Synthesizing mark:', mark.name, 'Text:', mark.text);
          audioBuffer = await this.#synthesizeChunk(mark, signal);
        } catch (err) {
          console.warn('[VibeVoiceTTSClient] Synthesis failed for mark:', mark.name, err);
          queue.push({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
          return;
        }

        if (!audioBuffer || signal.aborted || this.#activeGeneration !== generation) return;

        let decoded: TTSAudioBuffer;
        try {
          console.log(
            '[VibeVoiceTTSClient] Decoding WAV buffer for mark:',
            mark.name,
            'Size:',
            audioBuffer.byteLength,
          );
          decoded = await this.#player.decode(audioBuffer);
        } catch (err) {
          console.warn(
            '[VibeVoiceTTSClient] Decode failed, skipping chunk for mark:',
            mark.name,
            err,
          );
          continue;
        }

        const ready = await this.#player.waitUntilReady(generation);
        if (!ready || signal.aborted || this.#activeGeneration !== generation) return;

        this.#speakingLang = mark.language;
        console.log(
          '[VibeVoiceTTSClient] Scheduling chunk play for mark:',
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
        console.log('[VibeVoiceTTSClient] Scheduler finished. Ending player session.');
        this.#player.endSession(generation);
      }
    } catch (error) {
      console.error('[VibeVoiceTTSClient] Scheduler crash:', error);
      const message = error instanceof Error ? error.message : String(error);
      queue.push({ kind: 'error', message });
    }
  }

  async *#preload(marks: TTSMark[], signal: AbortSignal): AsyncIterable<TTSMessageEvent> {
    const count = Math.min(2, marks.length);
    for (let i = 0; i < count; i++) {
      if (signal.aborted) break;
      try {
        console.log('[VibeVoiceTTSClient] Preload synthesis for mark:', marks[i]!.name);
        await this.#synthesizeChunk(marks[i]!, signal);
      } catch (err) {
        console.warn('[VibeVoiceTTSClient] Preload synthesis failed:', err);
      }
    }
    yield { code: 'end', message: 'Preload finished' };
  }

  async #synthesizeChunk(mark: TTSMark, signal: AbortSignal): Promise<ArrayBuffer | null> {
    const payload = {
      model: VIBEVOICE_MODEL,
      quantization: this.#quantization,
      input: mark.text,
      voice: this.#currentVoiceId,
      response_format: 'wav',
    };
    console.log(
      '[VibeVoiceTTSClient] Sending POST request to:',
      this.#endpoint,
      'Payload:',
      payload,
    );
    const start = Date.now();
    const resp = await fetch(this.#endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    const elapsed = Date.now() - start;
    console.log(
      '[VibeVoiceTTSClient] POST response received in',
      elapsed,
      'ms. Status:',
      resp.status,
    );
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.warn('[VibeVoiceTTSClient] POST response not OK:', resp.status, errText);
      return null;
    }
    const buf = await resp.arrayBuffer();
    console.log('[VibeVoiceTTSClient] Audio buffer fetched. Length:', buf.byteLength, 'bytes');
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
    // pitch control not supported by VibeVoice TTS endpoint
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
    const voicesList = matching.length > 0 ? matching : this.#voices;
    const sorted = voicesList.sort(TTSUtils.sortVoicesPreferLocaleFunc(lang));
    return [
      {
        id: 'vibevoice',
        name: 'VibeVoice Realtime 0.5B (GGUF)',
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
