import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { DESKTOP_VIEWPORT, MOBILE_VIEWPORT } from '../playwright.config.ts';

const GRUNTY = [
  { id: 'облако яркое', color: '#59738b', rgb: [89, 115, 139] },
  { id: 'тон средний', color: '#1c2530', rgb: [28, 37, 48] },
  { id: 'небо вопросов', color: '#0c1017', rgb: [12, 16, 23] },
] as const;

const KOROBKA = { w: 320, h: 150 };

const POROG_PARY = 3;

const NIZHNIJ = 8;

const DOLJA_VERH = 0.40;

const POROG_RAVNOJ_PROZRACHNOSTI = 3;

const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};

async function postavit(
  page: import('@playwright/test').Page,
  etalonSel: string,
): Promise<{ card: DOMRect; etalon: DOMRect } | null> {
  return page.evaluate(
    ({ sel, box }) => {
      const card = document.querySelector('.direction-card');
      const etalon = document.querySelector(sel);
      if (!card || !etalon) return null;

      const host = document.createElement('div');
      host.id = 'zamok-ustojchivosti';

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

function telo(raw: Buffer, W: number, ch: number, r: DOMRect, k: number): [number, number, number] {
  const x0 = Math.round(r.x * k);
  const y0 = Math.round(r.y * k);
  const w = Math.round(r.width * k);
  const h = Math.round(r.height * k);
  const pad = Math.round(32 * k);
  const R: number[] = [];
  const G: number[] = [];
  const B: number[] = [];
  for (let y = y0 + pad; y < y0 + h - pad; y += 1) {
    for (let x = x0 + pad; x < x0 + w - pad; x += 1) {
      const o = (y * W + x) * ch;
      R.push(raw[o]);
      G.push(raw[o + 1]);
      B.push(raw[o + 2]);
    }
  }
  return [median(R), median(G), median(B)];
}

for (const okno of [
  { name: 'десктоп', viewport: DESKTOP_VIEWPORT, etalon: '.faq-item' },
  { name: 'телефон', viewport: MOBILE_VIEWPORT, etalon: '.faq-accordion' },
]) {
  test.describe(`Один материал стекла на трёх грунтах (${okno.name})`, () => {
    test.use({ viewport: okno.viewport });

    test('карточка и эталон пропускают подложку одинаково и в положенных границах', async ({ page }) => {
      await page.goto('/ru/', { waitUntil: 'networkidle' });
      await page.addStyleTag({
        content: '.scene-layer { display: none !important; }'
          + ' .page-surface { background-image: none !important; }',
      });
      const rects = await postavit(page, okno.etalon);
      expect(rects, `эталонная поверхность ${okno.etalon} должна быть на странице`).not.toBeNull();

      const host = page.locator('#zamok-ustojchivosti');
      const zamer: { grunt: string; card: number[]; etalon: number[] }[] = [];

      for (const grunt of GRUNTY) {
        await page.evaluate((color) => {
          let s = document.getElementById('grunt-proby');
          if (!s) {
            s = document.createElement('style');
            s.id = 'grunt-proby';
            document.head.appendChild(s);
          }
          s.textContent = `.page-surface { background-color: ${color} !important; }`;
        }, grunt.color);
        await page.waitForTimeout(400);

        const buf = await host.screenshot({ type: 'png' });
        const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
        const box = (await host.boundingBox())!;
        const k = info.width / box.width;
        zamer.push({
          grunt: grunt.id,
          card: telo(data, info.width, info.channels, rects!.card, k),
          etalon: telo(data, info.width, info.channels, rects!.etalon, k),
        });
      }

      const svodka = zamer
        .map((z) => `${z.grunt}: карточка ${z.card.join(',')} / эталон ${z.etalon.join(',')}`)
        .join(' · ');
      const kanaly = ['R', 'G', 'B'] as const;

      const razmah = (kto: 'card' | 'etalon', i: number): number => {
        const znach = zamer.map((z) => z[kto][i]);
        return Math.max(...znach) - Math.min(...znach);
      };

      const razmahGrunta = (i: number): number => {
        const znach = GRUNTY.map((g) => g.rgb[i]);
        return Math.max(...znach) - Math.min(...znach);
      };

      for (let i = 0; i < 3; i += 1) {
        expect(
          razmah('card', i),
          `канал ${kanaly[i]}: стекло обязано ПОКАЗЫВАТЬ подложку, а не красить поверх. ${svodka}`,
        ).toBeGreaterThanOrEqual(NIZHNIJ);
        expect(
          razmah('card', i) / razmahGrunta(i),
          `канал ${kanaly[i]}: стекло пропускает больше положенного — тон снят или ослаблен. ${svodka}`,
        ).toBeLessThanOrEqual(DOLJA_VERH);
      }

      for (const z of zamer) {
        for (let i = 0; i < 3; i += 1) {
          expect(
            Math.abs(z.card[i] - z.etalon[i]),
            `канал ${kanaly[i]} на грунте «${z.grunt}». ${svodka}`,
          ).toBeLessThanOrEqual(POROG_PARY);
        }
      }

      for (let i = 0; i < 3; i += 1) {
        expect(
          Math.abs(razmah('card', i) - razmah('etalon', i)),
          `канал ${kanaly[i]}: карточка и эталон обязаны пропускать ОДИНАКОВО. ${svodka}`,
        ).toBeLessThanOrEqual(POROG_RAVNOJ_PROZRACHNOSTI);
      }
    });
  });
}
