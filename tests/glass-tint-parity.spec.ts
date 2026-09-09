import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { DESKTOP_VIEWPORT, MOBILE_VIEWPORT } from '../playwright.config.ts';

const ROVNYJ_GRUNT = `
  .scene-layer { display: none !important; }
  .page-surface {
    background-image: none !important;
    background-color: #0c1017 !important;
  }
`;

const KOROBKA = { w: 320, h: 150 };

type Proba = { telo: [number, number, number]; gran: number };

const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};

async function postavitRyadom(
  page: import('@playwright/test').Page,
  etalonSel: string,
): Promise<{ card: DOMRect; etalon: DOMRect } | null> {
  return page.evaluate(
    ({ sel, box }) => {
      const card = document.querySelector('.direction-card');
      const etalon = document.querySelector(sel);
      if (!card || !etalon) return null;

      const host = document.createElement('div');
      host.id = 'zamok-ottenka';

      host.style.cssText = 'display:flex;flex-direction:column;gap:24px;padding:24px;align-items:flex-start;';

      const plita = (src: Element, mark: string): void => {
        const c = src.cloneNode(true) as HTMLElement;
        c.removeAttribute('open');
        c.removeAttribute('id');
        c.dataset.proba = mark;

        c.replaceChildren();

        c.classList.remove('reveal-item', 'is-revealed');
        c.style.setProperty('opacity', '1', 'important');
        c.style.setProperty('animation', 'none', 'important');
        c.style.setProperty('transform', 'none', 'important');
        c.style.setProperty('width', `${box.w}px`, 'important');
        c.style.setProperty('min-width', `${box.w}px`, 'important');
        c.style.setProperty('height', `${box.h}px`, 'important');
        c.style.setProperty('margin', '0', 'important');
        host.appendChild(c);
      };
      plita(card, 'card');
      plita(etalon, 'etalon');

      const acc = document.querySelector('.direction-accordion');
      acc!.parentElement!.insertBefore(host, acc);
      host.scrollIntoView({ block: 'center' });

      const hr = host.getBoundingClientRect();
      const rect = (mark: string): DOMRect => {
        const r = host.querySelector(`[data-proba="${mark}"]`)!.getBoundingClientRect();
        return { x: r.left - hr.left, y: r.top - hr.top, width: r.width, height: r.height } as DOMRect;
      };
      return { card: rect('card'), etalon: rect('etalon') };
    },
    { sel: etalonSel, box: KOROBKA },
  );
}

function razobrat(
  raw: Buffer,
  W: number,
  ch: number,
  r: DOMRect,
  k: number,
): Proba {
  const x0 = Math.round(r.x * k);
  const y0 = Math.round(r.y * k);
  const w = Math.round(r.width * k);
  const h = Math.round(r.height * k);

  const pad = Math.round(32 * k);
  const R: number[] = [], G: number[] = [], B: number[] = [];
  for (let y = y0 + pad; y < y0 + h - pad; y += 1) {
    for (let x = x0 + pad; x < x0 + w - pad; x += 1) {
      const o = (y * W + x) * ch;
      R.push(raw[o]); G.push(raw[o + 1]); B.push(raw[o + 2]);
    }
  }

  let gran = 0;
  for (let y = y0; y < y0 + Math.max(4, Math.round(4 * k)); y += 1) {
    for (let x = x0 + Math.round(w * 0.3); x < x0 + Math.round(w * 0.7); x += 1) {
      const o = (y * W + x) * ch;
      const lum = 0.2126 * raw[o] + 0.7152 * raw[o + 1] + 0.0722 * raw[o + 2];
      if (lum > gran) gran = lum;
    }
  }

  return { telo: [median(R), median(G), median(B)], gran: Math.round(gran) };
}

const POROG_TELA = 3;
const POROG_GRANI_OTN = 0.12;

for (const okno of [
  { name: 'десктоп', viewport: DESKTOP_VIEWPORT, etalon: '.faq-item' },
  { name: 'телефон', viewport: MOBILE_VIEWPORT, etalon: '.faq-accordion' },
]) {
  test.describe(`Оттенок стекла на грунте эталона (${okno.name})`, () => {
    test.use({ viewport: okno.viewport });

    test('карточка садится на оттенок эталона там, где эталон живёт', async ({ page }) => {
      await page.goto('/ru/', { waitUntil: 'networkidle' });
      await page.addStyleTag({ content: ROVNYJ_GRUNT });
      await page.waitForTimeout(200);

      const rects = await postavitRyadom(page, okno.etalon);
      expect(rects, `эталонная поверхность ${okno.etalon} должна быть на странице`).not.toBeNull();
      await page.waitForTimeout(500);

      const host = page.locator('#zamok-ottenka');
      const buf = await host.screenshot({ type: 'png' });
      const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
      const hostBox = (await host.boundingBox())!;
      const k = info.width / hostBox.width;

      const card = razobrat(data, info.width, info.channels, rects!.card, k);
      const etalon = razobrat(data, info.width, info.channels, rects!.etalon, k);

      const kanaly = ['R', 'G', 'B'] as const;
      for (let i = 0; i < 3; i += 1) {
        const d = Math.abs(card.telo[i] - etalon.telo[i]);
        expect(
          d,
          `тело: канал ${kanaly[i]} — карточка ${card.telo.join(',')}, эталон ${etalon.telo.join(',')}`,
        ).toBeLessThanOrEqual(POROG_TELA);
      }

      expect(
        Math.abs(card.gran - etalon.gran) / Math.max(1, etalon.gran),
        `грань: пик карточки ${card.gran}, пик эталона ${etalon.gran}`,
      ).toBeLessThanOrEqual(POROG_GRANI_OTN);
    });
  });
}
