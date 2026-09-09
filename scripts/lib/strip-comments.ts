
export function stripJsComments(text: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) out += text[k] === '\n' ? '\n' : ' ';
  };

  while (i < text.length) {
    const ch = text[i];

    if (quote) {
      if (ch === '\\') {
        out += '  ';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      out += ch;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }

    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}
