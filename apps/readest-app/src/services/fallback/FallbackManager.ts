export type Subsystem = 'tts' | 'music' | 'scene';

export type FallbackEvent = {
  subsystem: Subsystem;
  action: string;
  message: string;
  timestamp: number;
};

export type FallbackDecision = 'retry' | 'skip' | 'next' | 'silence' | 'default' | 'stop';

const MAX_LOG = 100;
const LOG_KEY = 'readest.fallback.log';

export class FallbackManager {
  #log: FallbackEvent[] = [];
  #listeners: Set<(event: FallbackEvent) => void> = new Set();

  constructor() {
    this.#load();
  }

  subscribe(cb: (event: FallbackEvent) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  record(subsystem: Subsystem, action: string, message: string): void {
    const event: FallbackEvent = {
      subsystem,
      action,
      message,
      timestamp: Date.now(),
    };
    this.#log.push(event);
    if (this.#log.length > MAX_LOG) this.#log.shift();
    this.#save();
    this.#listeners.forEach((cb) => cb(event));
  }

  getLog(): FallbackEvent[] {
    return [...this.#log];
  }

  getLogFor(subsystem: Subsystem): FallbackEvent[] {
    return this.#log.filter((e) => e.subsystem === subsystem);
  }

  clear(): void {
    this.#log = [];
    this.#save();
  }

  // Decision helpers
  decideTTS(failCount: number): FallbackDecision {
    if (failCount <= 1) return 'retry';
    return 'skip';
  }

  decideMusic(embedBlocked: boolean, poolExhausted: boolean): FallbackDecision {
    if (embedBlocked || poolExhausted) return 'next';
    return 'silence';
  }

  decideScene(agentFailed: boolean): FallbackDecision {
    if (agentFailed) return 'default';
    return 'stop';
  }

  #load(): void {
    try {
      const raw = localStorage.getItem(LOG_KEY);
      if (raw) this.#log = JSON.parse(raw);
    } catch {
      this.#log = [];
    }
  }

  #save(): void {
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(this.#log));
    } catch {
      // non-critical
    }
  }
}
