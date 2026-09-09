
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const projectRoot = path.resolve(import.meta.dirname, '..');
const publicDir = path.join(projectRoot, 'public');

const sourceSvgPath = path.join(publicDir, 'favicon.svg');
const sourceSvg = readFileSync(sourceSvgPath);

const sourceSvgText = readFileSync(sourceSvgPath, 'utf8');

if (!/<rect[^>]*width="268"/.test(sourceSvgText)) {
  throw new Error(
    'generate-favicons: public/favicon.svg не содержит полноразмерной плитки — ' +
      'PNG-значки не поддерживают прозрачность в хроме браузера предсказуемо, ' +
      'знак обязан приходить с непрозрачным фоном.',
  );
}

const PNG_TARGETS: { file: string; size: number }[] = [
  { file: 'favicon-16x16.png', size: 16 },
  { file: 'favicon-32x32.png', size: 32 },
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'android-chrome-192x192.png', size: 192 },
  { file: 'android-chrome-512x512.png', size: 512 },
];

const ICO_SIZES = [16, 32];

async function rasterize(size: number): Promise<Buffer> {
  const density = Math.max(96, Math.round((size / 268) * 96 * 8));
  return sharp(sourceSvg, { density }).resize(size, size).png().toBuffer();
}

async function buildIco(sizes: number[]): Promise<Buffer> {
  const images: Buffer[] = [];

  for (const size of sizes) {
    const png = await rasterize(size);
    const { data } = await sharp(png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const xor = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
      const srcRow = (size - 1 - y) * size * 4;
      const dstRow = y * size * 4;
      for (let x = 0; x < size; x++) {
        const s = srcRow + x * 4;
        const d = dstRow + x * 4;
        xor[d] = data[s + 2];
        xor[d + 1] = data[s + 1];
        xor[d + 2] = data[s];
        xor[d + 3] = data[s + 3];
      }
    }

    const maskRowBytes = Math.ceil(size / 8 / 4) * 4;
    const mask = Buffer.alloc(maskRowBytes * size, 0);

    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(size, 4);
    header.writeInt32LE(size * 2, 8);
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(32, 14);
    header.writeUInt32LE(0, 16);
    header.writeUInt32LE(xor.length + mask.length, 20);

    images.push(Buffer.concat([header, xor, mask]));
  }

  const dirSize = 6 + sizes.length * 16;
  const dir = Buffer.alloc(dirSize);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(sizes.length, 4);

  let offset = dirSize;
  sizes.forEach((size, i) => {
    const e = 6 + i * 16;
    dir[e] = size === 256 ? 0 : size;
    dir[e + 1] = size === 256 ? 0 : size;
    dir[e + 2] = 0;
    dir[e + 3] = 0;
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(images[i].length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });

  return Buffer.concat([dir, ...images]);
}

async function main() {
  for (const { file, size } of PNG_TARGETS) {
    writeFileSync(path.join(publicDir, file), await rasterize(size));
    console.log(`wrote public/${file} (${size}x${size})`);
  }

  const ico = await buildIco(ICO_SIZES);
  writeFileSync(path.join(publicDir, 'favicon.ico'), ico);
  console.log(`wrote public/favicon.ico (${ICO_SIZES.join(', ')} — ${ico.length} bytes)`);

  const manifest = {
    name: 'MELBET Partners',
    short_name: 'MELBET Partners',
    icons: [
      { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
    ],

    theme_color: '#07090b',
    background_color: '#07090b',
    display: 'standalone',
  };
  writeFileSync(
    path.join(publicDir, 'site.webmanifest'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log('wrote public/site.webmanifest');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
