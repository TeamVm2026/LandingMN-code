
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const projectRoot = path.resolve(import.meta.dirname, '..');
const publicDir = path.join(projectRoot, 'public');
const i18nDir = path.join(projectRoot, 'src/i18n');

const WIDTH = 1200;
const HEIGHT = 630;
const MARGIN = 80;
const MAX_TEXT_WIDTH = WIDTH - MARGIN * 2;

const BG_GRAD = ['#0a0c0c', '#07090b', '#071014'] as const;
const GOLD = '#f1c632';
const TEXT = '#f7f6f1';
const MUTED = '#a6adb7';
const LINE_STRONG = 'rgba(255,255,255,0.20)';

const FONT_STACK = "Arial, 'Segoe UI', 'Noto Sans', sans-serif";

type Locale = 'mn' | 'ru' | 'en';
const locales: Locale[] = ['mn', 'ru', 'en'];

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readLocaleJson(locale: Locale): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(i18nDir, `${locale}.json`), 'utf8'));
}

function readOgTitle(locale: Locale): string {
  const json = readLocaleJson(locale);
  const title = (json as { meta?: { og_title?: unknown } }).meta?.og_title;
  if (typeof title !== 'string' || !title.trim()) {
    throw new Error(`generate-og-images: missing meta.og_title in src/i18n/${locale}.json`);
  }
  return title;
}

function readDirectionNames(locale: Locale): string {
  const json = readLocaleJson(locale) as {
    cards?: Record<string, { name?: unknown } | undefined>;
  };
  const names = [json?.cards?.affiliate?.name, json?.cards?.bank?.name, json?.cards?.teamcash?.name];
  for (const [i, name] of names.entries()) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error(`generate-og-images: missing cards.*.name[${i}] in src/i18n/${locale}.json`);
    }
  }
  return names.join('  ·  ');
}

