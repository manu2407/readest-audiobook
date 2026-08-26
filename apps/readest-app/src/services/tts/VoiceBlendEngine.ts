export interface VoiceOption {
  id: string;
  name: string;
  gender: string;
  lang: string;
}

export type BlendMode = 'linear' | 'weighted' | 'slerp';

export interface BlendConfig {
  mode: BlendMode;
  voiceIds: string[];
  weights?: number[];
  name: string;
}

export interface BlendPreset {
  name: string;
  mode: BlendMode;
  voiceIds: string[];
  weights: number[];
  createdAt: number;
}

const ALL_VOICES: VoiceOption[] = [
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

const STORAGE_KEY = 'readest.kokoro.customVoices';

export class VoiceBlendEngine {
  #presets: Map<string, BlendPreset> = new Map();

  constructor() {
    this.#load();
  }

  get allVoices(): VoiceOption[] {
    return [...ALL_VOICES];
  }

  get presets(): BlendPreset[] {
    return Array.from(this.#presets.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  validate(config: BlendConfig): string | null {
    if (config.voiceIds.length < 2 || config.voiceIds.length > 4) {
      return 'Select 2–4 voices';
    }
    const unique = new Set(config.voiceIds);
    if (unique.size !== config.voiceIds.length) return 'Duplicate voices';
    for (const id of config.voiceIds) {
      if (!ALL_VOICES.some((v) => v.id === id)) return `Unknown voice: ${id}`;
    }
    if (!config.name.trim()) return 'Name is required';
    if (config.mode === 'weighted') {
      const w = config.weights ?? [];
      if (w.length !== config.voiceIds.length) return 'Weight count mismatch';
      if (w.some((x) => x < 0 || x > 1)) return 'Weights must be 0–1';
      if (Math.abs(w.reduce((a, b) => a + b, 0) - 1) > 0.01) return 'Weights must sum to 1';
    }
    return null;
  }

  save(config: BlendConfig): boolean {
    const err = this.validate(config);
    if (err) return false;
    const preset: BlendPreset = {
      name: config.name.trim(),
      mode: config.mode,
      voiceIds: [...config.voiceIds],
      weights:
        config.mode === 'weighted'
          ? [...(config.weights ?? [])]
          : config.voiceIds.map(() => 1 / config.voiceIds.length),
      createdAt: Date.now(),
    };
    this.#presets.set(preset.name, preset);
    this.#save();
    return true;
  }

  delete(name: string): void {
    this.#presets.delete(name);
    this.#save();
  }

  get(name: string): BlendPreset | undefined {
    return this.#presets.get(name);
  }

  #load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const arr: BlendPreset[] = JSON.parse(raw);
      for (const p of arr) this.#presets.set(p.name, p);
    } catch {
      this.#presets.clear();
    }
  }

  #save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.presets));
    } catch {
      // storage full — silently fail
    }
  }
}
