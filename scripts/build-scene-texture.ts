
import sharp from 'sharp';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_OUT = 'src/assets/media/scene-texture.webp';

const SIZE = 1024;

const BLUR_SIGMA = SIZE * (40 / 1536);

const SMOOTH_SIGMA = 1.6;

const DEFAULT_GAIN = 2;

const CROSS_FADE = 0.25;

const SCENE_TONE: [number, number, number] = [16, 17, 25];
const TEXTURE_DEPTH = 0.9;
const TEXTURE_KNEE = 2.5;

const QUALITY = 45;

interface Options {
  input: string;
  out: string;
  gain: number;
}

function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  let out = DEFAULT_OUT;
  let gain = DEFAULT_GAIN;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`У флага ${arg} нет значения.`);
      i += 1;
      return value;
    };
    if (arg === '--out') out = next();
    else if (arg === '--gain') gain = Number(next());
    else if (arg.startsWith('--')) throw new Error(`Неизвестный флаг: ${arg}`);
    else positional.push(arg);
  }

  const input = positional[0];
  if (input === undefined) {
    throw new Error(
      'Не указан исходник.\n' +
        'Запуск: npm run media:texture -- <исходник> [--out <файл>] [--gain N]\n' +
        'Плита генератора в репозиторий не кладётся — путь передаётся аргументом ' +
        '(происхождение и промпт: docs/media-credits.md).',
    );
  }
  if (!Number.isFinite(gain) || gain <= 0) {
    throw new Error(`--gain ожидает положительное число, получено «${gain}».`);
  }
  return { input, out, gain };
}

function fade(distance: number, span: number): number {
  return 0.5 * (1 + Math.cos(Math.PI * Math.min(1, distance / span)));
}

function blurWrapped(map: Float32Array, size: number, sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let norm = 0;
  for (let i = -radius; i <= radius; i += 1) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    norm += v;
  }
  for (let i = 0; i < kernel.length; i += 1) kernel[i]! /= norm;

  const pass = (src: Float32Array, horizontal: boolean): Float32Array => {
    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y += 1)
      for (let x = 0; x < size; x += 1) {
        let acc = 0;
        for (let i = -radius; i <= radius; i += 1) {
          const xx = horizontal ? (((x + i) % size) + size) % size : x;
          const yy = horizontal ? y : (((y + i) % size) + size) % size;
          acc += src[yy * size + xx]! * kernel[i + radius]!;
        }
        out[y * size + x] = acc;
      }
    return out;
  };
  return pass(pass(map, true), false);
}