async function measureTextWidth(
  text: string,
  fontSize: number,
  weight: number,
  italic = false,
): Promise<number> {
  const probeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="${fontSize * 2}">
    <rect width="2000" height="${fontSize * 2}" fill="#000000"/>
    <text x="0" y="${fontSize * 1.4}" font-family="${FONT_STACK}" font-weight="${weight}" font-style="${italic ? 'italic' : 'normal'}" font-size="${fontSize}" fill="#ffffff">${escapeXml(text)}</text>
  </svg>`;
  const { info } = await sharp(Buffer.from(probeSvg))
    .trim({ background: '#000000', threshold: 10 })
    .toBuffer({ resolveWithObject: true });
  return info.width;
}

interface FitResult {
  lines: string[];
  fontSize: number;
  lineWidths: number[];
}

async function fitTitle(text: string, startSize: number, minSize: number): Promise<FitResult> {
  const words = text.split(' ').filter(Boolean);

  for (let size = startSize; size >= minSize; size -= 2) {
    const fullWidth = await measureTextWidth(text, size, 700);
    if (fullWidth <= MAX_TEXT_WIDTH) {
      return { lines: [text], fontSize: size, lineWidths: [fullWidth] };
    }

    if (words.length < 2) continue;

    let bestSplit = 1;
    let bestDelta = Infinity;
    let cumulative = 0;
    const totalLen = text.length;
    for (let i = 1; i < words.length; i++) {
      cumulative += words[i - 1].length + 1;
      const delta = Math.abs(cumulative - totalLen / 2);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestSplit = i;
      }
    }

    const line1 = words.slice(0, bestSplit).join(' ');
    const line2 = words.slice(bestSplit).join(' ');
    const [w1, w2] = await Promise.all([
      measureTextWidth(line1, size, 700),
      measureTextWidth(line2, size, 700),
    ]);
    if (w1 <= MAX_TEXT_WIDTH && w2 <= MAX_TEXT_WIDTH) {
      return { lines: [line1, line2], fontSize: size, lineWidths: [w1, w2] };
    }
  }

  const mid = Math.ceil(words.length / 2) || 1;
  const line1 = words.slice(0, mid).join(' ') || text;
  const line2 = words.slice(mid).join(' ');
  const [w1, w2] = await Promise.all([
    measureTextWidth(line1, minSize, 700),
    measureTextWidth(line2 || line1, minSize, 700),
  ]);
  return {
    lines: line2 ? [line1, line2] : [line1],
    fontSize: minSize,
    lineWidths: line2 ? [w1, w2] : [w1],
  };
}

function textLengthAttr(width: number): string {
  return width > MAX_TEXT_WIDTH
    ? ` textLength="${MAX_TEXT_WIDTH}" lengthAdjust="spacingAndGlyphs"`
    : '';
}

async function buildOgSvg(locale: Locale): Promise<string> {
  const title = readOgTitle(locale);
  const directionsLine = readDirectionNames(locale);

  const wordmarkSize = 68;
  const [melWidth] = await Promise.all([measureTextWidth('MEL', wordmarkSize, 800, true)]);

  const { lines, fontSize, lineWidths } = await fitTitle(title, 60, 34);
  const lineHeight = Math.round(fontSize * 1.22);

  const wordmarkY = MARGIN + wordmarkSize * 0.78;
  const titleStartY = wordmarkY + wordmarkSize * 0.62 + fontSize * 0.95;

  const titleTspans = lines
    .map((line, i) => {
      const y = titleStartY + i * lineHeight;
      const w = lineWidths[i];
      return `<text x="${MARGIN}" y="${y}" font-family="${FONT_STACK}" font-weight="700" font-size="${fontSize}" fill="${TEXT}"${textLengthAttr(w)}>${escapeXml(line)}</text>`;
    })
    .join('\n    ');

  const supportFontSize = 25;
  const supportY = HEIGHT - MARGIN;
  const dividerY = supportY - supportFontSize * 1.7;
  const dividerWidth = 64;
  const supportWidth = await measureTextWidth(directionsLine, supportFontSize, 700);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${BG_GRAD[0]}"/>
      <stop offset="52%" stop-color="${BG_GRAD[1]}"/>
      <stop offset="100%" stop-color="${BG_GRAD[2]}"/>
    </linearGradient>
    <radialGradient id="glowGrad" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="rgba(241,198,50,0.36)"/>
      <stop offset="67%" stop-color="rgba(241,198,50,0)"/>
    </radialGradient>
    <filter id="glowBlur" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="85"/>
    </filter>
    <pattern id="grid" width="42" height="42" patternUnits="userSpaceOnUse">
      <path d="M 42 0 L 0 0 0 42" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
    </pattern>
    <linearGradient id="gridMaskGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="1"/>
      <stop offset="55%" stop-color="#ffffff" stop-opacity="0.75"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <mask id="gridFade">
      <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#gridMaskGrad)"/>
    </mask>
  </defs>

  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bgGrad)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#grid)" mask="url(#gridFade)"/>
  <circle cx="${WIDTH - 60}" cy="70" r="420" fill="url(#glowGrad)" filter="url(#glowBlur)"/>

  <g>
    <text x="${MARGIN}" y="${wordmarkY}" font-family="${FONT_STACK}" font-weight="800" font-style="italic" font-size="${wordmarkSize}" letter-spacing="-2" fill="#ffffff">MEL</text>
    <text x="${MARGIN + melWidth}" y="${wordmarkY}" font-family="${FONT_STACK}" font-weight="800" font-style="italic" font-size="${wordmarkSize}" letter-spacing="-2" fill="${GOLD}">BET</text>
  </g>

  <g>
    ${titleTspans}
  </g>

  <g>
    <rect x="${MARGIN}" y="${dividerY}" width="${dividerWidth}" height="2" fill="${LINE_STRONG}"/>
    <text x="${MARGIN}" y="${supportY}" font-family="${FONT_STACK}" font-weight="700" font-size="${supportFontSize}" letter-spacing="0.5" fill="${MUTED}"${textLengthAttr(supportWidth)}>${escapeXml(directionsLine)}</text>
  </g>
</svg>`;
}

async function main() {
  for (const locale of locales) {
    const svg = await buildOgSvg(locale);
    const outPath = path.join(publicDir, `og-${locale}.png`);
    await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(outPath);
    const meta = await sharp(outPath).metadata();
    console.log(`wrote public/og-${locale}.png (${meta.width}x${meta.height})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
