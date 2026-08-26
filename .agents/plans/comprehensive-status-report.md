# TTS + Music Architecture — Comprehensive Status Report

## 1. Project Goal

Fork of Readest (Next.js 16 + Tauri v2, AGPL-3.0) that replaces cloud TTS with **fully local Kokoro-82M TTS narration** and adds **adaptive background music** from the user's own YouTube playlists.

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Browser / Tauri WebView                  │
│                                                          │
│  ┌──────────────────┐   ┌──────────────────────────┐    │
│  │   TTSController   │   │   Reader UI (React)      │    │
│  │  (service/tts/)   │──▶│  - TTSControl            │    │
│  │                   │   │  - TTSPlayerSheet        │    │
│  │  - WebSpeechClient│   │  - TTSPanel (settings)   │    │
│  │  - EdgeTTSClient   │   │  - MusicSettingsPanel   │    │
│  │  - KokoroTTSClient │   │  - VoiceBlendPanel      │    │
│  │  - NativeTTSClient │   └──────────────────────────┘    │
│  └────────┬──────────┘                                    │
│           │                                               │
│           │ HTTP POST (JSON)                              │
│           ▼                                               │
│  ┌──────────────────┐                                     │
│  │  Next.js API Route│  ← /api/tts/kokoro (proxy)        │
│  │  route.ts         │     (avoids CORS)                  │
│  └────────┬──────────┘                                    │
│           │                                               │
│           │ HTTP POST (forwarded)                         │
│           ▼                                               │
│  ┌──────────────────┐                                     │
│  │  Kokoro-82M Model │  ← http://localhost:8880           │
│  │  (local server)   │     /v1/audio/speech               │
│  └──────────────────┘                                     │
│                                                          │
│  ┌──────────────────┐   ┌──────────────────────────┐    │
│  │  YTMusicService   │   │  VolumeDucker            │    │
│  │  (OAuth2 + API)   │   │  (rAF volume ramp)       │    │
│  └──────────────────┘   └──────────────────────────┘    │
│                                                          │
│  ┌──────────────────┐   ┌──────────────────────────┐    │
│  │  SceneTagger     │   │  CueSheetGenerator       │    │
│  │  (LLM prompt)    │   │  (mood→track mapping)    │    │
│  └──────────────────┘   └──────────────────────────┘    │
│                                                          │
│  ┌──────────────────┐   ┌──────────────────────────┐    │
│  │  FallbackManager  │   │  VoiceBlendEngine        │    │
│  │  (graceful degr.) │   │  (54 Kokoro voices)      │    │
│  └──────────────────┘   └──────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

## 3. New Files Created (17 files)

### Services Layer

| File | Lines | Purpose |
|------|-------|---------|
| `services/tts/KokoroTTSClient.ts` | 273 | TTSClient impl: HTTP WAV synthesis, WebAudioPlayer gapless, 54-voice catalog |
| `services/tts/VoiceBlendEngine.ts` | 159 | 54 Kokoro voice metadata, 3 blend modes, preset persistence |
| `services/music/YTMusicService.ts` | 260 | OAuth PKCE, playlist fetch, mood heuristics, token management |
| `services/music/YTPlayerWrapper.ts` | 166 | IFrame API loader, play/pause/stop, auto-advance, queue |
| `services/music/VolumeDucker.ts` | 85 | rAF ramp with easeInOutCubic easing, configurable ducking |
| `services/music/EQDucker.ts` | 44 | Capability-detecting no-op (cross-origin IFrame limitation) |
| `services/music/index.ts` | 7 | Barrel exports |
| `services/fallback/FallbackManager.ts` | 92 | Typed subsystem fallback with bounded log |
| `services/scene/types.ts` | 86 | Segment, ChapterMood, Cue, CueSheet types + validators |
| `services/scene/ChapterCache.ts` | 67 | SHA-256 chapter caching |
| `services/scene/SceneTagger.ts` | 93 | Backend-agnostic LLM scene tagging |
| `services/scene/CueSheetGenerator.ts` | 70 | Mood→volume mapping, envelope curves |
| `services/scene/index.ts` | 5 | Barrel exports |
| `services/scene/prompt.md` | 25 | LLM prompt template |

### UI Components

