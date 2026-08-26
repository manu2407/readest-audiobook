import { YTTrack } from './YTMusicService';

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: (() => void) | null;
  }
}

type PlayerEvent = 'stateChange' | 'error' | 'ready';
type PlayerState = -1 | 0 | 1 | 2 | 3 | 5;

export class YTPlayerWrapper {
  #player: any = null;
  #currentTrack: YTTrack | null = null;
  #queue: YTTrack[] = [];
  #volume = 50;
  #ready = false;
  #readyPromise: Promise<void>;
  #resolveReady: (() => void) | null = null;
  #listeners: Map<string, Set<(...args: any[]) => void>> = new Map();
  #containerId = 'yt-music-player';

  constructor() {
    this.#readyPromise = new Promise((resolve) => {
      this.#resolveReady = resolve;
    });
    this.#injectContainer();
    this.#loadAPI();
  }

  get isReady(): boolean {
    return this.#ready;
  }

  get currentTrack(): YTTrack | null {
    return this.#currentTrack;
  }

  get queueLength(): number {
    return this.#queue.length;
  }

  async ready(): Promise<void> {
    return this.#readyPromise;
  }

  on(event: PlayerEvent, callback: (...args: any[]) => void): void {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event)!.add(callback);
  }

  off(event: PlayerEvent, callback: (...args: any[]) => void): void {
    this.#listeners.get(event)?.delete(callback);
  }

  async loadTrack(track: YTTrack): Promise<void> {
    await this.ready();
    this.#currentTrack = track;
    if (this.#player) {
      this.#player.loadVideoById(track.videoId, 0);
    }
  }

  play(): void {
    if (this.#player) this.#player.playVideo();
  }

  pause(): void {
    if (this.#player) this.#player.pauseVideo();
  }

  stop(): void {
    if (this.#player) this.#player.stopVideo();
  }

  setVolume(vol: number): void {
    this.#volume = Math.max(0, Math.min(100, vol));
    if (this.#player) this.#player.setVolume(this.#volume);
  }

  getVolume(): number {
    if (this.#player) return this.#player.getVolume() ?? this.#volume;
    return this.#volume;
  }

  queueTrack(track: YTTrack): void {
    this.#queue.push(track);
  }

  clearQueue(): void {
    this.#queue = [];
  }

  #emit(event: string, ...args: any[]): void {
    this.#listeners.get(event)?.forEach((cb) => cb(...args));
  }

  #injectContainer(): void {
    if (document.getElementById(this.#containerId)) return;
    const div = document.createElement('div');
    div.id = this.#containerId;
    div.style.display = 'none';
    document.body.appendChild(div);
  }

  #loadAPI(): void {
    if (typeof window.YT?.Player === 'function') {
      this.#initPlayer();
      return;
    }
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    const first = document.getElementsByTagName('script')[0];
    first?.parentNode?.insertBefore(tag, first);

    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      this.#initPlayer();
    };
  }

  #initPlayer(): void {
    this.#player = new window.YT.Player(this.#containerId, {
      height: '0',
      width: '0',
      playerVars: {
        autoplay: 0,
        controls: 0,
        disablekb: 1,
        enablejsapi: 1,
        fs: 0,
        modestbranding: 1,
        playsinline: 1,
      },
      events: {
        onReady: () => {
          this.#ready = true;
          this.#resolveReady?.();
          this.#player.setVolume(this.#volume);
          this.#emit('ready');
        },
        onStateChange: (e: { data: PlayerState }) => {
          this.#emit('stateChange', e.data);
          if (e.data === 0) {
            // ENDED → auto-advance
            this.#playNext();
          }
        },
        onError: (e: { data: number }) => {
          this.#emit('error', e.data);
          // embed blocked (150) or other errors → skip
          this.#playNext();
        },
      },
    });
  }

  #playNext(): void {
    const next = this.#queue.shift();
    if (next) {
      this.loadTrack(next);
    }
  }
}
