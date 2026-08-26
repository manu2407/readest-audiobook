import { describe, expect, it, vi, beforeAll } from 'vitest';
import { YTMusicService } from '@/services/music';

// jsdom with --localstorage-file lacks functional localStorage; polyfill it.
const ls = new Map<string, string>();
beforeAll(() => {
  if (typeof localStorage !== 'object' || typeof localStorage.getItem !== 'function') {
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (k: string) => ls.get(k) ?? null,
        setItem: (k: string, v: string) => {
          ls.set(k, v);
        },
        removeItem: (k: string) => {
          ls.delete(k);
        },
        clear: () => ls.clear(),
        get length() {
          return ls.size;
        },
        key: (i: number) => [...ls.keys()][i] ?? null,
      },
      writable: false,
      configurable: true,
    });
  }
});

describe('YTMusicService', () => {
  it('parses playlist IDs from IDs and URLs', () => {
    const svc = new YTMusicService('test-client-id');
    expect(svc.getPlaylistId('PL123456789')).toBe('PL123456789');
    expect(svc.getPlaylistId('https://www.youtube.com/playlist?list=PL123')).toBe('PL123');
    expect(svc.getPlaylistId('not a playlist')).toBe('not a playlist');
  });

  it('returns false for exchangeCode on non-OK response', async () => {
    const svc = new YTMusicService('test-client-id');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 400 })));
    const result = await svc.exchangeCode('code123', 'verifier456', 'http://localhost/cb');
    expect(result).toBe(false);
    vi.unstubAllGlobals();
  });

  it('builds an OAuth URL with PKCE params', () => {
    const svc = new YTMusicService('my-client');
    const url = svc.buildAuthUrl('http://localhost/cb', 'challenge-hash');
    expect(url).toContain('client_id=my-client');
    expect(url).toContain('redirect_uri=http%3A%2F%2Flocalhost%2Fcb');
    expect(url).toContain('code_challenge=challenge-hash');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain('access_type=offline');
  });

  it('fetches playlist tracks and returns mood distribution', async () => {
    localStorage.setItem('readest.yt.accessToken', 'fake-token');
    const svc = new YTMusicService('test-client-id');

    const fetchMock = vi
      .fn()
      // playlistItems response
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              { snippet: { resourceId: { videoId: 'v1' }, title: 'Calm piano music' } },
              { snippet: { resourceId: { videoId: 'v2' }, title: 'Upbeat dance mix' } },
            ],
          }),
        ),
      )
      // videos details response
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              { id: 'v1', contentDetails: { duration: 'PT5M30S' }, status: { embeddable: true } },
              { id: 'v2', contentDetails: { duration: 'PT3M15S' }, status: { embeddable: true } },
            ],
          }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await svc.fetchPlaylist('PL123');
    expect(result.tracks).toHaveLength(2);
    expect(result.tracks[0]!.videoId).toBe('v1');
    expect(result.tracks[0]!.moodTag).toBe('calm');
    expect(result.tracks[0]!.duration).toBe(330);
    expect(result.tracks[1]!.moodTag).toBe('joyful');
    expect(result.moodDistribution).toEqual({ calm: 1, joyful: 1 });
    vi.unstubAllGlobals();
  });

  it('returns a track for a given mood from the pool', async () => {
    localStorage.setItem('readest.yt.accessToken', 'fake-token');
    const svc = new YTMusicService('test-client-id');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ snippet: { resourceId: { videoId: 'v1' }, title: 'Calm piano' } }],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              { id: 'v1', contentDetails: { duration: 'PT1M0S' }, status: { embeddable: true } },
            ],
          }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await svc.fetchPlaylist('PL123');
    const track = svc.getTrackForMood('calm');
    expect(track).not.toBeNull();
    expect(track!.videoId).toBe('v1');

    const missing = svc.getTrackForMood('action');
    expect(missing).toBeNull();
    vi.unstubAllGlobals();
  });

  it('refreshAccessToken returns false when no refresh token exists', async () => {
    const svc = new YTMusicService('test-client-id');
    const result = await svc.refreshAccessToken();
    expect(result).toBe(false);
  });

  it('clearAuth removes tokens from localStorage', () => {
    localStorage.setItem('readest.yt.accessToken', 'tok');
    localStorage.setItem('readest.yt.refreshToken', 'ref');
    const svc = new YTMusicService('test-client-id');
    svc.clearAuth();
    expect(localStorage.getItem('readest.yt.accessToken')).toBeNull();
    expect(localStorage.getItem('readest.yt.refreshToken')).toBeNull();
  });
});
