const VOICEBOX_URL = process.env['VOICEBOX_URL'] || 'http://localhost:17600';
const VIBEVOICE_SERVER_URL = process.env['VIBEVOICE_SERVER_URL'] || 'http://localhost:8880';

interface VoiceboxProfile {
  id: string;
  name: string;
  preset_engine?: string;
  preset_voice_id?: string;
  language?: string;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const voice = body.voice || 'vv_emma';
    const text = body.input || '';
    const quantization = body.quantization || 'q4_k';
    const model = body.model || 'cstr/vibevoice-realtime-0.5b-GGUF';

    // 1. Try Voicebox profile endpoint first
    try {
      const profilesResp = await fetch(`${VOICEBOX_URL}/profiles`, {
        signal: AbortSignal.timeout(3000),
      });
      if (profilesResp.ok) {
        const profiles = (await profilesResp.json()) as VoiceboxProfile[];
        const profile =
          profiles.find((p) => p.preset_voice_id === voice && p.preset_engine === 'vibevoice') ||
          profiles.find((p) => p.preset_engine === 'vibevoice') ||
          profiles[0];

        if (profile) {
          const generateResp = await fetch(`${VOICEBOX_URL}/generate/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              profile_id: profile.id,
              text: text,
              language: profile.language || 'en',
              engine: 'vibevoice',
              quantization: quantization,
              model: model,
              normalize: true,
            }),
            signal: AbortSignal.timeout(60000),
          });

          if (generateResp.ok) {
            const audio = await generateResp.arrayBuffer();
            return new Response(audio, {
              status: 200,
              headers: { 'Content-Type': 'audio/wav' },
            });
          }
        }
      }
    } catch {
      // Voicebox endpoint not active, fallback to direct VibeVoice/llama.cpp server
    }

    // 2. Direct OpenAI-compatible or local VibeVoice server endpoint
    const directEndpoint = `${VIBEVOICE_SERVER_URL}/v1/audio/speech`;
    const directResp = await fetch(directEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        quantization: quantization,
        input: text,
        voice: voice,
        response_format: 'wav',
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!directResp.ok) {
      const errText = await directResp.text().catch(() => '');
      return new Response(`VibeVoice generation failed: ${errText || directResp.statusText}`, {
        status: directResp.status,
      });
    }

    const audioBuf = await directResp.arrayBuffer();
    return new Response(audioBuf, {
      status: 200,
      headers: { 'Content-Type': 'audio/wav' },
    });
  } catch (err: unknown) {
    console.error('[VibeVoice Proxy] POST failed:', err);
    return new Response(err instanceof Error ? err.message : 'Internal server error', {
      status: 500,
    });
  }
}

export async function OPTIONS() {
  // Check Voicebox health or direct VibeVoice server health
  try {
    const resp = await fetch(`${VOICEBOX_URL}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      return new Response(null, { status: 204 });
    }
  } catch {
    // Ignore Voicebox error, check direct server
  }

  try {
    const resp = await fetch(`${VIBEVOICE_SERVER_URL}/v1/models`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      return new Response(null, { status: 204 });
    }
  } catch (err) {
    console.error('[VibeVoice Proxy] OPTIONS health check failed:', err);
  }

  return new Response(null, { status: 503 });
}