| File | Lines | Purpose |
|------|-------|---------|
| `components/settings/MusicSettingsPanel.tsx` | 150 | YouTube OAuth + ducking controls |
| `components/settings/VoiceBlendPanel.tsx` | 162 | 54-voice blend preset manager |
| `components/reader/SceneEditor.tsx` | 136 | Per-segment override UI |

### Infrastructure

| File | Purpose |
|------|---------|
| `app/api/tts/kokoro/route.ts` | Same-origin proxy for Kokoro endpoint (avoids CORS) |

### Modified Existing Files

| File | Change |
|------|--------|
| `services/tts/TTSController.ts` | Kokoro client field, init, voice selection, re-init on select, Kokoro preferred over Edge |
| `services/tts/index.ts` | Re-export KokoroTTSClient |
| `components/settings/SettingsDialog.tsx` | Music + VoiceBlend panel tabs |
| `services/commandRegistry.ts` | Panel icons for Music + VoiceBlend |

### Test Files

| File | Tests | Status |
|------|-------|--------|
| `__tests__/services/YTMusicService.test.ts` | 7 | ✅ All pass |
| `__tests__/services/volume-ducker.test.ts` | 7 | ✅ All pass |

## 4. Current Issues

### 🚨 Issue 1: User cannot select Kokoro voice in TTS settings UI

**What's seen:**
- Opening Settings → TTS panel: there is NO voice selector dropdown or list of TTS engines
- No option to pick between Edge, Web Speech, Kokoro, etc.

**Root cause:**
The TTS panel (`TTSPanel.tsx`) only exposes media metadata mode, highlighting options, and rate — it does NOT contain a voice/engine selector. The voice selector lives in the **TTSPlayerSheet** (the expandable player that appears when you tap the TTS play button from the reader). The sequence is:

1. Open a book
2. Tap the TTS play icon (bottom bar)
3. A mini-player appears at the bottom
4. Tap the expand arrow → TTSPlayerSheet opens
5. Inside that sheet there's a voice row → tap it → voice selection popup appears

The user never got to step 2 because the login toast blocked them (previously) and because Edge kept failing.

**User expectation:** A settings entry in the TTSPanel (or a dedicated engine selector) to choose the TTS backend explicitly, visible without opening a book.

### 🚨 Issue 2: Edge TTS fires login toast instead of Kokoro

**What's seen:**
- Toast: "Please log in to use advanced TTS features"
- WSS connection to Bing returns 403

**Root cause:**
`EdgeTTSClient.init()` tries WSS → fails → checks `controller.isAuthenticated` → false → dispatches `tts-need-auth` → the handler in `useTTSControl.ts` shows the login toast.

**Fix applied:** Kokoro is now checked BEFORE Edge in the init order (`TTSController.ts:315`). If Kokoro init succeeds (model running), it becomes the default and Edge is never used.

### 🚨 Issue 3: CORS on localhost:8880 Kokoro endpoint

**What's seen:**
- `Cross-Origin Request Blocked: http://localhost:8880/v1/audio/speech`
- The browser blocks the POST because the Kokoro server doesn't return CORS headers

**Fix applied:** Created `/api/tts/kokoro` Next.js API route (`route.ts`) that proxies requests same-origin. Changed KokoroTTSClient default endpoint from `http://localhost:8880/v1/audio/speech` to `/api/tts/kokoro`. Still respects `NEXT_PUBLIC_KOKORO_TTS_ENDPOINT` env var.

### 🚨 Issue 4: Dev server keeps dying

**What's seen:**
- Server starts, serves a few requests, then exits silently
- Port 3000 taken by AdGuard Home, port 3001 by Open WebUI

**Status:** Workaround — start with `disown` to keep it alive. Persistent fix needed: configure AdGuard/OpenWebUI to use different ports, or configure Next.js to always use port 3002.

### 🚨 Issue 5: No audio output when Kokoro is selected

**What's seen:**
- TTS toggle shows as "playing" but no audio
- `WebAudioPlayer` decode/schedule path may fail silently

**Root cause:** The `KokoroTTSClient.speak()` method catches synthesis/decode errors silently:
```ts
console.warn('[Kokoro] synthesis failed for mark', mark.name, err);
```
No error reaches the user. And if the model returns an empty/unexpected response, the decode step fails and we skip the chunk silently.

## 5. What Needs to Happen Next

### Priority 1: Make Kokoro Voice Selectable in Settings

