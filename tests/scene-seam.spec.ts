import { chromium, expect, test, webkit, type Page } from '@playwright/test';
import sharp from 'sharp';
import { DESKTOP_VIEWPORT, MOBILE_VIEWPORT, PREVIEW_PORT } from '../playwright.config.ts';

const SKRYT_SODERZHIMOE = `
  .site-header, .site-header *,
  .consent-banner, .consent-banner * { visibility: hidden !important; }
  .page-surface *, .hero * { visibility: hidden !important; }
  .scene-layer, .scene-layer *,
  .hero-media, .hero-media *,
  .hero-scrim,
  .hero-haze, .hero-haze * { visibility: visible !important; }
`;

const BEZ_FOTO = '.hero-media { display: none !important; }';
const BEZ_MASOK = '* { -webkit-mask-image: none !important; mask-image: none !important; }';

const median = (a: number[]): number => {
  a.sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

async function hudshayaKromka(
  page: Page,
  dopolnitelno: string[] = [],
): Promise<{ e: number; y: number; shov: number; shovY: number }> {

  await page.addStyleTag({
    content: 'html{scrollbar-width:none}::-webkit-scrollbar{display:none}',
  });
  await page.addStyleTag({ content: SKRYT_SODERZHIMOE });
  for (const css of dopolnitelno) await page.addStyleTag({ content: css });

  const size = page.viewportSize()!;
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const heroBottom = await page.evaluate(
    () => Math.round(document.querySelector('.hero')!.getBoundingClientRect().bottom + window.scrollY),
  );
  const zoneTop = Math.max(0, heroBottom - 300);
  const zoneBot = zoneTop + 900;

  await page.evaluate(async (z: number) => {
    for (const y of [z, z + 600, z + 1200, z]) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
  }, zoneTop);
  await page.waitForTimeout(700);

  let worst = { e: 0, y: 0 };

  let shov = { e: 0, y: 0 };
  for (const start of [zoneTop, Math.max(zoneTop, zoneBot - size.height)]) {
    await page.evaluate((y: number) => window.scrollTo(0, y), start);
    await page.waitForTimeout(250);
    const realTop = await page.evaluate(() => Math.round(window.scrollY));
    const buf = await page.screenshot({ clip: { x: 0, y: 0, width: size.width, height: size.height } });
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    const ch = info.channels;
    const rows = Math.floor(info.height / dpr);
    const lum = new Float32Array(rows * info.width);
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < info.width; x++) {
        let s = 0;
        for (let k = 0; k < dpr; k++) {
          const i = ((y * dpr + k) * info.width + x) * ch;
          s += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }
        lum[y * info.width + x] = s / dpr;
      }
    const diff = new Array<number>(info.width);
    for (let y = 1; y < rows; y++) {
      const ay = realTop + y;
      if (ay < zoneTop || ay > zoneBot) continue;
      for (let x = 0; x < info.width; x++) diff[x] = lum[y * info.width + x] - lum[(y - 1) * info.width + x];
      const e = median(diff.slice());
      if (Math.abs(e) > Math.abs(worst.e)) worst = { e, y: ay };
      if (ay >= heroBottom - 2 && ay <= heroBottom + 3 && Math.abs(e) > Math.abs(shov.e)) shov = { e, y: ay };
    }
  }
  return { ...worst, shov: shov.e, shovY: shov.y };
}

const DVIZHKI = { chromium, webkit };
const ADRES = `http://127.0.0.1:${PREVIEW_PORT}/`;
const OKNA = [
  { name: 'телефон 390×844', viewport: MOBILE_VIEWPORT, touch: true },
  { name: 'десктоп 1440×900', viewport: DESKTOP_VIEWPORT, touch: false },
];

for (const [imya, dvizhok] of Object.entries(DVIZHKI)) {
  test.describe(`Шов первого экрана и сцены — ${imya}`, () => {
    for (const okno of OKNA) {
      test(`сцена без прямых кромок (${okno.name})`, async () => {
        const browser = await dvizhok.launch();
        const page = await browser.newPage({ viewport: okno.viewport, hasTouch: okno.touch });
        await page.goto(ADRES);
        const worst = await hudshayaKromka(page, [BEZ_FOTO]);
        await browser.close();

        expect(
          Math.abs(worst.e),
          `прямая кромка ${worst.e.toFixed(2)} из 255 на y=${worst.y}: сцена рисует линию через весь экран`,
        ).toBeLessThanOrEqual(6);

        expect(
          Math.abs(worst.shov),
          `строка стыка выделяется на ${worst.shov.toFixed(2)} из 255 (y=${worst.shovY}) — вернулась «полоса между первым и вторым блоком»`,
        ).toBeLessThanOrEqual(2);
      });

      test(`сцена не разваливается в прямоугольники без масок (${okno.name})`, async () => {
        const browser = await dvizhok.launch();
        const page = await browser.newPage({ viewport: okno.viewport, hasTouch: okno.touch });
        await page.goto(ADRES);

        const worst = await hudshayaKromka(page, [BEZ_FOTO, BEZ_MASOK]);
        await browser.close();
        expect(
          Math.abs(worst.e),
          `без масок прямая кромка ${worst.e.toFixed(2)} из 255 на y=${worst.y}`,
        ).toBeLessThanOrEqual(12);
      });

      test(`общая картина вместе с фотографией (${okno.name})`, async () => {
        const browser = await dvizhok.launch();
        const page = await browser.newPage({ viewport: okno.viewport, hasTouch: okno.touch });
        await page.goto(ADRES);
        const worst = await hudshayaKromka(page);
        await browser.close();

        expect(
          Math.abs(worst.e),
          `прямая кромка ${worst.e.toFixed(2)} из 255 на y=${worst.y}`,
        ).toBeLessThanOrEqual(12);
      });
    }
  });
}

test.describe('Строка стыка прокрашена', () => {
  test('маркер первого экрана несёт краску грунта, а не дыру в 1px', async ({ page }) => {
    await page.goto('/');
    const { markerBg, groundStart } = await page.evaluate(() => {
      const marker = document.querySelector('#hero-sentinel')!;
      const surface = document.querySelector('.page-surface')!;
      return {
        markerBg: getComputedStyle(marker).backgroundColor,
        groundStart: getComputedStyle(surface).backgroundImage,
      };
    });

    expect(markerBg, 'маркер снова прозрачен — вернулась полоса на стыке').not.toBe('rgba(0, 0, 0, 0)');

    const rgb = markerBg.match(/\d+/g)!.slice(0, 3).join(', ');
    expect(groundStart, 'грунт сцены больше не стартует цветом маркера').toContain(rgb);
  });
});
