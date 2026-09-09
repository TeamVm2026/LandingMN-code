
import { access, mkdir, stat as statFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp, { type Sharp, type OverlayOptions } from 'sharp';

const projectRoot = path.resolve(import.meta.dirname, '..');
const outDir = path.join(projectRoot, 'src', 'assets', 'media');
const creditsPath = path.join(projectRoot, 'docs', 'media-credits.md');

const UA = 'LandingMN/1.0 (asset sourcing; one-off build script)';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url: string, attempts = 5): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.ok) return res;
      if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status} для ${url}`);
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(2000 * (i + 1));
  }
  throw new Error(`Не удалось скачать ${url}: ${lastError instanceof Error ? lastError.message : lastError}`);
}

interface RemovedCommonsFrame {

  note: string;

  descriptionUrl: string;

  license: string;

  artist: string;

  original: string;

  produced: string;
}

interface CommonsSource {

  removed?: RemovedCommonsFrame;
  slug: string;
  commonsTitle: string;

  width: number;
  height: number;

  focus: { x: number; y: number };

  place: { x: number; y: number };

  zoom: number;

  role: string;

  grade: 'blue-hour' | 'city-dusk';
}

const SOURCES: CommonsSource[] = [

  {
    slug: 'ub-downtown-dusk',
    commonsTitle: 'File:Downtown of Ulaanbaatar.jpg',

    width: 2000,
    height: 800,
    focus: { x: 0.5, y: 0.72 },
    place: { x: 0.5, y: 0.5 },
    zoom: 1,

    removed: {
      note: '⛔ УДАЛЁН ИЗ РЕПОЗИТОРИЯ 07.09.2026 — решение заказчика, дословно «удалять».',

      descriptionUrl: 'https://commons.wikimedia.org/wiki/File:Downtown_of_Ulaanbaatar.jpg',
      license: 'CC0',
      artist: 'Enkhgerele',
      original: '3024x4032',
      produced: '2000x800, 478 041 Б',
    },
    role:
      'Прежняя РАБОТА кадра: полоса перед блоком финального призыва — центр ' +
      'Улан-Батора в синий час; блок удалён решением заказчика Д-14 ' +
      '(26.08.2026), после чего кадр остался без единого потребителя. ' +
      'Файл восстановим из истории одной командой: ' +
      '`git show af79558:src/assets/media/ub-downtown-dusk.jpg > ' +
      'src/assets/media/ub-downtown-dusk.jpg` (af79558 — коммит перед ' +
      'удалением). Рецепт сборки в `scripts/prepare-media.ts` оставлен ' +
      'действующим намеренно.',
    grade: 'blue-hour',
  },
];

interface CropSpec {
  width: number;
  height: number;
  focus: { x: number; y: number };
  place: { x: number; y: number };
  zoom: number;
}

interface RemovedFrame {

  note: string;

  original: string;

  produced: string;
}

interface ClientSource extends CropSpec {

  clientProvided: true;

  removed?: RemovedFrame;
  slug: string;

  file: string;

  role: string;

  quality: number;

  flattenOver: string;
}

const CLIENT_PACK_DIR = 'Правки по дизайну с креативами';

const CLIENT_RECEIVED = '26.08.2026';

const CLIENT_RIGHTS = 'подтверждены заказчиком 26.08.2026, дословно «Ставим, права есть»';

const REPLACEMENT_PACK_DIR = 'Замена партнеров';

const REPLACEMENT_RECEIVED = '04.09.2026';

const REPLACEMENT_RIGHTS =
  'заказчик 04.09.2026, дословно «Я еще добавил новые фото партнеров (Папка ' +
  '«Замена партнеров»). Для пк и для мобильного. Файлы подписаны именами ' +
  'партнеров, расставь корректно их главное.» — слова «права есть» в этом ' +
  'сообщении нет; основание то же, что у пакета CLIENT_PACK_DIR: те же ' +
  'четверо партнёров, тот же лендинг MELBET.';

const CLIENT_SOURCES: ClientSource[] = [
  {

    clientProvided: true,
    slug: 'client-night-panorama',
    file: `${CLIENT_PACK_DIR}/фоны/bg-1.png`,
    width: 2400,
    height: 1018,
    focus: { x: 0.5, y: 0.5 },
    place: { x: 0.5, y: 0.5 },
    zoom: 1,
    role: 'Первый экран (десктоп): ночная панорама города с отражением в воде. Кадр заказчика, обещанная замена по CLIENT-EDITS §10.',
    quality: 84,
    flattenOver: '#07090b',
  },
  {

    clientProvided: true,
    slug: 'client-night-panorama-portrait',
    file: `${CLIENT_PACK_DIR}/фоны/bg-1.png`,
    width: 1200,
    height: 1500,

    focus: { x: 0.52, y: 0.44 },
    place: { x: 0.5, y: 0.26 },
    zoom: 1.35,
    role: 'Первый экран (телефон): вертикальный кроп той же ночной панорамы — силуэт города выше середины, отражение под текстом.',
    quality: 84,
    flattenOver: '#07090b',
  },
  {
    clientProvided: true,
    slug: 'client-city-haze',
    removed: {
      note:
        '⛔ УДАЛЁН ИЗ РЕПОЗИТОРИЯ 03.09.2026 вместе со всеми слоями-кадрами ниже ' +
        'первого экрана (заказчик: «Зачем мне столько фонов которые конфликтуют ' +
        'между собой?») — файла в `src/assets/media/` больше нет, запись о правах ' +
        'и происхождении сохранена как история.',
      original: '4154x1952, 9.04 МБ',
      produced: '1920x902, 64.0 КБ',
    },
    file: `${CLIENT_PACK_DIR}/фоны/bg-3.png`,
    width: 1920,
    height: 902,
    focus: { x: 0.5, y: 0.5 },
    place: { x: 0.5, y: 0.5 },
    zoom: 1,
    role: 'Прежняя роль: широкая полоса секции — город в дымке с сопками на горизонте. Кадр заказчика; запись о правах ниже остаётся в силе.',
    quality: 84,
    flattenOver: '#07090b',
  },
  {

    clientProvided: true,
    slug: 'client-tower-rays',
    removed: {
      note:
        '⛔ УДАЛЁН ИЗ РЕПОЗИТОРИЯ 03.09.2026 вместе со всеми слоями-кадрами ниже ' +
        'первого экрана — файла в `src/assets/media/` больше нет, запись о правах ' +
        'и происхождении сохранена как история.',
      original: '2632x3941, 5.80 МБ',
      produced: '1200x1797, 71.3 КБ',
    },
    file: `${CLIENT_PACK_DIR}/фоны/bg-4.png`,
    width: 1200,
    height: 1797,
    focus: { x: 0.5, y: 0.5 },
    place: { x: 0.5, y: 0.5 },
    zoom: 1,
    role: 'Прежняя роль: вертикальная секция — освещённая башня и диагональные лучи на почти плоском фоне. Кадр заказчика; порог 2/255 не прошёл (MAD 4,627), поэтому картинка, а не градиент.',
    quality: 84,
    flattenOver: '#07090b',
  },
  {
    clientProvided: true,
    slug: 'client-bokeh-hills',
    removed: {
      note:
        '⛔ УДАЛЁН ИЗ РЕПОЗИТОРИЯ 03.09.2026 вместе со всеми слоями-кадрами ниже ' +
        'первого экрана — файла в `src/assets/media/` больше нет, запись о правах ' +
        'и происхождении сохранена как история. Он был самой выбивающейся полосой ' +
        'страницы: замер 03.09.2026 дал ему rgb(101,77,53) при соседях около ' +
        'rgb(20,25,40), то есть тёплое пятно B−R = −48 посреди холодной страницы.',
      original: '3150x2807, 6.94 МБ',
      produced: '1920x1711, 90.5 КБ',
    },
    file: `${CLIENT_PACK_DIR}/фоны/bg-6.png`,
    width: 1920,
    height: 1711,
    focus: { x: 0.5, y: 0.5 },
    place: { x: 0.5, y: 0.5 },
    zoom: 1,
    role: 'Прежняя роль: секция с боке огней и сопками. Кадр заказчика; запись о правах ниже остаётся в силе.',
    quality: 84,
    flattenOver: '#07090b',
  },

  {
    clientProvided: true,
    slug: 'client-card-affiliate',
    removed: {
      note:
        '⛔ УДАЛЁН ИЗ РЕПОЗИТОРИЯ 04.09.2026 (заказчик: «И задний фон картинку тоже ' +
        'убери на этом блоке») — файла в `src/assets/media/` больше нет, запись о ' +
        'правах и происхождении сохранена как история.',
      original: '4000x3000, 8.08 МБ',
      produced: '1600x1200, 78.8 КБ',
    },
    file: `${CLIENT_PACK_DIR}/слайд 3/развернутые карточки/bg_Affiliate_big.png`,
    width: 1600,
    height: 1200,
    focus: { x: 0.5, y: 0.5 },
    place: { x: 0.5, y: 0.5 },
    zoom: 1,
    role: 'Прежняя роль: подложка карточки направления Affiliate — диагональный веер золотых росчерков. Состояния свёрнутая/активная/раскрытая — CSS-прозрачность этого же кадра.',
    quality: 76,
    flattenOver: '#12131a',
  },
  {
    clientProvided: true,
    slug: 'client-card-bank',
    removed: {
      note:
        '⛔ УДАЛЁН ИЗ РЕПОЗИТОРИЯ 04.09.2026 (заказчик: «И задний фон картинку тоже ' +
        'убери на этом блоке») — файла в `src/assets/media/` больше нет, запись о ' +
        'правах и происхождении сохранена как история.',
      original: '4000x3000, 8.77 МБ',
      produced: '1600x1200, 95.6 КБ',
    },
    file: `${CLIENT_PACK_DIR}/слайд 3/развернутые карточки/bg_BankTransfer_big.png`,
    width: 1600,
    height: 1200,
    focus: { x: 0.5, y: 0.5 },
    place: { x: 0.5, y: 0.5 },
    zoom: 1,
    role: 'Прежняя роль: подложка карточки направления Bank Transfer — скрещенные волны росчерков. Состояния — CSS-прозрачность этого же кадра.',
    quality: 76,
    flattenOver: '#12131a',
  },
  {
    clientProvided: true,

    slug: 'client-card-teamcash',
    removed: {
      note:
        '⛔ УДАЛЁН ИЗ РЕПОЗИТОРИЯ 04.09.2026 (заказчик: «И задний фон картинку тоже ' +
        'убери на этом блоке») — файла в `src/assets/media/` больше нет, запись о ' +
        'правах и происхождении сохранена как история.',
      original: '4000x3026, 7.91 МБ',
      produced: '1600x1210, 72.6 КБ',
    },
    file: `${CLIENT_PACK_DIR}/слайд 3/развернутые карточки/bg_TeamCash_big.png`,
    width: 1600,
    height: 1210,
    focus: { x: 0.5, y: 0.5 },
    place: { x: 0.5, y: 0.5 },
    zoom: 1,
    role: 'Прежняя роль: подложка карточки направления Team Cash — спираль росчерков. Состояния — CSS-прозрачность этого же кадра.',
    quality: 76,
    flattenOver: '#12131a',
  },
];

