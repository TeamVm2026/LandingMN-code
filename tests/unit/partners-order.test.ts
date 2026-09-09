
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();

function read(rel: string): string {
  return readFileSync(path.join(root, rel), 'utf8');
}

function peopleIds(): string[] {
  const src = read('src/config/index.ts');
  const block = src.match(/people:\s*Object\.freeze\(\[([\s\S]*?)\]\)/);
  assert.ok(block, 'в src/config/index.ts не найден config.partners.people');
  const ids = [...block[1]!.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]!);

  assert.equal(ids.length, 4, `разбор people вернул ${ids.length} имён вместо четырёх`);
  return ids;
}

function phoneOrderIds(): string[] {
  const src = read('src/config/index.ts');

  const block = src.match(/phoneOrder:\s*Object\.freeze\(\[([\s\S]*?)\]\s*(?:as const\s*)?\)/);
  assert.ok(block, 'в src/config/index.ts не найден config.partners.phoneOrder');
  const ids = [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  assert.equal(ids.length, 4, `разбор phoneOrder вернул ${ids.length} имён вместо четырёх`);
  return ids;
}

function pipelineRowOrder(): string[] {
  const src = read('scripts/prepare-media.ts');
  const block = src.match(/const PHONE_ROW_ORDER\s*=\s*\[([\s\S]*?)\]\s*as const/);
  assert.ok(block, 'в scripts/prepare-media.ts не найден PHONE_ROW_ORDER');
  const ids = [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  assert.equal(ids.length, 4, `разбор PHONE_ROW_ORDER вернул ${ids.length} имён вместо четырёх`);
  return ids;
}

test('⛔ телефонный порядок конфига и конвейера совпадают', () => {
  assert.deepEqual(
    pipelineRowOrder(),
    phoneOrderIds(),
    'PHONE_ROW_ORDER в scripts/prepare-media.ts разошёлся с config.partners.phoneOrder. ' +
      'Мастера бюстов испечены под ЧУЖУЮ сторону: фигура уйдёт резаной кромкой в текст. ' +
      'Приведите списки в согласие и перезапустите конвейер: ' +
      'node --experimental-strip-types scripts/prepare-media.ts --only client-partner',
  );
});

test('⛔ телефонный порядок — перестановка того же состава, а не другой набор', () => {
  const people = peopleIds();
  const phone = phoneOrderIds();
  assert.deepEqual(
    [...phone].sort(),
    [...people].sort(),
    'phoneOrder и people описывают разные наборы людей: кто-то потеряется или задвоится',
  );
});

test('⛔ два порядка РАЗНЫЕ, иначе развилка Д-27 отменена молча', () => {

  assert.notDeepEqual(
    phoneOrderIds(),
    peopleIds(),
    'phoneOrder совпал с people. Либо Д-27 отменён (тогда правьте замки явно, ' +
      'а не через совпадение), либо один из списков переставили молча',
  );
});

test('⛔ порядок колонок десктопа в CSS равен порядку четвертей холста', () => {

  const css = read('src/components/Partners.astro');
  const people = peopleIds();
  for (const [i, id] of people.entries()) {
    const rule = new RegExp(
      `\\.partners-person--${id}\\s*\\{[^}]*grid-column:\\s*${i + 1}\\s*;`,
    );
    assert.match(
      css,
      rule,
      `у .partners-person--${id} нет grid-column: ${i + 1} — колонка десктопа ` +
        `разошлась с позицией человека в config.partners.people`,
    );
  }

  assert.match(
    css,
    /\.partners-person\s*\{\s*grid-row:\s*1\s*;/,
    'у .partners-person нет grid-row: 1 в десктопной ветке — имена развалятся на две строки',
  );
});

async function maskAngle(file: string): Promise<number> {
  const { data, info } = await sharp(path.join(root, file))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  let sw = 0;
  let mx = 0;
  let my = 0;
  const pts: [number, number, number][] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = data[(y * W + x) * C + 3]!;
      if (a < 16) continue;
      pts.push([x, y, a]);
      sw += a;
      mx += x * a;
      my += y * a;
    }
  }
  assert.ok(sw > 0, `маска ${file} пуста`);
  mx /= sw;
  my /= sw;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y, w] of pts) {
    const dx = x - mx;
    const dy = y - my;
    sxx += w * dx * dx;
    sxy += w * dx * dy;
    syy += w * dy * dy;
  }
  sxx /= sw;
  sxy /= sw;
  syy /= sw;
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  let vx = sxy;
  let vy = l1 - sxx;
  if (Math.abs(sxy) < 1e-9) {
    vx = 1;
    vy = 0;
  }
  const n = Math.hypot(vx, vy);
  vx /= n;
  vy /= n;
  if (vx < 0) {
    vx = -vx;
    vy = -vy;
  }
  return (-Math.atan2(vy, vx) * 180) / Math.PI;
}

