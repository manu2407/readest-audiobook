import { ChapterMood, validateChapterMood } from './types';
import { ChapterCache } from './ChapterCache';

export type TaggerBackend = 'opencode' | 'antigravity';

export interface TaggerConfig {
  backend: TaggerBackend;
  timeoutMs: number;
}

const TAGGER_PROMPT = `You are a literary scene analyzer. Given a chapter of fiction text, segment it into coherent narrative beats and assign mood/intensity.

OUTPUT FORMAT: Valid JSON matching this schema exactly:
{
  "chapter": <number>,
  "segments": [
    {
      "id": "s1",
      "text_range": [0, 340],
      "mood": "tense",
      "intensity": 0.7,
      "curve": "rising",
      "dramatic_pause": false
    }
  ]
}

RULES:
- Segments should align with scene beats (target 200-800 chars each)
- mood: one of [tense, calm, mysterious, joyful, sad, action, romantic, neutral]
- intensity: 0.0 (subtle) to 1.0 (overwhelming)
- curve: "rising" (tension builds), "falling" (release), "flat" (sustained)
- dramatic_pause: true ONLY for authored dramatic beats (scene breaks, chapter cliffhangers, explicit pauses like "...") — NOT for normal sentence/paragraph breaks
- Cover entire chapter text without gaps or overlaps
- No extra fields, no markdown, no commentary outside the JSON`;

type TagRunner = (text: string, prompt: string) => Promise<string>;

export class SceneTagger {
  #cache: ChapterCache;
  #config: TaggerConfig;
  #runner: TagRunner;

  constructor(runner: TagRunner, config?: Partial<TaggerConfig>) {
    this.#cache = new ChapterCache();
    this.#config = {
      backend: 'opencode',
      timeoutMs: 60000,
      ...config,
    };
    this.#runner = runner;
  }

  get config(): TaggerConfig {
    return { ...this.#config };
  }

  async tag(chapterIndex: number, chapterText: string): Promise<ChapterMood | null> {
    // Check cache first
    const cached = await this.#cache.get(chapterText);
    if (cached) return cached;

    // Run the tagger
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs);
      const raw = await this.#runner(chapterText, TAGGER_PROMPT);
      clearTimeout(timer);

      const parsed = this.#parseJson(raw);
      const validated = validateChapterMood(parsed);
      if (!validated) return null;

      validated.chapter = chapterIndex;
      await this.#cache.set(chapterText, validated);
      return validated;
    } catch {
      return null;
    }
  }

  async invalidateCache(chapterText: string): Promise<void> {
    await this.#cache.invalidate(chapterText);
  }

  #parseJson(raw: string): any {
    // Strip code fences if present
    const trimmed = raw.trim();
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = fenceMatch ? fenceMatch[1]!.trim() : trimmed;
    return JSON.parse(jsonStr);
  }
}
