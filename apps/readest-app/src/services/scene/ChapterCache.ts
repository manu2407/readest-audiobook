import { ChapterMood } from './types';

const SCHEMA_VERSION = 1;
const STORAGE_PREFIX = 'readest.scene.';

interface CacheEntry {
  hash: string;
  data: ChapterMood;
  version: number;
  created: number;
}

async function sha256(text: string): Promise<string> {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex;
}

export class ChapterCache {
  async get(chapterText: string): Promise<ChapterMood | null> {
    const hash = await sha256(chapterText);
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + hash);
      if (!raw) return null;
      const entry: CacheEntry = JSON.parse(raw);
      if (entry.version !== SCHEMA_VERSION) {
        localStorage.removeItem(STORAGE_PREFIX + hash);
        return null;
      }
      return entry.data;
    } catch {
      return null;
    }
  }

  async set(chapterText: string, mood: ChapterMood): Promise<void> {
    const hash = await sha256(chapterText);
    const entry: CacheEntry = {
      hash,
      data: mood,
      version: SCHEMA_VERSION,
      created: Date.now(),
    };
    try {
      localStorage.setItem(STORAGE_PREFIX + hash, JSON.stringify(entry));
    } catch {
      // storage full — silently fail
    }
  }

  async invalidate(chapterText: string): Promise<void> {
    const hash = await sha256(chapterText);
    localStorage.removeItem(STORAGE_PREFIX + hash);
  }

  clearAll(): void {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  }
}
