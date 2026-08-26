export interface EQSettings {
  enabled: boolean;
  frequency: number;
  Q: number;
  gain: number;
}

export class EQDucker {
  #capable = false;
  #enabled = false;

  constructor() {
    this.#capable = this.#detectCapability();
  }

  get isCapable(): boolean {
    return this.#capable;
  }

  get enabled(): boolean {
    return this.#enabled && this.#capable;
  }

  enable(): void {
    this.#enabled = true;
  }

  disable(): void {
    this.#enabled = false;
  }

  setNarrating(_active: boolean): void {
    // Cross-origin YouTube IFrame cannot be routed through Web Audio API.
    // EQ ducking requires desktop app with content script injection
    // to capture the video element's MediaStream. No-op here.
  }

  #detectCapability(): boolean {
    const isTauri = typeof (window as any).__TAURI__ !== 'undefined';
    const isMobile = /Android|iPhone|iPad|iPod/i.test(
      typeof navigator !== 'undefined' ? navigator.userAgent : '',
    );
    return isTauri && !isMobile;
  }
}
