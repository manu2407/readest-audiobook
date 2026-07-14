export interface NarrationItem {
  name: string;
  text: string;
}

/**
 * Models occasionally wrap JSON in Markdown or return a partial list. Keep
 * playback faithful by accepting only the exact, ordered response requested.
 */
export const parseNarrationResponse = (response: string, input: NarrationItem[]): string[] => {
  let raw = response.trim();

  // Strip markdown code fences if present.
  const fenceMatch = raw.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch) {
    console.log('[parseNarrationResponse] Stripped markdown code fences');
    raw = fenceMatch[1]!.trim();
  }

  // Try parsing the whole response directly first.
  for (const candidate of [raw]) {
    try {
      const output = JSON.parse(candidate) as unknown;
      if (
        Array.isArray(output) &&
        output.length === input.length &&
        output.every(
          (item, index) =>
            typeof item === 'object' &&
            item !== null &&
            String((item as NarrationItem).name) === input[index]!.name &&
            typeof (item as NarrationItem).text === 'string',
        )
      ) {
        return output.map((item) => (item as NarrationItem).text);
      }
      console.warn(
        '[parseNarrationResponse] JSON valid but schema mismatch — length or field types wrong',
      );
    } catch (e) {
      console.log('[parseNarrationResponse] Direct JSON parse failed:', (e as Error)?.message);
    }
  }

  // Fallback: locate the outermost JSON array via bracket matching.
  try {
    const start = raw.indexOf('[');
    if (start < 0) {
      console.warn('[parseNarrationResponse] No array bracket found, returning input as-is');
      return input.map((item) => item.text);
    }
    let depth = 0;
    let end = -1;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i]!;
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end <= start) {
      console.warn('[parseNarrationResponse] Brackets unbalanced, returning input as-is');
      return input.map((item) => item.text);
    }
    const output = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (
      Array.isArray(output) &&
      output.length === input.length &&
      output.every(
        (item, index) =>
          typeof item === 'object' &&
          item !== null &&
          String((item as NarrationItem).name) === input[index]!.name &&
          typeof (item as NarrationItem).text === 'string',
      )
    ) {
      console.log('[parseNarrationResponse] Fallback bracket-matching succeeded');
      return output.map((item) => (item as NarrationItem).text);
    }
    console.warn('[parseNarrationResponse] Bracket-matched JSON schema mismatch');
  } catch (e) {
    console.warn('[parseNarrationResponse] Bracket-match fallback failed:', (e as Error)?.message);
  }

  console.warn('[parseNarrationResponse] All parsing failed — returning original input');
  return input.map((item) => item.text);
};

export const escapeNarrationForSSML = (text: string): string =>
  text
    .replace(/&(?!#\d+;|#x[\da-f]+;|[a-z][\da-z]+;)/gi, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