const CLIENT_GRADIENTS: { source: string; mad: number; css: string; note: string }[] = [
  {
    source: 'bg-2.png',
    mad: 1.752,
    css:
      'linear-gradient(180deg, rgb(7 9 11) 0%, rgb(26 30 44) 20%, rgb(23 27 41) 40%, ' +
      'rgb(20 25 39) 60%, rgb(17 22 36) 80%, rgb(7 9 11) 100%)',
    note: '3344×6054, 1,58 МБ. Вертикальный градиент без деталей.',
  },
  {
    source: 'bg-5.png',
    mad: 0.623,
    css:
      'linear-gradient(180deg, rgb(7 9 11) 0%, rgb(17 16 23) 20%, rgb(17 16 24) 40%, ' +
      'rgb(17 16 24) 60%, rgb(17 16 24) 80%, rgb(7 9 11) 100%)',
    note: '4138×6588, 2,95 МБ. Вертикальный градиент без деталей.',
  },
  {
    source: 'bg-7.png',
    mad: 0.755,
    css:
      'linear-gradient(180deg, rgb(7 9 11) 0%, rgb(11 11 16) 20%, rgb(15 15 24) 40%, ' +
      'rgb(17 16 24) 60%, rgb(17 16 24) 80%, rgb(17 16 24) 100%)',
    note: '4096×3286, 5,92 МБ. Плоский фон со слабым свечением сверху.',
  },
];

interface ClientGroupPart {

  slug: string;

  file: string;

  headH: number;

  top: number;

  cx: number;

  k: number;

  dy: number;
  dx: number;

  feather: number;
}

interface ClientGroupSource {
  slug: string;
  role: string;

  readyMaster?: string;

  width: number;
  height: number;

  headHeight: number;

  headTop: number;

  slots: number[];

  drawOrder: number[];

  bottomFade: number;
  quality: number;
  flattenOver: string;
  parts: ClientGroupPart[];
}

const CLIENT_GROUPS: ClientGroupSource[] = [
  {
    slug: 'client-partners-group',
    role:
      'Блок «Наши партнёры»: общий кадр четырёх блогеров ' +
      '4brata.png (1672×941, PNG с альфой), присланный заказчиком 04.09.2026, ' +
      'заменил слайд 6/Общий кадр.png. Порядок фигур слева направо теперь ' +
      'Newsac/MaaRaa MN/Zilkenberg/Lexor2k (было Lexor2k/MaaRaa MN/Zilkenberg/Newsac). ' +
      'История: до 04.09.2026 здесь стоял «Общий кадр.png» (6316×2229 с альфой), ' +
      'присланный 02.09.2026.',

    readyMaster: '4brata.png',

    width: 2400,

    height: 1351,
    headHeight: 252,
    headTop: 40,

    slots: [0.125, 0.375, 0.625, 0.875],

    drawOrder: [0, 3, 1, 2],

    bottomFade: 0.22,
    quality: 82,
    flattenOver: '#07090b',

    parts: [
      { slug: 'lexor2k',    file: 'lexor2k.png',    headH: 514, top: 37, cx: 663, k: 1, dy: 0, dx: 0, feather: 0 },
      { slug: 'newsac',     file: 'newsac.png',     headH: 476, top: 12, cx: 581, k: 1, dy: 0, dx: 0, feather: 0 },

      { slug: 'maaraamn',   file: 'MaaRaaMNN.png',  headH: 473, top: 7,  cx: 548, k: 1, dy: 0, dx: 0, feather: 0 },

      { slug: 'zilkenberg', file: 'zilkenberg.png', headH: 500, top: 0,  cx: 542, k: 1, dy: 0, dx: 0, feather: 0.05 },
    ],
  },
];

interface ClientBustSource {
  slug: string;

  person: string;
  role: string;

  width: number;
  height: number;

  headFraction: number;

  crownTop: number;

  outerSide: 'left' | 'right';

  headCenter: number;

  bottomFade: number;

  innerFade: number;
  quality: number;

  alphaQuality: number;
}

const BUST_CANVAS = { width: 960, height: 1400 } as const;

const PHONE_ROW_ORDER = ['lexor2k', 'newsac', 'maaraamn', 'zilkenberg'] as const;

const CLIENT_BUSTS: ClientBustSource[] = PHONE_ROW_ORDER.map((person, row) => ({
  person,

  outerSide: (row % 2 === 0 ? 'left' : 'right') as 'left' | 'right',
})).map(({ person, outerSide }) => ({
  slug: `client-partner-${person}`,
  person,
  role:
    'Блок «С нами уже сотрудничают», телефонная раскладка: одиночный портрет, ' +
    `фигура уходит за ${outerSide === 'left' ? 'левую' : 'правую'} кромку экрана.`,
  width: BUST_CANVAS.width,
  height: BUST_CANVAS.height,
  headFraction: 0.45,
  crownTop: 0.03,
  outerSide,
  headCenter: 0.42,

  bottomFade: 0.38,
  innerFade: 0.28,
  quality: 80,
  alphaQuality: 90,
}));

function headGeometry(person: string): ClientGroupPart {
  const part = CLIENT_GROUPS[0]?.parts.find((p) => p.slug === person);
  if (!part) {
    throw new Error(
      `Геометрия головы для «${person}» не найдена в CLIENT_GROUPS[0].parts. ` +
        'Бюсты и групповой кадр обязаны собираться из ОДНИХ И ТЕХ ЖЕ чисел.'
    );
  }
  return part;
}

interface CommonsMeta {
  url: string;
  descriptionurl: string;
  width: number;
  height: number;
  license: string;
  artist: string;
}

async function fetchCommonsMeta(title: string): Promise<CommonsMeta> {
  const api =
    'https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2' +
    `&titles=${encodeURIComponent(title)}&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=3000`;
  const res = await fetchWithRetry(api);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (await res.json()) as any;
  const ii = json?.query?.pages?.[0]?.imageinfo?.[0];
  if (!ii) throw new Error(`Не нашёл ${title} на Commons`);
  const strip = (v: unknown) => String(v ?? '').replace(/<[^>]*>/g, '').trim();
  return {
    url: ii.thumburl ?? ii.url,
    descriptionurl: ii.descriptionurl,
    width: ii.width,
    height: ii.height,
    license: strip(ii.extmetadata?.LicenseShortName?.value),
    artist: strip(ii.extmetadata?.Artist?.value),
  };
}

const ALLOWED_LICENSE = /^(cc0|public domain)/i;

function grade(pipeline: Sharp, kind: CommonsSource['grade']): Sharp {
  if (kind === 'city-dusk') {

    return pipeline
      .linear(0.72, -46)
      .modulate({ saturation: 1.25 })
      .recomb([
        [1.12, 0.04, 0.0],
        [0.02, 0.96, 0.02],
        [0.0, 0.0, 0.86],
      ]);
  }

  return pipeline.linear(1.02, -6).modulate({ saturation: 1.08 });
}

function cropRegion(src: CropSpec, origW: number, origH: number) {
  const targetRatio = src.width / src.height;

  let regionW = Math.min(origW, origH * targetRatio) / src.zoom;
  let regionH = regionW / targetRatio;
  if (regionH > origH) {
    regionH = origH;
    regionW = regionH * targetRatio;
  }
  const focusX = src.focus.x * origW;
  const focusY = src.focus.y * origH;
  const left = Math.round(
    Math.max(0, Math.min(origW - regionW, focusX - src.place.x * regionW))
  );
  const top = Math.round(
    Math.max(0, Math.min(origH - regionH, focusY - src.place.y * regionH))
  );
  return { left, top, width: Math.round(regionW), height: Math.round(regionH) };
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} КБ`;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} МБ`;

