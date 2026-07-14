import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';

export async function POST(req: NextRequest) {
  try {
    const { system, prompt } = await req.json();
    if (!prompt) {
      return NextResponse.json({ error: 'Missing prompt' }, { status: 400 });
    }

    const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;
    const result = execSync(`agy -p ${JSON.stringify(fullPrompt)}`, {
      timeout: 300000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
    });

    return NextResponse.json({ text: result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[API] agy call failed:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
