# Next Work Plan

## 1. TTS Panel → Right Sidebar, Vertically Centered
- Move TTSPlayerSheet from bottom-left → right side of screen
- Vertically centered, like a floating sidebar
- Keep existing width (~520px) and left-aligned text within the panel

## 2. Full WAV Synthesis Per Chapter
- After AI pre-process finishes, auto-synthesize all chunks via Kokoro
- Concatenate chunk WAVs into one chapter WAV
- Console shows progress (e.g., "Synthesizing chunk 4/7...")

## 3. Three-Tier Storage
- **Browser memory**: previous + current + next chapter WAVs (instant seek/play)
- **appService (IndexedDB/filesystem)**: all processed chapter WAVs
- **M4B merge**: once ~10 chapters in storage, merge into single `.m4b`, delete WAVs
- Resume: if user closes mid-process, `.txt` preprocess script is checkpoint

## 4. Background Pre-Fetch
- When user lands on chapter N, auto-queue N+1, N+2 for synthesis
- Limit: 1 background job at a time, don't overload Kokoro

## 5. Hard Mode Toggle (Settings)
- "Full Pipeline Mode" checkbox in TTS settings
- ON: no real-time TTS, no Edge fallback. If audio not ready, show "Processing..."
- OFF: current behavior (real-time TTS with Edge fallback)

## 6. Saved State: `audiobook/` folder + M4B output
- Processed audio files stored in `Books/<hash>/audiobook/`
- Intermediate WAV cleaned up after M4B merge
- Max 10 chapters per M4B file, auto-delete old intermediates
