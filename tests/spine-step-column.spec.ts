
import { test, expect } from '@playwright/test';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';

const LOCALES: Locale[] = ['mn', 'ru', 'en'];
const DESKTOP_WIDTHS = [1050, 1440, 1920] as const;
const VIEWPORT_HEIGHT = 900;

const SAME_ROW_TOLERANCE = 4;

const MAX_TAIL = 0.6;

interface Measurement {
  colWidth: number;
  colRight: number;
  nodeW: number;
  buttons: {
    label: string;
    top: number;
    right: number;
    width: number;
    innerWidth: number;
    inkWidth: number;
    overflow: number;
  }[];
  pairLeft: number;
  pairRight: number;
  docScrollWidth: number;
  innerViewportWidth: number;
}

test.describe('Колонка шага 1 сжата до пары кнопок, пара цела', () => {
  for (const width of DESKTOP_WIDTHS) {
    for (const locale of LOCALES) {
      test(`колонка и пара при ${width}px (${locale})`, async ({ page }) => {
        await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
        await page.goto(PAGE_ROUTES.home[locale]);

        const section = page.locator('#how-to-start');
        await section.scrollIntoViewIfNeeded();

        const m: Measurement = await section.evaluate((sectionEl) => {

          function inkWidth(root: Element | null): number {
            if (!root) return 0;
            let left = Infinity;
            let right = -Infinity;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              if (!node.textContent || !node.textContent.trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              for (const r of Array.from(range.getClientRects())) {
                if (r.width <= 0 || r.height <= 0) continue;
                left = Math.min(left, r.left);
                right = Math.max(right, r.right);
              }
            }
            return right > left ? right - left : 0;
          }

          const step = sectionEl.querySelector('.spine-step') as HTMLElement;
          const stepBox = step.getBoundingClientRect();
          const spine = sectionEl.querySelector('.spine') as HTMLElement;
          const nodeW = parseFloat(
            getComputedStyle(spine).getPropertyValue('--spine-node-w'),
          );

          const btnEls = Array.from(step.querySelectorAll('.contact-btn'));
          const buttons = btnEls.map((b) => {
            const r = b.getBoundingClientRect();
            const cs = getComputedStyle(b);
            const label = b.querySelector('span:not(.contact-btn__icon)');
            return {
              label: (b.textContent ?? '').trim(),
              top: r.top,
              right: r.right,
              width: r.width,
              innerWidth: r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
              inkWidth: inkWidth(label),
              overflow: b.scrollWidth - b.clientWidth,
            };
          });

          const rects = btnEls.map((b) => b.getBoundingClientRect());

          return {
            colWidth: stepBox.width,
            colRight: stepBox.right,
            nodeW,
            buttons,
            pairLeft: Math.min(...rects.map((r) => r.left)),
            pairRight: Math.max(...rects.map((r) => r.right)),
            docScrollWidth: document.documentElement.scrollWidth,
            innerViewportWidth: window.innerWidth,
          };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any;

        const at = `${width}px/${locale}`;

        expect(m.buttons.length, `${at}: в шаге 1 должно быть ровно 2 кнопки связи`).toBe(2);

        const rowDelta = Math.abs(m.buttons[0].top - m.buttons[1].top);
        expect(
          rowDelta,
          `${at}: пара шага сложилась в столбик — верх кнопок разошёлся на ${rowDelta.toFixed(1)}px ` +
            `(«${m.buttons[0].label}» ${m.buttons[0].top.toFixed(1)}, «${m.buttons[1].label}» ${m.buttons[1].top.toFixed(1)})`,
        ).toBeLessThanOrEqual(SAME_ROW_TOLERANCE);

        for (const b of m.buttons) {
          expect(
            b.inkWidth,
            `${at}: подпись «${b.label}» (${b.inkWidth.toFixed(1)}px чернил) не помещается во ` +
              `внутреннюю ширину кнопки ${b.innerWidth.toFixed(1)}px`,
          ).toBeLessThanOrEqual(b.innerWidth + 0.5);
          expect(
            b.overflow,
            `${at}: содержимое кнопки «${b.label}» переливается за её границы на ${b.overflow}px`,
          ).toBeLessThanOrEqual(0);
        }

        const pairWidth = m.pairRight - m.pairLeft;
        const floor = pairWidth + m.nodeW;
        expect(
          m.colWidth,
          `${at}: колонка шага 1 (${m.colWidth.toFixed(1)}px) уже своего содержимого — ` +
            `пара занимает ${pairWidth.toFixed(1)}px плюс колонка цифры ${m.nodeW}px`,
        ).toBeGreaterThanOrEqual(floor);

        const tail = m.colRight - m.pairRight;
        expect(
          tail,
          `${at}: колонка шага 1 заканчивается не по кнопке — после пары остаётся ${tail.toFixed(1)}px пустоты ` +
            `(этот же хвост уводит золотую линию 1→2 к цифре «2»)`,
        ).toBeLessThanOrEqual(MAX_TAIL);

        const overflow = m.docScrollWidth - m.innerViewportWidth;
        expect(
          overflow,
          `${at}: страница едет вбок на ${overflow}px`,
        ).toBeLessThanOrEqual(0);
      });
    }
  }
});
