const VOICEBOX_URL = 'http://localhost:17600';

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
    const voice = body.voice || 'af_heart';
    const text = body.input || '';

    // 1. Fetch profiles to find the matching preset voice
    const profilesResp = await fetch(`${VOICEBOX_URL}/profiles`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!profilesResp.ok) {
      return new Response('Failed to fetch Voicebox profiles', { status: 502 });
    }
    const profiles = (await profilesResp.json()) as VoiceboxProfile[];
    const profile =
      profiles.find((p) => p.preset_voice_id === voice && p.preset_engine === 'kokoro') ||
      profiles.find((p) => p.preset_voice_id === 'af_heart');

    if (!profile) {
      return new Response(`Voice profile for preset '${voice}' not found`, { status: 404 });
    }

    // 2. Stream audio from Voicebox
    const generateResp = await fetch(`${VOICEBOX_URL}/generate/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile_id: profile.id,
        text: text,
        language: profile.language || 'en',
        engine: 'kokoro',
        normalize: true,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!generateResp.ok) {
      const errText = await generateResp.text();
      return new Response(`Voicebox generation failed: ${errText}`, {
        status: generateResp.status,
      });
    }

    const audio = await generateResp.arrayBuffer();
    return new Response(audio, {
      status: 200,
      headers: {
        'Content-Type': 'audio/wav',
      },
    });
  } catch (err: unknown) {
    console.error('[Kokoro Proxy] POST failed:', err);
    return new Response(err instanceof Error ? err.message : 'Internal server error', {
      status: 500,
    });
  }
}

export async function OPTIONS() {
  try {
    const resp = await fetch(`${VOICEBOX_URL}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      return new Response(null, { status: 204 });
    }
  } catch (err) {
    console.error('[Kokoro Proxy] OPTIONS health check failed:', err);
  }
  return new Response(null, { status: 503 });
}
