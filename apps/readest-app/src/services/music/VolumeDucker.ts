import { YTPlayerWrapper } from './YTPlayerWrapper';

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export interface DuckSettings {
  floor: number;
  peak: number;
  reactivity: number;
  curve: 'linear' | 'easeInOut';
}

export class VolumeDucker {
  #player: YTPlayerWrapper;
  #settings: DuckSettings;
  #ttsPlaying = false;
  #rafId: number | null = null;
  #startVolume = 0;
  #targetVolume = 0;
  #startTime = 0;

  constructor(player: YTPlayerWrapper, settings?: Partial<DuckSettings>) {
    this.#player = player;
    this.#settings = {
      floor: 0.2,
      peak: 0.8,
      reactivity: 0.5,
      curve: 'easeInOut',
      ...settings,
    };
  }

  get settings(): DuckSettings {
    return { ...this.#settings };
  }

  updateSettings(partial: Partial<DuckSettings>): void {
    Object.assign(this.#settings, partial);
    this.#settings.floor = Math.max(0, Math.min(1, this.#settings.floor));
    this.#settings.peak = Math.max(0, Math.min(1, this.#settings.peak));
    this.#settings.reactivity = Math.max(0, Math.min(1, this.#settings.reactivity));
  }

  setNarrating(active: boolean): void {
    if (this.#ttsPlaying === active) return;
    this.#ttsPlaying = active;
    this.#ramp();
  }

  #ramp(): void {
    if (this.#rafId !== null) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = null;
    }

    this.#startVolume = this.#player.getVolume() / 100;
    this.#targetVolume = this.#ttsPlaying ? this.#settings.floor : this.#settings.peak;
    this.#startTime = performance.now();

    const duration = 300 + 700 * (1 - this.#settings.reactivity);

    const tick = () => {
      const t = Math.min((performance.now() - this.#startTime) / duration, 1);
      const eased = this.#settings.curve === 'easeInOut' ? easeInOutCubic(t) : t;
      const vol = this.#startVolume + (this.#targetVolume - this.#startVolume) * eased;
      this.#player.setVolume(Math.round(vol * 100));

      if (t < 1) {
        this.#rafId = requestAnimationFrame(tick);
      } else {
        this.#rafId = null;
      }
    };

    this.#rafId = requestAnimationFrame(tick);
  }

  destroy(): void {
    if (this.#rafId !== null) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = null;
    }
  }
}
