export const MOODS = [
  'tense',
  'calm',
  'mysterious',
  'joyful',
  'sad',
  'action',
  'romantic',
  'neutral',
] as const;
export type Mood = (typeof MOODS)[number];

export const CURVES = ['rising', 'falling', 'flat'] as const;
export type Curve = (typeof CURVES)[number];

export interface Segment {
  id: string;
  text_range: [number, number];
  mood: Mood;
  intensity: number;
  curve: Curve;
  dramatic_pause: boolean;
}

export interface ChapterMood {
  chapter: number;
  segments: Segment[];
}

export interface Cue {
  id: string;
  start: number;
  end: number;
  music_target_volume: number;
  track_pool: string[];
  envelope: Curve;
}

export interface CueSheet {
  chapter: number;
  cues: Cue[];
  generated_at: number;
  tts_voice_id: string;
}

function isSegment(s: any): s is Segment {
  if (!s || typeof s !== 'object') return false;
  const seg = s as any;
  if (typeof seg.id !== 'string') return false;
  if (!Array.isArray(seg.text_range) || seg.text_range.length !== 2) return false;
  if (typeof seg.text_range[0] !== 'number' || typeof seg.text_range[1] !== 'number') return false;
  if (seg.text_range[0] < 0 || seg.text_range[0] >= seg.text_range[1]) return false;
  if (!MOODS.includes(seg.mood)) return false;
  if (typeof seg.intensity !== 'number' || seg.intensity < 0 || seg.intensity > 1) return false;
  if (!CURVES.includes(seg.curve)) return false;
  if (typeof seg.dramatic_pause !== 'boolean') return false;
  return true;
}

export function validateChapterMood(input: any): ChapterMood | null {
  if (!input || typeof input !== 'object') return null;
  const cm = input as any;
  if (typeof cm.chapter !== 'number') return null;
  if (!Array.isArray(cm.segments) || cm.segments.length === 0) return null;
  for (const seg of cm.segments) {
    if (!isSegment(seg)) return null;
  }
  // check non-overlapping ordered ranges
  let prevEnd = -1;
  for (const seg of cm.segments) {
    if (seg.text_range[0] <= prevEnd) return null;
    prevEnd = seg.text_range[1];
  }
  return cm as ChapterMood;
}

export function validateCueSheet(input: any): CueSheet | null {
  if (!input || typeof input !== 'object') return null;
  const cs = input as any;
  if (typeof cs.chapter !== 'number') return null;
  if (!Array.isArray(cs.cues)) return null;
  for (const cue of cs.cues) {
    if (typeof cue.id !== 'string') return null;
    if (typeof cue.start !== 'number' || cue.start < 0) return null;
    if (typeof cue.end !== 'number' || cue.end <= cue.start) return null;
    if (typeof cue.music_target_volume !== 'number') return null;
    if (!Array.isArray(cue.track_pool)) return null;
    if (cue.track_pool.some((t: any) => typeof t !== 'string')) return null;
    if (!CURVES.includes(cue.envelope)) return null;
  }
  return cs as CueSheet;
}