The TTS engine/voice selector needs to be accessible from the **TTSPanel** (Settings → TTS), not just from the reader's TTSPlayerSheet. Add:

```
TTSPanel.tsx:
  - "TTS Engine" dropdown: [Web Speech | Edge | Kokoro | Native]
  - "Voice" selector: populated from selected engine's getVoices()
  - Currently selected voice indicator
```

### Priority 2: Wire Kokoro Through the Full Speak Path

- Verify `/api/tts/kokoro` proxy correctly forwards POST body and returns audio
- `WebAudioPlayer.decode()` needs to handle the returned WAV properly
- Add user-visible error when synthesis fails (toast, not console.warn)
- Test end-to-end: tap play → Kokoro selected → audio heard

### Priority 3: Persistent Dev Server

- Configure AdGuard Home and Open WebUI to use non-conflicting ports
- Or add `--port 3002` to the dev command

### Priority 4: Music Service Integration

- OAuth flow: Google Cloud Project → OAuth consent screen → Client ID → paste into MusicSettingsPanel
- YTPlayerWrapper: needs a real YouTube video ID to test
- VolumeDucker: verify rAF ramp works with YTPlayerWrapper

### Priority 5: Scene Tagging + Cue Sheet

- Needs an LLM provider (Ollama, OpenAI-compatible) to run SceneTagger
- CueSheetGenerator output needs to be consumed by the music player

## 6. Decision Points

| Decision | Options | Recommendation |
|----------|---------|---------------|
| Kokoro runtime | ONNX WASM (`kokoro-js`) vs PyTorch sidecar | Start with sidecar (already running on 8880), add WASM later for self-contained binary |
| Voice selector location | TTSPanel vs TTSPlayerSheet only | Both — settings for initial config, player for quick switching |
| Music playback | YouTube IFrame API vs yt-dlp + local file | IFrame API (simpler, official, no ToS issues) — EQ ducking limited to desktop |
| Scene tagger backend | Ollama local vs OpenAI API | Use injected runner (configurable), default to Ollama for privacy |
| CORS proxy | Next.js API route vs server config | API route (works without user config) |

## 7. File Map

```
apps/readest-app/
├── src/
│   ├── app/api/tts/kokoro/route.ts          ← CORS proxy (NEW)
│   ├── components/
│   │   ├── settings/
│   │   │   ├── SettingsDialog.tsx            ← Panel registry (MODIFIED)
│   │   │   ├── TTSPanel.tsx                 ← Needs engine/voice selector
│   │   │   ├── MusicSettingsPanel.tsx        ← NEW
│   │   │   └── VoiceBlendPanel.tsx           ← NEW
│   │   └── reader/
│   │       └── SceneEditor.tsx               ← NEW
│   ├── services/
│   │   ├── tts/
│   │   │   ├── TTSController.ts             ← Kokoro wiring (MODIFIED)
│   │   │   ├── KokoroTTSClient.ts            ← NEW
│   │   │   └── VoiceBlendEngine.ts           ← NEW
│   │   ├── music/
│   │   │   ├── YTMusicService.ts            ← NEW
│   │   │   ├── YTPlayerWrapper.ts           ← NEW
│   │   │   ├── VolumeDucker.ts              ← NEW
│   │   │   └── EQDucker.ts                  ← NEW
│   │   ├── scene/
│   │   │   ├── types.ts, ChapterCache.ts, SceneTagger.ts
│   │   │   ├── CueSheetGenerator.ts, prompt.md
│   │   │   └── index.ts
│   │   ├── fallback/
│   │   │   └── FallbackManager.ts
│   │   └── commandRegistry.ts                ← MODIFIED
│   └── __tests__/services/
│       ├── YTMusicService.test.ts            ← REWRITTEN
│       └── volume-ducker.test.ts             ← REWRITTEN
└── next.config.mjs                          ← MODIFIED (rewrite removed, API route used instead)
```

## 8. Prerequisites for Running

- **Node.js**: v22+
- **pnpm**: v11+
- **Kokoro model**: running on `localhost:8880` with `/v1/audio/speech` endpoint
- **Browser**: Firefox/Zen (warns about scroll-linked effects, but works)
- **Ports**: 3002 (Next.js), 8880 (Kokoro), 3000 (AdGuard — conflict!), 3001 (Open WebUI — conflict!)
