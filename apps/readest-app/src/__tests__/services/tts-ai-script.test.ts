import { describe, expect, test } from 'vitest';
import { escapeNarrationForSSML, parseNarrationResponse } from '@/services/tts/aiScript';

describe('parseNarrationResponse', () => {
  const input = [
    { name: '0', text: 'First sentence.' },
    { name: '1', text: 'Second sentence.' },
  ];

  test('accepts a complete, ordered JSON response', () => {
    expect(
      parseNarrationResponse(
        '```json\n[{"name":"0","text":"First revised."},{"name":"1","text":"Second revised."}]\n```',
        input,
      ),
    ).toEqual(['First revised.', 'Second revised.']);
  });

  test('falls back to source text when the model changes the response shape or order', () => {
    expect(parseNarrationResponse('[{"name":"1","text":"Second revised."}]', input)).toEqual(
      input.map((item) => item.text),
    );
  });
});

describe('escapeNarrationForSSML', () => {
  test('keeps valid entities and escapes XML-significant model output', () => {
    expect(escapeNarrationForSSML('Fish & chips <today> &amp; tomorrow')).toBe(
      'Fish &amp; chips &lt;today&gt; &amp; tomorrow',
    );
  });
});