async function processClientGroups(): Promise<string[]> {
  if (CLIENT_GROUPS.length === 0) return [];
  const sections: string[] = [];

  for (const group of CLIENT_GROUPS) {
    if (!wanted(group.slug)) continue;
    const layers: OverlayOptions[] = [];

    const partRows: string[] = new Array(group.parts.length).fill('');
    let originalBytes = 0;

    for (const index of group.drawOrder) {
      const part = group.parts[index];
      if (!part) throw new Error(`drawOrder ссылается на несуществующую часть ${index}`);

      const relative = `${REPLACEMENT_PACK_DIR}/${part.file}`;
      const absolute = path.join(projectRoot, relative);
      try {
        await access(absolute);
      } catch {
        throw new Error(
          `Вырезка для группового кадра не найдена: ${relative}\n` +
            `Ожидалась по пути ${absolute}.\n` +
            `Каталог «${CLIENT_PACK_DIR}» в .gitignore и на новой машине его нет.`
        );
      }

      const probe = await sharp(absolute).metadata();
      originalBytes += (await statFile(absolute)).size;
      const scale = (group.headHeight * part.k) / part.headH;
      const w = Math.round(probe.width! * scale);
      const h = Math.round(probe.height! * scale);
      const slotCx = Math.round(group.width * group.slots[index]!) + part.dx;
      const left = Math.round(slotCx - part.cx * scale);
      const top = Math.round(group.headTop + part.dy - part.top * scale);

      let layer = sharp(absolute).resize({ width: w, height: h, kernel: 'lanczos3' });
      if (part.feather > 0) {

        const stop = (part.feather * 100).toFixed(2);
        const mask = Buffer.from(
          `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
            `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">` +
            `<stop offset="0%" stop-color="#fff" stop-opacity="0"/>` +
            `<stop offset="${stop}%" stop-color="#fff" stop-opacity="1"/>` +
            `<stop offset="${(100 - Number(stop)).toFixed(2)}%" stop-color="#fff" stop-opacity="1"/>` +
            `<stop offset="100%" stop-color="#fff" stop-opacity="0"/>` +
            `</linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/></svg>`
        );
        layer = sharp(await layer.png().toBuffer()).composite([{ input: mask, blend: 'dest-in' }]);
      }

      const vx = Math.max(0, -left);
      const vy = Math.max(0, -top);
      const vw = Math.min(w - vx, group.width - Math.max(0, left));
      const vh = Math.min(h - vy, group.height - Math.max(0, top));
      if (vw <= 0 || vh <= 0) throw new Error(`Часть ${part.slug} целиком вне холста`);
      const buffer = await sharp(await layer.png().toBuffer())
        .extract({ left: vx, top: vy, width: vw, height: vh })
        .png()
        .toBuffer();
      layers.push({ input: buffer, left: Math.max(0, left), top: Math.max(0, top) });
      partRows[index] =
        `| ${part.slug} | \`${part.file}\` | ${probe.width}x${probe.height} | ` +
        `x${scale.toFixed(3)} | место ${index + 1} слева |`;
    }

    let canvasW = group.width;
    let canvasH = group.height;
    let readyBuf: Buffer | undefined;
    if (group.readyMaster) {

      const readyPath = path.join(REPLACEMENT_PACK_DIR, group.readyMaster);
      const meta = await sharp(readyPath).metadata();
      canvasW = group.width;
      canvasH = Math.round((group.width * (meta.height ?? 1)) / (meta.width ?? 1));
      readyBuf = await sharp(readyPath)
        .resize({ width: canvasW, kernel: 'lanczos3' })
        .png()
        .toBuffer();
    }

    const fadeHeight = Math.round(canvasH * group.bottomFade);
    const sideFade = Math.round(canvasW * 0.16);

    const softStops = (edgeAt: 'start' | 'end') => {
      const black = [1, 0.94, 0.72, 0.35, 0];
      const v = edgeAt === 'start' ? black : [...black].reverse();
      return v
        .map((o, i) => `<stop offset="${i * 25}%" stop-color="#000" stop-opacity="${o}"/>`)
        .join('');
    };
    const alphaMask = Buffer.from(
      `<svg width="${canvasW}" height="${canvasH}" xmlns="http://www.w3.org/2000/svg">` +
        `<defs>` +

        `<linearGradient id="b" x1="0" y1="0" x2="0" y2="1">${softStops('end')}</linearGradient>` +
        `<linearGradient id="l" x1="0" y1="0" x2="1" y2="0">${softStops('start')}</linearGradient>` +
        `<linearGradient id="r" x1="0" y1="0" x2="1" y2="0">${softStops('end')}</linearGradient>` +
        `<mask id="m">` +
        `<rect width="${canvasW}" height="${canvasH}" fill="#fff"/>` +
        `<rect y="${canvasH - fadeHeight}" width="${canvasW}" height="${fadeHeight}" fill="url(#b)"/>` +
        `<rect width="${sideFade}" height="${canvasH}" fill="url(#l)"/>` +
        `<rect x="${canvasW - sideFade}" width="${sideFade}" height="${canvasH}" fill="url(#r)"/>` +
        `</mask>` +
        `</defs>` +
        `<rect width="${canvasW}" height="${canvasH}" fill="#fff" mask="url(#m)"/></svg>`
    );

    const outPath = path.join(outDir, `${group.slug}.webp`);
    await sharp({
      create: {
        width: canvasW,
        height: canvasH,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        ...(readyBuf ? [{ input: readyBuf, left: 0, top: 0 }] : layers),
        { input: alphaMask, blend: 'dest-in' },
      ])
      .webp({ quality: group.quality, alphaQuality: 90, effort: 6 })
      .toFile(outPath);

    const outBytes = (await statFile(outPath)).size;
    console.log(
      `${group.slug}: ${canvasW}x${canvasH}, ${kb(outBytes)} ` +
        `(${group.readyMaster ? `готовый кадр ${group.readyMaster}` : `собран из ${group.parts.length} вырезок`}, ` +
        `${mb(originalBytes)} исходников) [передано заказчиком]`
    );

    sections.push(
      [
        `### ${group.slug}.webp`,
        '',
        `- **Роль на странице:** ${group.role}`,
        `- **Источник:** передано заказчиком, каталог \`${REPLACEMENT_PACK_DIR}/\``,
        `- **Права:** ${REPLACEMENT_RIGHTS}`,
        `- **Дата получения:** ${REPLACEMENT_RECEIVED}`,
        `- **Оригиналы:** ${group.parts.length} PNG с альфа-каналом, суммарно ${mb(originalBytes)}`,
        `- **В репозитории:** \`src/assets/media/${group.slug}.webp\`, ` +
          `${canvasW}x${canvasH}, ${kb(outBytes)}, WebP q${group.quality} с альфой, ` +
          `кромки растворены маской (низ ${Math.round(group.bottomFade * 100)} %, бока 10 %), ` +
          `цветокоррекции нет`,
        '',
        '⛔ Пара «имя ↔ лицо» взята из ТЕЛЕФОННОГО макета `2026-08-26_22-39-43.png`,',
        'где каждое имя подписано под своим человеком. Десктопный макет их путает',
        '(под именами Newsac / MaaRaa MN / Zilkenberg там стоят MaaRaa MN /',
        'Zilkenberg / Newsac). Порядок слева направо взят десктопный, соответствие',
        'имени лицу — телефонное.',
        '',
        '| Человек | Вырезка | Оригинал | Масштаб | Место |',
        '|---|---|---|---|---|',
        ...partRows,
        '',
      ].join('\n')
    );
  }

  return sections;
}

interface ClientCloudInstance {

  name: string;

  x: number;
  y: number;
  w: number;
  h: number;

  opacity: number;
}

interface ClientCloudGroup {
  slug: string;
  role: string;

  file: string;

  width: number;
  height: number;

  refWidth: number;
  refHeight: number;
  quality: number;
  alphaQuality: number;
  instances: ClientCloudInstance[];
}

const CLIENT_CLOUDS: ClientCloudGroup[] = [];

async function processClientClouds(): Promise<string[]> {
  if (CLIENT_CLOUDS.length === 0) return [];
  const sections: string[] = [];

  for (const group of CLIENT_CLOUDS) {
    if (!wanted(group.slug)) continue;

    const relative = `${CLIENT_PACK_DIR}/слайд 1/облака/${group.file}`;
    const absolute = path.join(projectRoot, relative);
    try {
      await access(absolute);
    } catch {
      throw new Error(
        `Спрайт облака не найден: ${relative}\n` +
          `Ожидался по пути ${absolute}.\n` +
          `Каталог «${CLIENT_PACK_DIR}» в .gitignore и на новой машине его нет.`
      );
    }

    const probe = await sharp(absolute).metadata();
    const originalBytes = (await statFile(absolute)).size;
    const kx = group.width / group.refWidth;
    const ky = group.height / group.refHeight;
    const rows: string[] = [];
    const layers: OverlayOptions[] = [];

    for (const inst of group.instances) {
      const w = Math.max(4, Math.round(inst.w * kx));
      const h = Math.max(3, Math.round(inst.h * ky));

      const veil = Buffer.from([255, 255, 255, Math.round(255 * inst.opacity)]);
      const layer = await sharp(absolute)
        .resize({ width: w, height: h, fit: 'fill', kernel: 'lanczos3' })
        .ensureAlpha()
        .composite([{ input: veil, raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: 'dest-in' }])
        .png()
        .toBuffer();
      layers.push({ input: layer, left: Math.round(inst.x * kx), top: Math.round(inst.y * ky) });
      rows.push(
        `| ${inst.name} | ${inst.x},${inst.y} ${inst.w}x${inst.h} | ` +
          `${(inst.opacity * 100).toFixed(0)} % | ${w}x${h} |`
      );
    }

    const outPath = path.join(outDir, `${group.slug}.webp`);
    await sharp({
      create: { width: group.width, height: group.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite(layers)
      .webp({ quality: group.quality, alphaQuality: group.alphaQuality, effort: 6 })
      .toFile(outPath);

    const outBytes = (await statFile(outPath)).size;
    console.log(
      `${group.slug}: ${group.width}x${group.height}, ${kb(outBytes)} ` +
        `(собран из ${group.instances.length} экземпляров одного спрайта ${mb(originalBytes)}) [передано заказчиком]`
    );

    sections.push(
      [
        `### ${group.slug}.webp`,
        '',
        `- **Роль на странице:** ${group.role}`,
        `- **Источник:** передано заказчиком, каталог \`${CLIENT_PACK_DIR}/слайд 1/облака/\``,
        `- **Права:** ${CLIENT_RIGHTS}`,
        `- **Дата получения:** ${CLIENT_RECEIVED}`,
        `- **Оригинал:** \`${group.file}\`, ${probe.width}x${probe.height} PNG с альфой, ${mb(originalBytes)}`,
        `- **В репозитории:** \`src/assets/media/${group.slug}.webp\`, ` +
          `${group.width}x${group.height}, ${kb(outBytes)}, WEBP q${group.quality} ` +
          `(альфа q${group.alphaQuality}), альфа СОХРАНЕНА, цветокоррекции нет`,
        '',
        '⛔ Готовой группы облаков в пакете НЕТ. Шесть файлов каталога — одно и то',
        'же облако: рамки непрозрачного у всех совпадают до пикселя, различаются',
        'только запечённые прозрачности (10/74/32/18/32 %). Композиция собрана по',
        'выгрузке слоя `101:684`: рамки экземпляров сняты связными компонентами,',
        'прозрачности подобраны по пику каждой области (совпадение 0,1…5,1',
        'единицы яркости из 255).',
        '',
        '⚠️ Собственная заливка слоя (25,28,42) в растр НЕ запечена: она сделала бы',
        'кадр почти непрозрачным и прибила бы к нему тон, который на странице',
        'обязан быть градиентом. Тон отдан CSS за ноль байт.',
        '',
        '| Экземпляр | Рамка в координатах слоя 642x769 | Прозрачность | На холсте мастера |',
        '|---|---|---|---|',
        ...rows,
        '',
      ].join('\n')
    );
  }

  return sections;
}

async function processClientBusts(): Promise<string[]> {
  if (CLIENT_BUSTS.length === 0) return [];
  const sections: string[] = [];
  const rows: string[] = [];
  let anyBuilt = false;

  for (const bust of CLIENT_BUSTS) {
    if (!wanted(bust.slug)) continue;
    anyBuilt = true;

    const part = headGeometry(bust.person);

    const relative = `${REPLACEMENT_PACK_DIR}/${part.file}`;
    const absolute = path.join(projectRoot, relative);
    try {
      await access(absolute);
    } catch {
      throw new Error(
        `Вырезка для бюста не найдена: ${relative}\n` +
          `Ожидалась по пути ${absolute}.\n` +
          `Каталог «${CLIENT_PACK_DIR}» в .gitignore и на новой машине его нет.`
      );
    }

    const probe = await sharp(absolute).metadata();
    const originalBytes = (await statFile(absolute)).size;

    const targetHead = bust.height * bust.headFraction * part.k;
    const scale = targetHead / part.headH;
    const w = Math.round(probe.width! * scale);
    const h = Math.round(probe.height! * scale);

    const headCxOnCanvas =
      bust.outerSide === 'left'
        ? bust.width * bust.headCenter
        : bust.width * (1 - bust.headCenter);
    const left = Math.round(headCxOnCanvas - part.cx * scale);
    const top = Math.round(bust.height * bust.crownTop - part.top * scale);

    let layer = sharp(absolute).resize({ width: w, height: h, kernel: 'lanczos3' });
    if (part.feather > 0) {

      const stop = (part.feather * 100).toFixed(2);
      const mask = Buffer.from(
        `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
          `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">` +
          `<stop offset="0%" stop-color="#fff" stop-opacity="0"/>` +
          `<stop offset="${stop}%" stop-color="#fff" stop-opacity="1"/>` +
          `<stop offset="${(100 - Number(stop)).toFixed(2)}%" stop-color="#fff" stop-opacity="1"/>` +
          `<stop offset="100%" stop-color="#fff" stop-opacity="0"/>` +
          `</linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/></svg>`
      );
      layer = sharp(await layer.png().toBuffer()).composite([{ input: mask, blend: 'dest-in' }]);
    }

    const vx = Math.max(0, -left);
    const vy = Math.max(0, -top);
    const vw = Math.min(w - vx, bust.width - Math.max(0, left));
    const vh = Math.min(h - vy, bust.height - Math.max(0, top));
    if (vw <= 0 || vh <= 0) throw new Error(`Бюст ${bust.slug} целиком вне холста`);
    const buffer = await sharp(await layer.png().toBuffer())
      .extract({ left: vx, top: vy, width: vw, height: vh })
      .png()
      .toBuffer();

    const fadeHeight = Math.round(bust.height * bust.bottomFade);
    const innerWidth = Math.round(bust.width * bust.innerFade);
    const outPath = path.join(outDir, `${bust.slug}.webp`);

    const eraseBottom = Buffer.from(
      `<svg width="${bust.width}" height="${fadeHeight}" xmlns="http://www.w3.org/2000/svg">` +
        `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0%" stop-color="#000" stop-opacity="0"/>` +
        `<stop offset="100%" stop-color="#000" stop-opacity="1"/>` +
        `</linearGradient></defs>` +
        `<rect width="${bust.width}" height="${fadeHeight}" fill="url(#g)"/></svg>`
    );

    const innerLeftToRight = bust.outerSide === 'left';
    const eraseInner = Buffer.from(
      `<svg width="${innerWidth}" height="${bust.height}" xmlns="http://www.w3.org/2000/svg">` +
        `<defs><linearGradient id="g" x1="${innerLeftToRight ? 0 : 1}" y1="0" x2="${innerLeftToRight ? 1 : 0}" y2="0">` +
        `<stop offset="0%" stop-color="#000" stop-opacity="0"/>` +
        `<stop offset="100%" stop-color="#000" stop-opacity="1"/>` +
        `</linearGradient></defs>` +
        `<rect width="${innerWidth}" height="${bust.height}" fill="url(#g)"/></svg>`
    );

    const composed = await sharp({
      create: {
        width: bust.width,
        height: bust.height,
        channels: 4,

        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        { input: buffer, left: Math.max(0, left), top: Math.max(0, top) },
        { input: eraseBottom, left: 0, top: bust.height - fadeHeight, blend: 'dest-out' },
        {
          input: eraseInner,
          left: innerLeftToRight ? bust.width - innerWidth : 0,
          top: 0,
          blend: 'dest-out',
        },
      ])
      .raw()
      .toBuffer({ resolveWithObject: true });

    await sharp(composed.data, {
      raw: {
        width: composed.info.width,
        height: composed.info.height,
        channels: composed.info.channels,
      },
    })
      .webp({ quality: bust.quality, alphaQuality: bust.alphaQuality, effort: 6 })
      .toFile(outPath);

    const outBytes = (await statFile(outPath)).size;
    console.log(
      `${bust.slug}: ${bust.width}x${bust.height}, ${kb(outBytes)} ` +
        `(бюст ${bust.person}, ${mb(originalBytes)} исходник, за кромку ${bust.outerSide}, ` +
        `WebP с альфой) [передано заказчиком]`
    );

    rows.push(
      `| ${bust.person} | \`${part.file}\` | ${probe.width}x${probe.height} | ` +
        `x${scale.toFixed(3)} | ${bust.outerSide === 'left' ? 'слева' : 'справа'} | ` +
        `${kb(outBytes)} |`
    );
  }

  if (!anyBuilt) return [];

  sections.push(
    [
      '### client-partner-*.jpg (четыре бюста, телефонная раскладка)',
      '',
      `- **Роль на странице:** ${CLIENT_BUSTS[0]!.role.split(':')[0]}: по одному портрету на ряд, ниже 720px.`,
      `- **Источник:** передано заказчиком, каталог \`${REPLACEMENT_PACK_DIR}/\``,
      `- **Права:** ${REPLACEMENT_RIGHTS}`,
      `- **Дата получения:** ${REPLACEMENT_RECEIVED}`,
      `- **В репозитории:** \`src/assets/media/client-partner-<человек>.webp\`, ` +
        `${BUST_CANVAS.width}x${BUST_CANVAS.height}, WebP q${CLIENT_BUSTS[0]!.quality}/` +
        `альфа ${CLIENT_BUSTS[0]!.alphaQuality}, **с прямой (непремультиплицированной) альфой**, ` +
        `цветокоррекции нет`,
      '',
      '⛔ Премультипликация RGB к `#07090b` СНЯТА 28.08.2026 по прямому слову',
      'заказчика («не надо их самостоятельно затемнять, возьми их просто»). Она',
      'применяла альфу дважды — в файле и в браузере — и печать MELBET уходила',
      'с `orig·a` на `orig·a²`, то есть темнела в 2,3…3,7 раза. Цена отката',
      'названа: доставка четырёх кадров 34 932 → 46 535 Б на AVIF q54 при 360w.',
      '',
      '⛔ Пара «имя ↔ лицо» та же, что у группового кадра. Порядок РЯДОВ на',
      'телефоне задан решением Д-27 от 28.08.2026 («Поменяй местами мараа и',
      'невсак вместе с фото») и отличается от порядка четвертей группового',
      'кадра, который остаётся за Д-19 и Д-22. Геометрия головы читается из тех',
      'же чисел, что собирают групповой кадр, — второго набора нет по',
      'построению.',
      '',
      '⛔ Альфа возвращена 28.08.2026 вместе с ночной подложкой секции. До неё',
      'бюсты сводились на `#07090b` — на плоском фоне это было неотличимо от',
      'вырезки, на сцене дало бы четыре видимых прямоугольника. Кромки не',
      'закрашиваются подложкой, а СТИРАЮТСЯ (`dest-out`): низ на',
      `${CLIENT_BUSTS[0]!.bottomFade} высоты, внутренняя боковая на ` +
        `${CLIENT_BUSTS[0]!.innerFade} ширины.`,
      '',
      '| Человек | Вырезка | Оригинал | Масштаб | За кромку | Мастер |',
      '|---|---|---|---|---|---|',
      ...rows,
      '',
    ].join('\n')
  );

  return sections;
}

interface ClientNameMaskSource {

  person: string;

  file: string;

  width: number;

  rotateDeg: number;
  quality: number;
  alphaQuality: number;
}

const NAME_MASK_WIDTH = 320;

const CLIENT_NAME_MASKS: ClientNameMaskSource[] = [
  { person: 'lexor2k', file: 'lexor2k_name.png', rotateDeg: 9.8 },
  { person: 'newsac', file: 'newsac_name.png', rotateDeg: 0 },
  { person: 'maaraamn', file: 'maaraa_name.png', rotateDeg: -5.2 },
  { person: 'zilkenberg', file: 'zilkenberg_name.png', rotateDeg: 0 },
].map((m) => ({
  ...m,
  width: NAME_MASK_WIDTH,
  quality: 60,
  alphaQuality: 70,
}));

async function processClientNameMasks(): Promise<string[]> {
  if (CLIENT_NAME_MASKS.length === 0) return [];
  const rows: string[] = [];
  let anyBuilt = false;

  for (const mask of CLIENT_NAME_MASKS) {
    const slug = `client-name-${mask.person}`;
    if (!wanted(slug)) continue;
    anyBuilt = true;

    const relative = `${CLIENT_PACK_DIR}/слайд 6/${mask.file}`;
    const absolute = path.join(projectRoot, relative);
    try {
      await access(absolute);
    } catch {
      throw new Error(
        `Мастер имени не найден: ${relative}\n` +
          `Ожидался по пути ${absolute}.\n` +
          `Каталог «${CLIENT_PACK_DIR}» в .gitignore и на новой машине его нет.`
      );
    }
    const originalBytes = (await statFile(absolute)).size;

    const trimmed = await sharp(absolute).trim({ threshold: 1 }).toBuffer({ resolveWithObject: true });

    const spun =
      mask.rotateDeg === 0
        ? trimmed
        : await sharp(trimmed.data)
            .rotate(-mask.rotateDeg, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .trim({ threshold: 1 })
            .toBuffer({ resolveWithObject: true });

    const boxScale = spun.info.height / trimmed.info.height;

    const height = Math.round((mask.width * spun.info.height) / spun.info.width);
    const alpha = await sharp(spun.data)
      .resize({ width: mask.width, height, kernel: 'lanczos3' })
      .extractChannel('alpha')
      .raw()
      .toBuffer();

    const outPath = path.join(outDir, `${slug}.webp`);
    await sharp({ create: { width: mask.width, height, channels: 3, background: '#ffffff' } })
      .joinChannel(alpha, { raw: { width: mask.width, height, channels: 1 } })
      .webp({ quality: mask.quality, alphaQuality: mask.alphaQuality, effort: 6 })
      .toFile(outPath);

    const outBytes = (await statFile(outPath)).size;
    const ratio = (mask.width / height).toFixed(3);
    console.log(
      `${slug}: ${mask.width}x${height} (пропорция ${ratio}), ${kb(outBytes)} ` +
        `(маска ника, доворот ${mask.rotateDeg > 0 ? '+' : ''}${mask.rotateDeg}°, ` +
        `высота бокса x${boxScale.toFixed(4)}, ${mb(originalBytes)} исходник) [передано заказчиком]`
    );
    rows.push(
      `| ${mask.person} | \`слайд 6/${mask.file}\` | ${trimmed.info.width}x${trimmed.info.height} | ` +
        `${mask.rotateDeg > 0 ? '+' : ''}${mask.rotateDeg}° | ` +
        `${mask.width}x${height} | ${ratio} | x${boxScale.toFixed(4)} | ${kb(outBytes)} |`
    );
  }

  if (!anyBuilt) return [];

  return [
    [
      '### client-name-*.webp (четыре маски ников)',
      '',
      '- **Роль на странице:** блок «С нами уже сотрудничают», телефонная раскладка: ' +
        'кистевое начертание ника. Маска красится токеном `--gold`, сам ник остаётся ' +
        'ТЕКСТОМ в разметке.',
      `- **Источник:** передано заказчиком, каталог \`${CLIENT_PACK_DIR}/слайд 6/\``,
      `- **Права:** ${CLIENT_RIGHTS}`,
      `- **Дата получения:** ${CLIENT_RECEIVED}`,
      `- **В репозитории:** \`src/assets/media/client-name-<человек>.webp\`, ` +
        `WebP q${CLIENT_NAME_MASKS[0]!.quality}/альфа ${CLIENT_NAME_MASKS[0]!.alphaQuality}, ` +
        'RGB залит белым, форма букв живёт в альфа-канале',
      '',
      '⛔ Цвет исходника (золото макета #fabe00) НЕ едет в репозиторий: маска',
      'бесцветна по построению, красит её токен `--gold` #f1c632. Второго золотого',
      'на странице не появляется.',
      '',
      '⛔ Файлов ЧЕТЫРЕ на три локали, а не двенадцать: ники одинаковы на mn/ru/en',
      'по прямому слову заказчика от 28.08.2026.',
      '',
      '⛔ Доворот — решение Д-27.2 того же дня («текст наколнен не в ту сторону,',
      'именно ники партнеров»). Присланная графика несёт СВОЙ наклон, а в макет',
      'дизайнер положил её повёрнутой; наши маски повторяли исходник с точностью',
      '0,06 градуса, то есть ошибки в конвейере не было. Множитель высоты бокса',
      'возвращает буквам их прежний размер: поворот увеличивает габарит чернил, и',
      'без него слово ужалось бы.',
      '',
      '| Человек | Исходник | Ink после трима | Доворот | Маска | Пропорция | Высота бокса | Вес |',
      '|---|---|---|---|---|---|---|---|',
      ...rows,
      '',
    ].join('\n'),
  ];
}

const AI_PLATES: string[] = [
  '## Плиты, сгенерированные нейросетью',
  '',
  'Заказаны **02.09.2026** через MCP Higgsfield на оплаченной заказчиком подписке',
  '(план plus). Основание прав — вывод его собственной подписки; лицензия Commons',
  'и «слово заказчика про чужой кадр» здесь неприменимы.',
  '',
  'Каждая плита: генерация 2K → увеличение до 4K (`bytedance_image_upscale`) →',
  'кроп под пропорцию заменяемого кадра. ⛔ Кроп совмещён ПО ЗАМЕРУ: у старого и',
  'нового кадра считается строка с максимальной яркостью (полоса городских огней),',
  'и сдвиг подбирается так, чтобы её доля высоты совпала. Иначе окна кадрирования',
  'в CSS (`object-position`, `489vw`, `123,3vw`) — координаты ВНУТРИ картинки —',
  'указывали бы не туда, и вышло бы то, что заказчик забраковал в прошлый заход:',
  '«все расположено очень криво и косо… картинки приближены очень сильно».',
  '',
  '⛔ ВТОРОЙ ЗАКАЗ, 02.09.2026 вечером: НАТИВНЫЕ 4K вместо «2K плюс увеличение».',
  'Заказчик: «перегенерь фоток чтобы была максимальная четкость картинок.',
  'Возможно с эффектом ряби такой, что будет красиво выглядить». Nano Banana Pro',
  'принимает `resolution: 4k` и рисует кадр сразу в нём — промежуточное',
  'увеличение (`bytedance_image_upscale`), которым собраны плиты первого захода,',
  'больше не нужно и не используется. Рябь на воде первого экрана заказана',
  'словами в промпте, а не постобработкой.',
  '',
  '| файл | модель | плита | в репозитории |',
  '|---|---|---|---|',
  '| `client-night-panorama.jpg` | Nano Banana Pro 4K | 5056x3392 | 3840x1628, JPEG q82, тон ×0,82 |',
  '| `client-night-panorama-portrait.jpg` | Nano Banana Pro 4K | 5056x3392 | 2200x2749, JPEG q82, тон ×0,82 |',
  '| `client-city-haze.jpg` | Nano Banana Pro 4K | 5504x3072 | 3840x1804, JPEG q82, тон ×0,46 |',
  '| `client-clouds-group.webp` | Nano Banana Pro 4K | 3712x4608 | 3700x4431, WEBP q68 (альфа 62), альфа СОБРАНА ИЗ ЯРКОСТИ, поле 2,5 % + растушёвка 6 % |',
  '| `client-bokeh-hills.jpg` | Seedream 5.0 Pro | 4096x3072 | 3200x2852, JPEG q82 |',
  '',
  '⛔ ТОН — ЧАСТЬ ПОДГОНКИ, А НЕ ВКУС. Нативные плиты вышли заметно светлее',
  'прежних, и замер это назвал: контраст «имени карточки» упал 4,74 → 3,58, то',
  'есть подложка съела читаемость. `linear(k, 0)` умножает все каналы на k —',
  'тон возвращается к прежнему, а детализация и резкость, ради которых плита и',
  'заказывалась, остаются. После подгонки контраст вернулся к 4,74.',
  '',
  '⛔⛔ ТОН ×0,82 ПРИМЕНЁН К ПЛИТЕ, А НЕ К ПРИСЛАННОМУ `bg-1.png`, И ЭТУ СТРОКУ',
  'НЕЛЬЗЯ «ИСПРАВИТЬ ПО ЗАМЕРУ» ОБРАТНО. 06.09.2026 заход по резкости первого',
  'экрана предположил, что запись выше — неправда: подготовленный кадр ЯРЧЕ',
  'присланного `Правки по дизайну с креативами/фоны/bg-1.png` в 1,31 раза',
  '(средняя яркость Rec.709: 23,09 у исходника заказчика против 30,29 у',
  '`src/assets/media/client-night-panorama.jpg`). Предположение НЕВЕРНО, и',
  'опровергает его воспроизведение конвейера, а не рассуждение:',
  '',
  '| что мерилось | средняя яркость |',
  '|---|---|',
  '| присланный заказчиком `bg-1.png` | 23,09 |',
  '| кадр ДО замены плитой (`bg2/orig/`, 2400x1018) | 23,05 |',
  '| кроп плиты БЕЗ тона | 37,90 |',
  '| кроп плиты С тоном ×0,82 | 30,59 |',
  '| файл в репозитории | 30,29 |',
  '',
  'Отношение «файл / кроп с тоном» = 0,99, «файл / кроп без тона» = 0,80. Тон',
  'применён. Живой код, который его применяет, —',
  '`.planning/quick/20260902-desktop-layout/tools/fit.mjs`: поле `dim: 0.82` в',
  'списке `JOBS` и вызов `.linear(j.dim ?? 1, 0)` в теле цикла.',
  '',
  '⛔ ПОЧЕМУ ОБА ЧИСЛА ВЕРНЫ ОДНОВРЕМЕННО: сравнивались РАЗНЫЕ пары. Тон',
  'приглушал плиту Nano Banana Pro относительно неё самой; плита при этом всё',
  'равно осталась светлее исходника заказчика, которого она заменила. Сравнение',
  'готового файла с `bg-1.png` про наличие тона не говорит НИЧЕГО.',
  '',
  '⚠️ ЛОВУШКА ПРИБОРА, НА КОТОРОЙ ЭТОТ ЗАМЕР СНАЧАЛА СОВРАЛ: sharp `.stats()`',
  'считает статистику ВХОДНОГО файла и игнорирует конвейер — `extract` и',
  '`linear` до неё не доезжают, а `channels[0]` это канал R, а не яркость.',
  'Первый прогон из-за этого показал «с тоном и без тона одинаково». Мерить',
  'только по сырому буферу после материализации.',
  '',
  '⛔ ЗАТЕМНЕНИЯ НА СТРАНИЦЕ ТОЖЕ НЕТ, И ЭТО ПРОВЕРЕНО ОТДЕЛЬНО. Оба слоя поверх',
  'кадра первого экрана ОСВЕТЛЯЮТ: `.hero-scrim` несёт россыпь белых звёзд',
  '(`rgba(255,255,255,…)`), `.hero-haze` работает в режиме `mix-blend-mode:',
  'lighten`. Ни одного `filter: brightness()` ниже единицы в проекте нет.',
  '',
  '⛔⛔ ЧИСЛА В РАЗДЕЛЕ «Кадры, присланные заказчиком» ОПИСЫВАЮТ НЕ ТОТ ФАЙЛ,',
  'КОТОРЫЙ ЛЕЖИТ В РЕПОЗИТОРИИ. Там у `client-night-panorama.jpg` записано',
  '2400x1018 и 83,6 КБ — это то, что ВЫДАСТ конвейер, если его прогнать; в',
  'репозитории с 02.09.2026 лежит плита 3840x1628 и 340 КБ. ⛔ Отсюда прямое',
  'следствие, названное вслух: `node scripts/prepare-media.ts` без `--only`',
  'ПЕРЕЗАПИШЕТ плиты кадрами из пакета заказчика и молча вернёт мыло, ради',
  'которого плиты и заказывались. Плиты 4K в репозиторий не кладутся (см. врезку',
  'у `AI_PLATES`), то есть восстановить их прогоном будет нечем.',
  '',
  '⚠️ Боке блогеров осталось от ПЕРВОГО захода: у обоих кандидатов второго',
  'гребни вышли почти белыми и спорили с тёмной темой. Резкости ему хватает —',
  'после подъёма потолков `widths` растяжение там ×1,18.',
  '',
  '⛔ У облаков прозрачность выведена из ЯРКОСТИ, а не вырезана инструментом',
  'удаления фона. У облака нет кромки — оно растворяется в небе на сотнях',
  'пикселей, и любой вырезатель проводит по нему границу, видимую на тёмном фоне',
  'как ореол. Плита заказана на чистом чёрном ровно ради этого приёма: где',
  'чёрно — прозрачно, насколько светлее — настолько плотнее.',
  '',
  '⛔ У ЭТОГО ПРИЁМА ЕСТЬ ЦЕНА, И 02.09.2026 ОНА НЕ БЫЛА ЗАПЛАЧЕНА. «Где светлее',
  'фона — тем плотнее» делает непрозрачными и пиксели у самой рамки кадра: у',
  'сборки 02.09 максимальная альфа в первой строке была 101, в последней 83, в',
  'первом и последнем столбце 83, а полностью прозрачных строк по кромкам — ноль.',
  'Заказчик увидел это дважды: «по краям видно как они заканчиваются резко',
  'обрезаясь» и «облака с жёсткой полосой обрезанной». ⚠️ Перегенерация кадра',
  'болезнь НЕ лечит — новый кадр обрезало бы так же.',
  '',
  'Лечит третий шаг ветви `scripts/build-cloud-layer.ts` (`npm run media:clouds`):',
  'растушёвка альфы 6 % и прозрачное поле 2,5 % по каждой кромке, ДОЛЯМИ от',
  'размера мастера, а не пикселями — доля переживает смену разрешения плиты.',
  'Поле вырезается ВНУТРИ холста, поэтому верхняя ступень `srcset` осталась',
  '3700w, а мастер даже полегчал: 825 → 625 КБ.',
  '',
  '⚠️ БОКЕ ЗА БЛОГЕРАМИ ВСЁ-ТАКИ ПЕРЕДЕЛАНО, и самая первая редакция этой строки',
  '(«не переделывалось: заказчика устраивает как есть») отменена его же словами:',
  '«задник на „наши партнеры“ мне не нравится, он как будто в 240p». Стоит плита',
  'Seedream 5.0 Pro; на нативные 4K её не меняли — причина в строке выше.',
  '',
  '⛔⛔ ДВА КАДРА УДАЛЕНЫ ИЗ РЕПОЗИТОРИЯ ВМЕСТЕ СО СВОИМИ СЛОЯМИ 03.09.2026:',
  '`client-city-haze.jpg` (сопки за карточками) и `client-bokeh-hills.jpg`',
  '(ночная подложка блогеров). Причина — прямое требование заказчика: «Зачем мне',
  'столько фонов которые конфликтуют между собой? Ты видишь что каждый блок',
  'устроен по своему и даже со своей цветовой схемой». Вместо восьми полосных',
  'кадров страница получила одну сквозную сцену на градиентах.',
  '',
  '⛔ `client-clouds-group.webp` ОСТАЁТСЯ В РЕПОЗИТОРИИ И ЭТО НЕ НЕДОСМОТР. Из',
  'четырёх его применений снято четыре, но ПЯТОЕ живо: полоса дымки первого',
  'экрана `.hero-haze` в Hero.astro, подобранная замером яркости под кнопками.',
  'Попытка удалить файл роняет сборку сразу — «Could not resolve',
  '../assets/media/client-clouds-group.webp from src/components/Hero.astro».',
  '',
  '⚠️ ЗАПИСИ О ПРАВАХ НА ЭТИ КАДРЫ ВЫШЕ НЕ УДАЛЕНЫ И УДАЛЕНЫ БЫТЬ НЕ МОГУТ:',
  'право получено 26.08.2026 и остаётся в силе, кадры просто не стоят на',
  'странице. Оба собираются заново одним прогоном `npm run prepare:media` из',
  'пакета заказчика.',
  '',
  '⛔ КАДР `client-tower-rays.jpg` УДАЛЁН ИЗ РЕПОЗИТОРИЯ ВМЕСТЕ СО СВОИМ СЛОЕМ',
  '(02.09.2026). Слой золотых лучей выводил положение из ВЫСОТЫ секции',
  'направлений, а она меняется при раскрытии карточки, и в раскрытом состоянии',
  'он вылезал диагональной полосой через пустой фон — заказчик: «вот видишь',
  'хуета какая то получается тут». Цена удаления измерена и равна нулю: слой',
  'менял около 1 % пикселей страницы, а в заказе фонов он с самого начала',
  'записан как ненужный.',
  '',
  '⚠️ Плиты 4K в репозиторий не кладутся — они весят по 2 МБ каждая. В заходе',
  '`.planning/quick/20260902-desktop-layout/bg2/` лежат их превью (`4k-*.jpg`),',
  'сводки кандидатов (`_hero.jpg`, `_sopki.jpg`, `_oblaka.jpg`) и `jobs.json` с',
  'идентификаторами заданий: по ним плиту можно забрать у Higgsfield заново.',
  '',
  '⚠️ Прежние кадры заказчика сохранены в заходе',
  '`.planning/quick/20260902-desktop-layout/bg2/orig/` — их записи о правах',
  'остаются в силе выше, они просто больше не стоят на странице.',
  '',
  '⛔ ОДНОЙ ЗАПИСИ ВЫШЕ БОЛЬШЕ НЕТ, И ЭТО НАМЕРЕННО (03.09.2026). Раздел про',
  '`client-clouds-group.webp`, собранный из спрайта заказчика `слайд 1/облака/',
  'full_cloud.png` (4344x3258 PNG с альфой, 5,41 МБ, шесть экземпляров на холсте',
  '1158x1387), описывал кадр, которого в репозитории нет с 02.09.2026 — его',
  'заменила плита из таблицы выше. Права на сам спрайт даны заказчиком',
  '**26.08.2026** и остаются в силе на тех же условиях, что и у остальных кадров',
  'пакета; он просто не стоит на странице. Ветка `CLIENT_CLOUDS` в',
  '`scripts/prepare-media.ts` обезврежена там же: она писала в живой путь и любым',
  'прогоном `prepare-media` молча откатила бы и разрешение, и прозрачное поле.',
  '',
  '⛔⛔ ТРЕТИЙ ЗАКАЗ, 03.09.2026: ПЛИТКА ФАКТУРЫ ДЛЯ СКВОЗНОЙ СЦЕНЫ. Заказчик,',
  'дословно: «Можешь сделать бекграунд, чтобы он был единообразным, ну то есть',
  'чтобы ничего не сливалось и не обрезалось. У тебя есть хигсфилд, генерируй что',
  'угодно, главная цель — сделать такой бекграунд, который подходит по стилистике и',
  'максимально безопасный визуально».',
  '',
  '| файл | модель | плита | в репозитории |',
  '|---|---|---|---|',
  '| `scene-texture.webp` | Nano Banana 2 (`nano_banana_2`) | 2048x2048 | 1024x1024, WEBP q45, 8,1 КБ, БЕЗ альфы |',
  '',
  'Вариантов заказано **четыре** по 2 кредита; взят',
  '`568e6695-db03-4f6c-97d6-dd3d2854f075` — самый ровный по тону, без светлого',
  'пятна и без нарисованной рамки. Промпт целиком, одной строкой:',
  '',
  '> Abstract dark atmospheric background texture. Deep midnight navy blue and near-black, with extremely subtle drifting haze and soft nebulous mist, plus a very faint warm amber glow diffused in a few places like distant city light through fog. Extremely low contrast, soft and even overall distribution across the entire square, no focal point, no bright hotspot, no vignette, no visible objects or shapes, nothing recognizable, just smooth organic tonal variation and fine cinematic film grain. Muted and quiet, designed to sit behind white body text on a dark premium website without ever competing with it. No stars, no moon, no horizon, no clouds with defined edges, no landscape, no people, no text, no watermark, no border, no frame, no vignette.',
  '',
  '⛔ НА СТРАНИЦЕ СТОИТ НЕ КАДР, А ПЛИТКА, И РАЗНИЦА ЗДЕСЬ ГЛАВНАЯ.',
  'Кадр, положенный один раз, где-то кончается — отсюда все обрезы и швы',
  'недели 02–03.09.2026 и нехватка кадра при раскрытии карточек (высота',
  'страницы 3316 → 4415 на 1440). У плитки края нет по построению. Собирает',
  'её `scripts/build-scene-texture.ts` (`npm run media:texture`): вычитание сильно',
  'размытой копии (уходит крупный тон, разброс между четвертями 9,71 → 0,30),',
  'сдвиг на половину стороны, растворение креста зеркалом и сглаживание с',
  'заворотом (стык 0,38 при обычной разнице соседних пикселей 0,05 — то есть',
  'кромка ничем не отличается от любого другого места плитки), затем отклонение',
  'уходит в ЦВЕТ плитки через ограниченную кривую со средним ровно `--bg-scene`.',
  '',
  '⚠️ Плита 2048x2048 в репозиторий НЕ кладётся — тем же правилом, что и плиты 4K',
  'выше (5,7 МБ на файл, `.git` уже 179 МБ). Путь к ней передаётся аргументом;',
  'превью и промпт лежат в `.planning/quick/20260903-scene-texture/`, задание у',
  'Higgsfield забирается по идентификатору варианта.',
  '',
];
async function processClientSources(): Promise<string[]> {
  if (
    CLIENT_SOURCES.length === 0 &&
    CLIENT_GRADIENTS.length === 0 &&
    CLIENT_GROUPS.length === 0 &&
    CLIENT_BUSTS.length === 0 &&
    CLIENT_NAME_MASKS.length === 0 &&
    CLIENT_CLOUDS.length === 0
  ) {
    return [];
  }

  const sections: string[] = [
    '## Кадры, переданные заказчиком',
    '',
    `Пакет получен **${CLIENT_RECEIVED}** (каталог \`${CLIENT_PACK_DIR}/\`, 124 файла, 172 МБ).`,
    '',
    '⛔ Исходники в git не попадают: правило в `.gitignore`. В репозитории лежат',
    'только обработанные версии из таблиц ниже. Лицензия Commons к ним неприменима —',
    'права даны заказчиком напрямую и записаны здесь дословно.',
    '',
    '⚠️ Все присланные фоны и росчерки — **полупрозрачные накладки** (у фонов альфа',
    '16..32 из 255 в среднем, у росчерков карточек 66/153), а не самостоятельные',
    'фотографии. В репозиторий каждая едет уже сведённой с поверхностью, на которой',
    'лежит: фоны страницы — на `--bg` (#07090b), росчерки карточек — на поверхность',
    'карточки `#12131a` из макета. Подложка каждого файла названа в его строке ниже.',
    '',
  ];

  for (const src of CLIENT_SOURCES) {
    if (!wanted(src.slug)) continue;

    if (src.removed) {
      console.log(
        `${src.slug}: пропущен — кадр снят (${src.removed.original} → ${src.removed.produced})`
      );
      sections.push(
        [
          `### ${src.slug}.jpg`,
          '',
          `- **Роль на странице:** ${src.removed.note} ${src.role}`,
          `- **Источник:** передано заказчиком, каталог \`${src.file}\``,
          `- **Права:** ${CLIENT_RIGHTS}`,
          `- **Дата получения:** ${CLIENT_RECEIVED}`,
          `- **Оригинал:** ${src.removed.original}, PNG с альфа-каналом`,
          `- **В репозитории:** файла нет; до удаления — ` +
            `\`src/assets/media/${src.slug}.jpg\`, ${src.removed.produced}, ` +
            `JPEG q${src.quality}, сведён на \`${src.flattenOver}\`, цветокоррекции нет`,
          '',
        ].join('\n')
      );
      continue;
    }

    const absolute = path.join(projectRoot, src.file);
    try {
      await access(absolute);
    } catch {

      throw new Error(
        `Исходник заказчика не найден: ${src.file}\n` +
          `Ожидался по пути ${absolute}.\n` +
          `Каталог «${CLIENT_PACK_DIR}» в .gitignore и на новой машине его нет — ` +
          `он передаётся отдельно, вместе с доступами (docs/ACCESS-SETUP.md).`
      );
    }

    const originalBytes = (await statFile(absolute)).size;
    const probe = await sharp(absolute).metadata();
    const region = cropRegion(src, probe.width!, probe.height!);
    const outPath = path.join(outDir, `${src.slug}.jpg`);

    await sharp(absolute)
      .extract(region)
      .resize({ width: src.width, height: src.height, fit: 'cover' })

      .flatten({ background: src.flattenOver })
      .jpeg({ quality: src.quality, chromaSubsampling: '4:4:4', mozjpeg: true })
      .toFile(outPath);

    const outBytes = (await statFile(outPath)).size;
    const outMeta = await sharp(outPath).metadata();
    console.log(
      `${src.slug}: ${outMeta.width}x${outMeta.height}, ${kb(outBytes)} ` +
        `(исходник ${probe.width}x${probe.height}, ${mb(originalBytes)}) [передано заказчиком]`
    );

    sections.push(
      [
        `### ${src.slug}.jpg`,
        '',
        `- **Роль на странице:** ${src.role}`,
        `- **Источник:** передано заказчиком, каталог \`${src.file}\``,
        `- **Права:** ${CLIENT_RIGHTS}`,
        `- **Дата получения:** ${CLIENT_RECEIVED}`,
        `- **Оригинал:** ${probe.width}x${probe.height}, ${mb(originalBytes)}, PNG с альфа-каналом`,
        `- **В репозитории:** \`src/assets/media/${src.slug}.jpg\`, ` +
          `${outMeta.width}x${outMeta.height}, ${kb(outBytes)}, JPEG q${src.quality}, ` +
          `сведён на \`${src.flattenOver}\`, цветокоррекции нет`,
        '',
      ].join('\n')
    );
  }

  if (CLIENT_GRADIENTS.length > 0) {
    sections.push(
      '### Фоны, заменённые CSS-градиентом',
      '',
      'Эти файлы в репозиторий **не едут вовсе**. Решение принято замером, а не',
      'на глаз: среднее абсолютное отклонение отрисованного градиента от',
      'уменьшенного исходника при пороге **2 единицы на канал из 255**',
      '(шесть остановок, ширины показа 1200 и 1920, сведение на `#07090b`).',
      '',
      '| Исходник | Что на кадре | Отклонение | Градиент |',
      '|---|---|---|---|',
      ...CLIENT_GRADIENTS.map(
        (g) =>
          `| \`${CLIENT_PACK_DIR}/фоны/${g.source}\` | ${g.note} | ` +
          `MAD ${g.mad.toFixed(3)} из 2 | \`${g.css}\` |`
      ),
      '',
      `Права те же: ${CLIENT_RIGHTS}. Дата получения: ${CLIENT_RECEIVED}.`,
      ''
    );
  }

  sections.push(...(await processClientGroups()));
  sections.push(...(await processClientBusts()));
  sections.push(...(await processClientNameMasks()));
  sections.push(...(await processClientClouds()));

  return sections;
}

const onlyArg = (() => {
  const i = process.argv.indexOf('--only');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith('--only='));
  return inline ? inline.slice('--only='.length) : null;
})();

const onlyList =
  onlyArg === null ? null : onlyArg.split(',').map((s) => s.trim()).filter(Boolean);
const wanted = (slug: string) => onlyList === null || onlyList.includes(slug);

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const credits: string[] = [];

  for (const src of SOURCES) {
    if (!wanted(src.slug)) continue;

    if (src.removed) {
      console.log(
        `${src.slug}: пропущен — кадр снят (${src.removed.original} → ${src.removed.produced})`
      );
      credits.push(
        [
          `### ${src.slug}.jpg`,
          '',
          `- **Роль на странице:** ${src.removed.note} ${src.role}`,
          `- **Источник:** [${src.commonsTitle}](${src.removed.descriptionUrl})`,
          `- **Лицензия:** ${src.removed.license}`,
          `- **Автор:** ${src.removed.artist}`,
          `- **Оригинал:** ${src.removed.original}`,
          `- **В репозитории:** файла нет; до удаления — ` +
            `\`src/assets/media/${src.slug}.jpg\`, ${src.removed.produced}, ` +
            `цветокоррекция \`${src.grade}\``,
          '',
        ].join('\n')
      );
      continue;
    }

    const meta = await fetchCommonsMeta(src.commonsTitle);
    if (!ALLOWED_LICENSE.test(meta.license)) {
      throw new Error(
        `Лицензия "${meta.license}" у ${src.commonsTitle} не входит в разрешённые (CC0 / Public domain).`
      );
    }
    await sleep(800);

    const res = await fetchWithRetry(meta.url);
    const raw = Buffer.from(await res.arrayBuffer());

    const probe = await sharp(raw).metadata();
    const region = cropRegion(src, probe.width!, probe.height!);

    const outPath = path.join(outDir, `${src.slug}.jpg`);
    await grade(
      sharp(raw)
        .extract(region)
        .resize({ width: src.width, height: src.height, fit: 'cover' }),
      src.grade
    )

      .jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true })
      .toFile(outPath);

    const stat = await sharp(outPath).metadata();
    console.log(
      `${src.slug}: ${stat.width}x${stat.height} [${meta.license}] by ${meta.artist || 'н/д'}`
    );

    credits.push(
      [
        `### ${src.slug}.jpg`,
        '',
        `- **Роль на странице:** ${src.role}`,
        `- **Источник:** [${src.commonsTitle}](${meta.descriptionurl})`,
        `- **Лицензия:** ${meta.license}`,
        `- **Автор:** ${meta.artist || 'не указан'}`,
        `- **Оригинал:** ${meta.width}x${meta.height}`,
        `- **В репозитории:** \`src/assets/media/${src.slug}.jpg\`, ${stat.width}x${stat.height}, цветокоррекция \`${src.grade}\``,
        '',
      ].join('\n')
    );
    await sleep(800);
  }

  const clientCredits = await processClientSources();

  if (onlyArg !== null) {
    console.log(
      `\n⚠️ Прогон с --only ${onlyArg}: docs/media-credits.md НЕ переписан.\n` +
        '   Файл собирается из полного набора; записанный по одному кадру, он\n' +
        '   потерял бы происхождение всех остальных. Полный прогон без --only\n' +
        '   вернёт его в согласованное состояние.'
    );
    return;
  }

  await writeFile(
    creditsPath,
    [
      '# Происхождение изображений',
      '',
      'Файл генерируется `scripts/prepare-media.ts`. Руками не править.',
      '',

      '> ⚠️ **07.09.2026 — ДОКУМЕНТ ПРИВЕДЁН В СООТВЕТСТВИЕ С ГЕНЕРАТОРОМ ВРУЧНУЮ, И ЭТО НАЗВАНО ВСЛУХ.**',
      '> Полный прогон `npm run prepare:media` требует сети (API Commons) и 172-МБ пакета',
      '> заказчика, которого на машине может не быть, а прогон без `--only` перезаписывает',
      '> ВСЕ мастер-кадры — поэтому заход `20260907-actualize` его не запускал.',
      '> Источником правды остаётся `scripts/prepare-media.ts`: разделы шести снятых',
      '> кадров и роль `ub-downtown-dusk` перенесены сюда МАШИНОЙ из самого генератора',
      '> (разбор массива `CLIENT_SOURCES` теми же шаблонами строк), а не переписаны руками.',
      '> ⛔ Следующий полный `npm run prepare:media` обязан воспроизвести этот же текст,',
      '> включая эту врезку — она живёт в шапке генератора, а не только здесь.',
      '> Если прогон текст изменит — расхождение искать в генераторе, а не «поправить»',
      '> здесь: ручная правка этого файла отменяется первым же полным прогоном.',
      '>',
      '> **Что именно изменилось 07.09.2026** (находки D-04/D-05 ревью 07.09.2026):',
      '> шесть кадров описывались как живые, хотя их нет в `src/assets/media/` —',
      '> `client-city-haze`, `client-tower-rays`, `client-bokeh-hills`,',
      '> `client-card-affiliate`, `client-card-bank`, `client-card-teamcash`;',
      '> седьмой (`ub-downtown-dusk`) ~~в репозитории есть, но на странице не работает~~ —',
      '> ⛔ **УДАЛЁН 07.09.2026 решением заказчика, дословно «удалять»** (заход',
      '> `20260907-decisions`). Прежняя редакция строки сохранена ЗАЧЁРКНУТОЙ, а не',
      '> стёрта: проект дважды платил за стирание отменённого.',
      '> Записи о ПРАВАХ не удалены ни у одного из семи — документ происхождения',
      '> кадров это юридический артефакт, и снятие файла не отменяет того, кем и',
      '> какими словами даны права.',
      '>',
      '> **Второй круг 07.09.2026** (заход `20260907-decisions`, решение заказчика',
      '> «удалять»): у ветки Commons появился свой флаг снятого кадра',
      '> (`RemovedCommonsFrame`) — её права даёт лицензия из ответа API, а не слово',
      '> заказчика, поэтому переиспользовать `RemovedFrame` было нельзя. Лицензия',
      '> `CC0`, автор `Enkhgerele`, адрес описания и оба размера `ub-downtown-dusk`',
      '> перенесены в рецепт ДОСЛОВНО из последнего живого прогона и',
      '> воспроизводятся генератором. Сам файл снят через `git rm` и восстановим',
      '> из истории: `git show af79558:src/assets/media/ub-downtown-dusk.jpg`.',
      '> Соответствие документа генератору проверено МАШИНОЙ (разбор массива',
      '> `SOURCES` и шапки теми же шаблонами строк) — прибор',
      '> `.planning/quick/20260907-decisions/tools/sverka-credits.mjs`.',
      '',
      'Источника ТРИ, и правила у них РАЗНЫЕ. Путать их нельзя: у первого права',
      'даёт лицензия в ответе API, у второго — слово заказчика, у третьего —',
      'оплаченная заказчиком подписка на генератор. Прежняя редакция гласила',
      '«источников два» и устарела 02.09.2026.',
      '',
      '## Кадры из Wikimedia Commons',
      '',
      'В набор допускаются **только CC0 и Public Domain**: у проекта уже есть',
      'правовая экспозиция по основному предмету (онлайн-беттинг запрещён в',
      'Монголии с 30.05.2025), поэтому share-alike и обязательная атрибуция в',
      'коммерческом лендинге не используются. Скрипт останавливается, если',
      'лицензия кадра не входит в разрешённые.',
      '',
      ...credits,
      ...clientCredits,
      ...AI_PLATES,
    ].join('\n'),
    'utf8'
  );

  const clientLive = CLIENT_SOURCES.filter((src) => !src.removed).length;
  const clientRemoved = CLIENT_SOURCES.length - clientLive;

  const commonsLive = SOURCES.filter((src) => !src.removed).length;
  const commonsRemoved = SOURCES.length - commonsLive;
  console.log(
    `\nOK  docs/media-credits.md — ${commonsLive} кадр(ов) Commons ` +
      `(+${commonsRemoved} снятых, только запись о правах) + ` +
      `${clientLive} кадр(ов) заказчика (+${clientRemoved} снятых, только запись о правах) + ` +
      `${CLIENT_GRADIENTS.length} градиент(ов)`
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