const SOURCE_TILT: Record<string, number> = {
  lexor2k: -3.65,
  newsac: 0.95,
  maaraamn: 8.02,
  zilkenberg: 0.82,
};

function rotationFromPipeline(): Record<string, number> {
  const src = read('scripts/prepare-media.ts');
  const block = src.match(/const CLIENT_NAME_MASKS[\s\S]*?\]\.map\(/);
  assert.ok(block, 'в scripts/prepare-media.ts не найден список CLIENT_NAME_MASKS');
  const out: Record<string, number> = {};
  for (const m of block[0]!.matchAll(
    /person:\s*'([^']+)'[^}]*?rotateDeg:\s*(-?[\d.]+)/g,
  )) {
    out[m[1]!] = Number(m[2]);
  }
  assert.equal(
    Object.keys(out).length,
    4,
    `разбор rotateDeg вернул ${Object.keys(out).length} значений вместо четырёх`,
  );
  return out;
}

test('⛔ доворот из конвейера доехал до самой маски', async () => {
  const rotation = rotationFromPipeline();
  for (const [person, source] of Object.entries(SOURCE_TILT)) {
    const want = source + rotation[person]!;
    const got = await maskAngle(`src/assets/media/client-name-${person}.webp`);
    assert.ok(
      Math.abs(got - want) <= 0.2,
      `маска ника «${person}» наклонена на ${got.toFixed(2)}°, а исходник ${source}° ` +
        `плюс доворот ${rotation[person]}° дают ${want.toFixed(2)}°. Скорее всего маска ` +
        'собрана старым конвейером. Перезапустите: ' +
        'node --experimental-strip-types scripts/prepare-media.ts --only client-name',
    );
  }
});

test('⛔ доворот вообще есть: два имени из четырёх повёрнуты', () => {

  const rotation = rotationFromPipeline();
  const spun = Object.entries(rotation).filter(([, deg]) => Math.abs(deg) >= 0.5);
  assert.equal(
    spun.length,
    2,
    `повёрнутых имён ${spun.length} вместо двух: ${JSON.stringify(rotation)}. ` +
      'Порог применения 0,5° записан в DESIGN-NOTES захода: ниже него доворот ' +
      'неотличим от шума замера макета.',
  );
  assert.ok(
    Math.abs(rotation.lexor2k!) > 5,
    `у lexor2k доворот ${rotation.lexor2k}°, а жалоба заказчика была про ` +
      'ПРОТИВОПОЛОЖНЫЙ знак наклона: исходник −3,65°, макет +6,13°',
  );
});

test('⛔ пропорция маски в CSS равна пропорции самого файла', async () => {

  const css = read('src/components/Partners.astro');
  for (const person of Object.keys(SOURCE_TILT)) {
    const rule = new RegExp(
      `\\.partners-name--${person}\\s*\\{[^}]*aspect-ratio:\\s*(\\d+)\\s*/\\s*(\\d+)\\s*;`,
    );
    const m = css.match(rule);
    assert.ok(m, `у .partners-name--${person} не найден aspect-ratio`);
    const meta = await sharp(path.join(root, `src/assets/media/client-name-${person}.webp`)).metadata();
    assert.equal(
      `${m[1]}/${m[2]}`,
      `${meta.width}/${meta.height}`,
      `.partners-name--${person}: в CSS ${m[1]}/${m[2]}, а файл ${meta.width}x${meta.height}`,
    );
  }
});
