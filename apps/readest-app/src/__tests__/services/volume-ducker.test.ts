import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { EQDucker } from '@/services/music/EQDucker';
import { VolumeDucker } from '@/services/music/VolumeDucker';

describe('VolumeDucker', () => {
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let nextRafId: number;
  let now: number;
  let playerVolume: { current: number };
  let player: { setVolume: ReturnType<typeof vi.fn>; getVolume: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    rafCallbacks = new Map();
    nextRafId = 0;
    now = 0;
    playerVolume = { current: 80 };

    player = {
      setVolume: vi.fn((v: number) => {
        playerVolume.current = v;
      }),
      getVolume: vi.fn(() => playerVolume.current),
    };

    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCallbacks.set(++nextRafId, callback);
      return nextRafId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafCallbacks.delete(id);
    });
    vi.stubGlobal('performance', { now: () => now });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const runFrame = (time: number) => {
    now = time;
    const callbacks = [...rafCallbacks.values()];
    rafCallbacks.clear();
    for (const callback of callbacks) callback(time);
  };

  test('ramps down from peak to floor when narrating starts', () => {
    const ducker = new VolumeDucker(player as any, {
      floor: 0.2,
      peak: 0.8,
      reactivity: 1.0,
      curve: 'linear',
    });

    ducker.setNarrating(true);
    runFrame(0); // t=0 → vol=0.8+(0.2-0.8)*0 = 0.8 → setVolume(80)
    runFrame(150); // t=150/300=0.5 → vol=0.8-0.6*0.5=0.5 → setVolume(50)
    runFrame(300); // t=1.0 → vol=0.2 → setVolume(20)

    expect(player.setVolume.mock.calls.map(([volume]) => volume)).toEqual([80, 50, 20]);
  });

  test('ramps up from floor to peak when narrating stops', () => {
    const ducker = new VolumeDucker(player as any, {
      floor: 0.2,
      peak: 0.8,
      reactivity: 1.0,
      curve: 'linear',
    });

    ducker.setNarrating(true); // ramp down: 0.8 → 0.2
    runFrame(0);
    runFrame(300);

    ducker.setNarrating(false); // ramp up: 0.2 → 0.8
    runFrame(300);
    runFrame(450);
    runFrame(600);

    expect(player.setVolume.mock.calls.map(([volume]) => volume)).toEqual([80, 20, 20, 50, 80]);
  });

  test('clamps invalid settings on updateSettings', () => {
    const ducker = new VolumeDucker(player as any);
    ducker.updateSettings({ floor: -0.5, peak: 2, reactivity: -1 });
    const s = ducker.settings;
    expect(s.floor).toBe(0);
    expect(s.peak).toBe(1);
    expect(s.reactivity).toBe(0);
  });

  test('cancels scheduled work when destroyed', () => {
    const ducker = new VolumeDucker(player as any, { reactivity: 1.0 });
    ducker.setNarrating(true);
    runFrame(0);
    ducker.destroy();
    const countBefore = player.setVolume.mock.calls.length;
    runFrame(100);
    expect(player.setVolume.mock.calls.length).toBe(countBefore);
  });
});

describe('EQDucker', () => {
  test('reports not capable outside Tauri', () => {
    const ducker = new EQDucker();
    expect(ducker.isCapable).toBe(false);
    expect(ducker.enabled).toBe(false);
  });

  test('setNarrating does not throw', () => {
    const ducker = new EQDucker();
    expect(() => ducker.setNarrating(true)).not.toThrow();
    expect(() => ducker.setNarrating(false)).not.toThrow();
  });

  test('enable and disable are no-ops when not capable', () => {
    const ducker = new EQDucker();
    expect(ducker.enabled).toBe(false);
    ducker.enable();
    expect(ducker.enabled).toBe(false);
    ducker.disable();
    expect(ducker.enabled).toBe(false);
  });
});
