import { ChapterMood, Cue, CueSheet, Curve, validateCueSheet } from './types';

function moodToBaseVolume(mood: string, intensity: number): number {
  const base =
    mood === 'calm' || mood === 'sad' ? 0.5 : mood === 'action' || mood === 'tense' ? 0.2 : 0.35;
  return Math.max(0.05, Math.min(0.8, base + intensity * 0.3 - 0.15));
}

function moodToTrackPool(mood: string): string[] {
  const pool: Record<string, string[]> = {
    tense: ['tense_1', 'tense_2'],
    calm: ['calm_1', 'calm_2', 'calm_3'],
    mysterious: ['mysterious_1'],
    joyful: ['joyful_1', 'joyful_2'],
    sad: ['sad_1'],
    action: ['action_1', 'action_2'],
    romantic: ['romantic_1'],
    neutral: ['neutral_1', 'neutral_2'],
  };
  return pool[mood] ?? pool['neutral'] ?? [];
}

function envelopeCurve(curve: Curve, position: number, duration: number): number {
  const t = duration > 0 ? position / duration : 0;
  if (curve === 'rising') return t;
  if (curve === 'falling') return 1 - t;
  return 1;
}

export class CueSheetGenerator {
  generate(
    chapterIndex: number,
    mood: ChapterMood,
    segmentDurations: number[],
    ttsVoiceId: string,
  ): CueSheet {
    const cues: Cue[] = [];
    let cursor = 0;

    for (let i = 0; i < mood.segments.length; i++) {
      const seg = mood.segments[i]!;
      const dur = segmentDurations[i] ?? 5;
      const start = cursor;
      const end = cursor + dur;

      const baseVol = moodToBaseVolume(seg.mood, seg.intensity);
      const env = envelopeCurve(seg.curve, 0, dur);
      const musicTarget = Math.max(0.05, Math.min(0.9, baseVol * env));

      cues.push({
        id: seg.id,
        start,
        end,
        music_target_volume: musicTarget,
        track_pool: moodToTrackPool(seg.mood),
        envelope: seg.curve,
      });

      cursor = end;
    }

    const sheet: CueSheet = {
      chapter: chapterIndex,
      cues,
      generated_at: Date.now(),
      tts_voice_id: ttsVoiceId,
    };

    return validateCueSheet(sheet) ?? sheet;
  }
}
