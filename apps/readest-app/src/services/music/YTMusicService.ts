export interface YTTrack {
  videoId: string;
  title: string;
  duration: number;
  moodTag: string;
  embeddable: boolean;
}

const MOOD_KEYWORDS: Record<string, string[]> = {
  tense: ['thriller', 'suspense', 'dark', 'intense', 'dramatic', 'noir', 'ominous'],
  calm: ['ambient', 'lofi', 'chill', 'relax', 'peaceful', 'calm', 'meditation', 'slow'],
  mysterious: ['mystery', 'ethereal', 'ambient dark', 'dream', 'space'],
  joyful: ['happy', 'upbeat', 'cheerful', 'bright', 'joyful', 'fun', 'positive'],
  sad: ['sad', 'melancholy', 'emotional', 'tender', 'somber', 'piano'],
  action: ['epic', 'action', 'powerful', 'energetic', 'intense', 'rock', 'orchestral'],
  romantic: ['romantic', 'love', 'soft', 'gentle', 'sweet'],
  neutral: [],
};

function inferMood(title: string): string {
  const lower = title.toLowerCase();
  for (const [mood, keywords] of Object.entries(MOOD_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return mood;
    }
  }
  return 'neutral';
}

function parsePlaylistId(input: string): string {
  try {
    const u = new URL(input);
    const list = u.searchParams.get('list');
    if (list) return list;
  } catch {}
  return input.trim();
}

export class YTMusicService {
  #accessToken: string | null = null;
  #refreshToken: string | null = null;
  #clientId: string;
  #playlistId: string | null = null;
  #trackPool: Map<string, YTTrack[]> = new Map();

  constructor(clientId: string) {
    this.#clientId = clientId;
    this.#loadTokens();
  }

  get isAuthenticated(): boolean {
    return !!this.#accessToken;
  }

  get playlistId(): string | null {
    return this.#playlistId;
  }

  get availableMoods(): string[] {
    return Array.from(this.#trackPool.keys());
  }

  buildAuthUrl(redirectUri: string, codeChallenge: string): string {
    const params = new URLSearchParams({
      client_id: this.#clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/youtube.readonly',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<boolean> {
    try {
      const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: this.#clientId,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: codeVerifier,
        }),
      });
      if (!resp.ok) return false;
      const data = await resp.json();
      this.#accessToken = data.access_token;
      this.#refreshToken = data.refresh_token || null;
      this.#saveTokens();
      return true;
    } catch {
      return false;
    }
  }

  async fetchPlaylist(
    playlistId: string,
  ): Promise<{ tracks: YTTrack[]; moodDistribution: Record<string, number> }> {
    this.#playlistId = playlistId;
    const tracks: YTTrack[] = [];
    let pageToken = '';

    do {
      const params = new URLSearchParams({
        part: 'snippet,contentDetails',
        playlistId,
        maxResults: '50',
      });
      if (pageToken) params.set('pageToken', pageToken);

      const resp = await this.#authenticatedFetch(
        `https://www.googleapis.com/youtube/v3/playlistItems?${params}`,
      );
      if (!resp.ok) break;

      const data = await resp.json();
      const videoIds =
        data.items
          ?.filter((i: any) => i.snippet?.resourceId?.videoId)
          .map((i: any) => i.snippet.resourceId.videoId) ?? [];

      if (videoIds.length > 0) {
        const details = await this.#fetchVideoDetails(videoIds);
        const detailsMap = new Map(details.map((d: any) => [d.id, d]));

        for (const item of data.items ?? []) {
          const videoId = item.snippet?.resourceId?.videoId;
          if (!videoId) continue;
          const detail = detailsMap.get(videoId);
          const title = item.snippet?.title ?? '';
          const durationStr = detail?.contentDetails?.duration ?? 'PT0S';
          const duration = this.#parseDuration(durationStr);
          const embeddable = detail?.status?.embeddable !== false;
          const moodTag = inferMood(title);

          tracks.push({ videoId, title, duration, moodTag, embeddable });
        }
      }

      pageToken = data.nextPageToken ?? '';
    } while (pageToken);

    this.#buildTrackPool(tracks);
    const moodDistribution: Record<string, number> = {};
    for (const t of tracks) {
      moodDistribution[t.moodTag] = (moodDistribution[t.moodTag] ?? 0) + 1;
    }
    return { tracks, moodDistribution };
  }

  getTrackForMood(mood: string): YTTrack | null {
    const pool = this.#trackPool.get(mood);
    if (!pool || pool.length === 0) return null;
    const idx = Math.floor(Math.random() * pool.length);
    return pool[idx]!;
  }

  async refreshAccessToken(): Promise<boolean> {
    if (!this.#refreshToken) return false;
    try {
      const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          refresh_token: this.#refreshToken,
          client_id: this.#clientId,
          grant_type: 'refresh_token',
        }),
      });
      if (!resp.ok) return false;
      const data = await resp.json();
      this.#accessToken = data.access_token;
      this.#saveTokens();
      return true;
    } catch {
      return false;
    }
  }

  clearAuth(): void {
    this.#accessToken = null;
    this.#refreshToken = null;
    localStorage.removeItem('readest.yt.accessToken');
    localStorage.removeItem('readest.yt.refreshToken');
  }

  #buildTrackPool(tracks: YTTrack[]): void {
    this.#trackPool.clear();
    for (const t of tracks) {
      const list = this.#trackPool.get(t.moodTag) ?? [];
      list.push(t);
      this.#trackPool.set(t.moodTag, list);
    }
  }

  async #fetchVideoDetails(videoIds: string[]): Promise<any[]> {
    const chunks: string[] = [];
    for (let i = 0; i < videoIds.length; i += 50) {
      chunks.push(videoIds.slice(i, i + 50).join(','));
    }
    const results: any[] = [];
    for (const ids of chunks) {
      const params = new URLSearchParams({
        part: 'contentDetails,status',
        id: ids,
      });
      const resp = await this.#authenticatedFetch(
        `https://www.googleapis.com/youtube/v3/videos?${params}`,
      );
      if (resp.ok) {
        const data = await resp.json();
        results.push(...(data.items ?? []));
      }
    }
    return results;
  }

  async #authenticatedFetch(url: string): Promise<Response> {
    if (!this.#accessToken) return new Response(null, { status: 401 });
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${this.#accessToken}` },
    });
    if (resp.status === 401 && this.#refreshToken) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        return fetch(url, {
          headers: { Authorization: `Bearer ${this.#accessToken}` },
        });
      }
    }
    return resp;
  }

  #parseDuration(iso: string): number {
    const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return 0;
    const h = parseInt(match[1] ?? '0', 10);
    const m = parseInt(match[2] ?? '0', 10);
    const s = parseInt(match[3] ?? '0', 10);
    return h * 3600 + m * 60 + s;
  }

  #saveTokens(): void {
    if (this.#accessToken) localStorage.setItem('readest.yt.accessToken', this.#accessToken);
    if (this.#refreshToken) localStorage.setItem('readest.yt.refreshToken', this.#refreshToken);
  }

  #loadTokens(): void {
    this.#accessToken = localStorage.getItem('readest.yt.accessToken');
    this.#refreshToken = localStorage.getItem('readest.yt.refreshToken');
  }

  getPlaylistId(input: string): string {
    return parsePlaylistId(input);
  }
}