function wrapped(map: Float32Array, size: number, x: number, y: number): number {
  const xx = ((x % size) + size) % size;
  const yy = ((y % size) + size) % size;
  return map[yy * size + xx]!;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(projectRoot, opts.input);
  const outPath = path.resolve(projectRoot, opts.out);
  const meta = await sharp(inputPath, { limitInputPixels: false }).metadata();

  const base = sharp(inputPath, { limitInputPixels: false }).resize(SIZE, SIZE, { fit: 'fill' }).removeAlpha();
  const sharpPixels = await base.clone().raw().toBuffer();
  const blurred = await base.clone().blur(BLUR_SIGMA).raw().toBuffer();

  const curved = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i += 1) {
    const l =
      0.2126 * (sharpPixels[i * 3]! - blurred[i * 3]!) +
      0.7152 * (sharpPixels[i * 3 + 1]! - blurred[i * 3 + 1]!) +
      0.0722 * (sharpPixels[i * 3 + 2]! - blurred[i * 3 + 2]!);
    curved[i] = Math.tanh((l * opts.gain) / TEXTURE_KNEE);
  }

  const half = SIZE / 2;
  const rolled = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y += 1)
    for (let x = 0; x < SIZE; x += 1) rolled[y * SIZE + x] = wrapped(curved, SIZE, x + half, y + half);

  const span = Math.round(SIZE * CROSS_FADE);
  const seamless = Float32Array.from(rolled);
  for (let y = 0; y < SIZE; y += 1)
    for (let x = 0; x < SIZE; x += 1) {
      const k = Math.max(fade(Math.abs(x - half), span), fade(Math.abs(y - half), span));
      if (k <= 0.001) continue;
      const mirror = wrapped(rolled, SIZE, 2 * half - x, 2 * half - y);
      const i = y * SIZE + x;
      seamless[i] = rolled[i]! * (1 - k * 0.5) + mirror * (k * 0.5);
    }

  const smoothed = blurWrapped(seamless, SIZE, SMOOTH_SIGMA);

  let curveSum = 0;
  for (let i = 0; i < smoothed.length; i += 1) curveSum += smoothed[i]!;
  const curveMean = curveSum / smoothed.length;

  const rgb = Buffer.alloc(SIZE * SIZE * 3);
  for (let i = 0; i < SIZE * SIZE; i += 1) {
    const k = 1 + TEXTURE_DEPTH * (smoothed[i]! - curveMean);
    for (let c = 0; c < 3; c += 1) {
      const v = SCENE_TONE[c]! * k;
      rgb[i * 3 + c] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
    }
  }

  await sharp(rgb, { raw: { width: SIZE, height: SIZE, channels: 3 } })
    .webp({ quality: QUALITY, effort: 6 })
    .toFile(outPath);

  const decoded = await sharp(outPath).raw().toBuffer();
  const lum = new Float32Array(SIZE * SIZE);
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < SIZE * SIZE; i += 1) {
    const v = 0.2126 * decoded[i * 3]! + 0.7152 * decoded[i * 3 + 1]! + 0.0722 * decoded[i * 3 + 2]!;
    lum[i] = v;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / lum.length;
  let variance = 0;
  for (let i = 0; i < lum.length; i += 1) variance += (lum[i]! - mean) ** 2;
  const stdev = Math.sqrt(variance / lum.length);

  const perUnit =
    ((0.2126 * SCENE_TONE[0]! + 0.7152 * SCENE_TONE[1]! + 0.0722 * SCENE_TONE[2]!) * TEXTURE_DEPTH) /
    TEXTURE_KNEE;

  let seamMax = 0;
  let seamSum = 0;
  let seamCount = 0;
  for (let y = 0; y < SIZE; y += 1) {
    const d = Math.abs(lum[y * SIZE]! - lum[y * SIZE + SIZE - 1]!);
    seamMax = Math.max(seamMax, d);
    seamSum += d;
    seamCount += 1;
  }
  for (let x = 0; x < SIZE; x += 1) {
    const d = Math.abs(lum[x]! - lum[(SIZE - 1) * SIZE + x]!);
    seamMax = Math.max(seamMax, d);
    seamSum += d;
    seamCount += 1;
  }

  const quarters: number[] = [];
  for (let qy = 0; qy < 2; qy += 1)
    for (let qx = 0; qx < 2; qx += 1) {
      let acc = 0;
      let n = 0;
      for (let y = qy * half; y < (qy + 1) * half; y += 4)
        for (let x = qx * half; x < (qx + 1) * half; x += 4) {
          acc += lum[y * SIZE + x]!;
          n += 1;
        }
      quarters.push(acc / n);
    }
  const quarterSpread = Math.max(...quarters) - Math.min(...quarters);

  let neighbour = 0;
  let neighbourCount = 0;
  for (let y = 0; y < SIZE; y += 1)
    for (let x = 1; x < SIZE; x += 1) {
      neighbour += Math.abs(lum[y * SIZE + x]! - lum[y * SIZE + x - 1]!);
      neighbourCount += 1;
    }
  const neighbourMean = neighbour / neighbourCount;
  const bytes = (await stat(outPath)).size;

  const u = (value: number): string => (value / perUnit).toFixed(2);
  console.log(
    `фактура сцены: плита ${meta.width}x${meta.height} → плитка ${SIZE}x${SIZE}, ` +
      `${(bytes / 1024).toFixed(1)} КБ (усиление ${opts.gain}, размытие σ${BLUR_SIGMA.toFixed(1)}, ` +
      `растворение креста ${(CROSS_FADE * 100).toFixed(0)} %, кривая ±${TEXTURE_DEPTH} при колене ${TEXTURE_KNEE}, q${QUALITY})`,
  );
  console.log(
    `  средняя яркость плитки ${mean.toFixed(2)} при плато сцены ` +
      `${(0.2126 * SCENE_TONE[0]! + 0.7152 * SCENE_TONE[1]! + 0.0722 * SCENE_TONE[2]!).toFixed(2)} ` +
      '← слой не двигает тон плато',
  );
  console.log(
    `  стык: макс ${u(seamMax)}, средний ${u(seamSum / seamCount)} ед. отклонения ` +
      `(${(seamSum / seamCount).toFixed(2)} яркости плитки)`,
  );
  console.log(
    `  обычная разница соседних пикселей внутри плитки: ${u(neighbourMean)} ед. отклонения ` +
      `(${neighbourMean.toFixed(2)} яркости)  ← со стыком выше сравнивать здесь`,
  );
  console.log(
    `  разброс тона между четвертями: ${u(quarterSpread)} ед. отклонения` +
      '  ← это и есть видимость сетки',
  );
  console.log(
    `  размах ${u(max - min)}, ср.кв.отклонение ${u(stdev)} ед. отклонения ` +
      `(${(max - min).toFixed(1)} и ${stdev.toFixed(2)} яркости плитки)`,
  );
  console.log(
    `  вклад в страницу = прозрачность слоя × ${stdev.toFixed(2)} (типично) ` +
      `и × ${(max - mean).toFixed(1)} (самый светлый пиксель плитки)`,
  );
}

await main();
