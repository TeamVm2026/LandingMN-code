
import sharp from 'sharp';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

interface FileVerdict {
  name: string;
  ok: boolean;
  detail: string;
}

async function readRaw(file: string): Promise<RawImage> {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function listPngs(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`каталог не найден: ${dir}`);
  }
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.png'))
    .sort();
}

function diffPixels(a: RawImage, b: RawImage): { pixels: number; maxChannelDelta: number } {
  const channels = a.channels;
  const total = a.width * a.height;
  let pixels = 0;
  let maxChannelDelta = 0;
  for (let p = 0; p < total; p += 1) {
    const at = p * channels;
    let differs = false;
    for (let c = 0; c < channels; c += 1) {
      const delta = Math.abs(a.data[at + c]! - b.data[at + c]!);
      if (delta > 0) {
        differs = true;
        if (delta > maxChannelDelta) maxChannelDelta = delta;
      }
    }
    if (differs) pixels += 1;
  }
  return { pixels, maxChannelDelta };
}

async function main(): Promise<void> {
  const [dirA, dirB] = process.argv.slice(2);
  if (!dirA || !dirB) {
    console.error('usage: node --experimental-strip-types scripts/compare-screens.ts <dirA> <dirB>');
    process.exit(1);
  }

  const filesA = listPngs(dirA);
  const filesB = new Set(listPngs(dirB));

  if (filesA.length === 0) {
    console.error(`FAIL: в ${dirA} нет ни одного PNG — сравнивать нечего.`);
    process.exit(1);
  }

  const verdicts: FileVerdict[] = [];

  for (const name of filesA) {
    if (!filesB.has(name)) {
      verdicts.push({ name, ok: false, detail: `ОТСУТСТВУЕТ в ${dirB}` });
      continue;
    }
    const a = await readRaw(path.join(dirA, name));
    const b = await readRaw(path.join(dirB, name));

    if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) {
      verdicts.push({
        name,
        ok: false,
        detail:
          `РАЗНЫЙ РАЗМЕР: ${a.width}x${a.height}x${a.channels} против ` +
          `${b.width}x${b.height}x${b.channels}`,
      });
      continue;
    }

    const { pixels, maxChannelDelta } = diffPixels(a, b);
    const totalPixels = a.width * a.height;
    verdicts.push({
      name,
      ok: pixels === 0,
      detail:
        `${a.width}x${a.height} — расходящихся пикселей ${pixels} из ${totalPixels}` +
        (pixels === 0 ? '' : ` (${((pixels / totalPixels) * 100).toFixed(4)}%, макс. отклонение по каналу ${maxChannelDelta})`),
    });
  }

  for (const name of filesB) {
    if (!filesA.includes(name)) {
      verdicts.push({ name, ok: false, detail: `ОТСУТСТВУЕТ в ${dirA}` });
    }
  }

  verdicts.sort((x, y) => x.name.localeCompare(y.name));

  console.log(`A: ${dirA}`);
  console.log(`B: ${dirB}\n`);
  for (const v of verdicts) {
    console.log(`${v.ok ? 'OK  ' : 'FAIL'}  ${v.name.padEnd(28)} ${v.detail}`);
  }

  const failed = verdicts.filter((v) => !v.ok);
  console.log(
    `\n${failed.length === 0 ? 'PASS' : 'FAIL'}: ${verdicts.length - failed.length}/${verdicts.length} ` +
      'файлов совпали попиксельно.',
  );
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
