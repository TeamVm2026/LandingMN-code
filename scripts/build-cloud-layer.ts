
import sharp from 'sharp';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FIELD = 0.025;

const FEATHER = 0.06;

const DEFAULT_QUALITY = 68;
const DEFAULT_ALPHA_QUALITY = 62;
const DEFAULT_OUT = 'src/assets/media/client-clouds-group.webp';

const BACKGROUND_QUANTILE = 0.25;

function smoothstep(t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

function ramp(index: number, size: number, feather: number): number {
  if (feather <= 0) return 1;
  const fromStart = (index + 0.5) / feather;
  const fromEnd = (size - index - 0.5) / feather;
  return smoothstep(Math.min(fromStart, fromEnd));
}

interface Options {
  input: string;
  out: string;
  width: number | null;
  quality: number;
  alphaQuality: number;
}

function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  let out = DEFAULT_OUT;
  let width: number | null = null;
  let quality = DEFAULT_QUALITY;
  let alphaQuality = DEFAULT_ALPHA_QUALITY;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`У флага ${arg} нет значения.`);
      i += 1;
      return value;
    };
    if (arg === '--out') out = next();
    else if (arg === '--width') width = Number(next());
    else if (arg === '--quality') quality = Number(next());
    else if (arg === '--alpha-quality') alphaQuality = Number(next());
    else if (arg.startsWith('--')) throw new Error(`Неизвестный флаг: ${arg}`);
    else positional.push(arg);
  }

  const input = positional[0];
  if (input === undefined) {
    throw new Error(
      'Не указана плита.\n' +
        'Запуск: npm run media:clouds -- <плита> [--out <файл>] [--width N]\n' +
        'Плиты 4K в репозиторий не кладутся — путь к исходнику передаётся аргументом.',
    );
  }
  if (width !== null && (!Number.isFinite(width) || width < 64)) {
    throw new Error(`--width ожидает число не меньше 64, получено «${width}».`);
  }
  return { input, out, width, quality, alphaQuality };
}

function alphaFromLuminance(grey: Buffer): Uint8Array {
  const sorted = Uint8Array.from(grey).sort();
  const floor = sorted[Math.round(sorted.length * BACKGROUND_QUANTILE)] ?? 0;
  const span = Math.max(1, 255 - floor);
  const alpha = new Uint8Array(grey.length);
  for (let i = 0; i < grey.length; i += 1) {
    const v = ((grey[i]! - floor) / span) * 255;
    alpha[i] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
  }
  return alpha;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(projectRoot, opts.input);
  const outPath = path.resolve(projectRoot, opts.out);

  const meta = await sharp(inputPath, { limitInputPixels: false }).metadata();
  const canvasWidth = opts.width ?? meta.width ?? 0;
  if (canvasWidth < 64) throw new Error(`Не удалось определить ширину плиты ${opts.input}.`);

  const padX = Math.round(FIELD * canvasWidth);
  const contentWidth = canvasWidth - 2 * padX;

  const { data, info } = await sharp(inputPath, { limitInputPixels: false })
    .resize({ width: contentWidth, kernel: 'lanczos3' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const C = info.channels;

  let opaque = true;
  for (let i = 0; i < W * H && opaque; i += 1) if (data[i * C + 3]! !== 255) opaque = false;

  let alpha: Uint8Array;
  let mode: string;
  let floorNote = '';
  if (opaque) {

    const grey = await sharp(data, { raw: { width: W, height: H, channels: C } })
      .removeAlpha()
      .greyscale()
      .toColourspace('b-w')
      .raw()
      .toBuffer();
    alpha = alphaFromLuminance(grey);
    mode = 'альфа выведена из яркости';
    const sorted = Uint8Array.from(grey).sort();
    floorNote = `, порог фона ${sorted[Math.round(sorted.length * BACKGROUND_QUANTILE)]}/255`;
  } else {
    alpha = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i += 1) alpha[i] = data[i * C + 3]!;
    mode = 'альфа плиты сохранена';
  }

  const featherX = Math.round(FEATHER * W);
  const featherY = Math.round(FEATHER * H);
  const rampX = new Float32Array(W);
  const rampY = new Float32Array(H);
  for (let x = 0; x < W; x += 1) rampX[x] = ramp(x, W, featherX);
  for (let y = 0; y < H; y += 1) rampY[y] = ramp(y, H, featherY);

  const rgba = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    const ky = rampY[y]!;
    for (let x = 0; x < W; x += 1) {
      const i = y * W + x;
      rgba[i * 4] = data[i * C]!;
      rgba[i * 4 + 1] = data[i * C + 1]!;
      rgba[i * 4 + 2] = data[i * C + 2]!;
      rgba[i * 4 + 3] = Math.round(alpha[i]! * ky * rampX[x]!);
    }
  }

  const padY = Math.round((H * FIELD) / (1 - 2 * FIELD));
  await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
    .extend({
      top: padY,
      bottom: padY,
      left: padX,
      right: padX,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp({ quality: opts.quality, alphaQuality: opts.alphaQuality, effort: 6 })
    .toFile(outPath);

  const outMeta = await sharp(outPath).metadata();
  const bytes = (await stat(outPath)).size;
  console.log(
    `облака: плита ${meta.width}x${meta.height} → кадр ${outMeta.width}x${outMeta.height}, ` +
      `${(bytes / 1024).toFixed(0)} КБ (${mode}${floorNote}; ` +
      `содержимое ${W}x${H}, растушёвка ${(FEATHER * 100).toFixed(1)} % = ${featherX}x${featherY} px, ` +
      `поле ${(FIELD * 100).toFixed(1)} % = ${padX}x${padY} px по каждой кромке)`,
  );
}

await main();
