
import { test, expect } from '@playwright/test';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';

const LOCALES: Locale[] = ['mn', 'ru', 'en'];

const DESKTOP_WIDTHS = [1050, 1440, 1920] as const;
const VIEWPORT_HEIGHT = 900;

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface StepMeasurement {
  stepBox: Rect;
  pseudo: { left: number; top: number; width: number };
  titleRects: Rect[];
  textRects: Rect[];
  nodeRects: Rect[];
}

const SUBPIXEL_NOISE_EPSILON = 0.05;

const GEOMETRY_TOLERANCE = 0.5;

const MIN_DIGIT_CLEARANCE = 10;

function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.left < b.right - SUBPIXEL_NOISE_EPSILON &&
    a.right > b.left + SUBPIXEL_NOISE_EPSILON &&
    a.top < b.bottom - SUBPIXEL_NOISE_EPSILON &&
    a.bottom > b.top + SUBPIXEL_NOISE_EPSILON
  );
}

test.describe('Коннекторы между шагами «Как начать» одинаковы и висят в промежутке', () => {
  for (const width of DESKTOP_WIDTHS) {
    for (const locale of LOCALES) {
      test(`геометрия коннекторов при ${width}px (${locale})`, async ({ page }) => {
        await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
        await page.goto(PAGE_ROUTES.home[locale]);

        const section = page.locator('#how-to-start');
        await section.scrollIntoViewIfNeeded();

        const steps = page.locator('.spine-step');
        await expect(steps).toHaveCount(3);

        const measurements: StepMeasurement[] = await section.evaluate((sectionEl) => {
          function collectTextRects(root: Element | null): Rect[] {
            if (!root) return [];
            const rects: Rect[] = [];
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              if (!node.textContent || !node.textContent.trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              for (const r of Array.from(range.getClientRects())) {
                if (r.width > 0 && r.height > 0) {
                  rects.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
                }
              }
            }
            return rects;
          }

          const stepEls = Array.from(sectionEl.querySelectorAll('.spine-step'));
          return stepEls.map((stepEl) => {
            const box = stepEl.getBoundingClientRect();
            const cs = getComputedStyle(stepEl, '::before');
            return {
              stepBox: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
              pseudo: {
                left: parseFloat(cs.left),
                top: parseFloat(cs.top),
                width: parseFloat(cs.width),
              },
              titleRects: collectTextRects(stepEl.querySelector('.spine-title')),
              textRects: collectTextRects(stepEl.querySelector('.spine-text')),
              nodeRects: collectTextRects(stepEl.querySelector('.spine-node')),
            };
          });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any;

        expect(measurements.length, 'три шага должны отрендериться').toBe(3);

        const allTextRects: Rect[] = measurements.flatMap((s) => [
          ...s.titleRects,
          ...s.textRects,
          ...s.nodeRects,
        ]);

        const connectorWidths: number[] = [];

        for (const bondIndex of [0, 1] as const) {
          const current = measurements[bondIndex];
          const next = measurements[bondIndex + 1];

          const connector: Rect = {
            left: current.stepBox.left + current.pseudo.left,
            top: current.stepBox.top + current.pseudo.top,
            right: current.stepBox.left + current.pseudo.left + current.pseudo.width,
            bottom: current.stepBox.top + current.pseudo.top + 1,
          };

          const bondLabel = `связка ${bondIndex + 1}→${bondIndex + 2} при ${width}px/${locale}`;
          connectorWidths.push(current.pseudo.width);

          for (const textRect of allTextRects) {
            const intersects = rectsIntersect(connector, textRect);
            expect(
              intersects,
              `${bondLabel}: коннектор ` +
                `[${connector.left.toFixed(1)}..${connector.right.toFixed(1)}]x[${connector.top.toFixed(1)}..${connector.bottom.toFixed(1)}] ` +
                `пересекает текстовый узел [${textRect.left.toFixed(1)}..${textRect.right.toFixed(1)}]x[${textRect.top.toFixed(1)}..${textRect.bottom.toFixed(1)}]`,
            ).toBe(false);
          }

          const insetLeft = connector.left - current.stepBox.right;
          const insetRight = next.stepBox.left - connector.right;

          expect(
            insetLeft,
            `${bondLabel}: левый конец линии вылез из промежутка грида внутрь колонки (отступ ${insetLeft.toFixed(2)}px)`,
          ).toBeGreaterThan(0);
          expect(
            insetRight,
            `${bondLabel}: правый конец линии вылез из промежутка грида внутрь колонки (отступ ${insetRight.toFixed(2)}px)`,
          ).toBeGreaterThan(0);
          expect(
            Math.abs(insetLeft - insetRight),
            `${bondLabel}: линия стоит в промежутке несимметрично — слева ${insetLeft.toFixed(2)}px, справа ${insetRight.toFixed(2)}px`,
          ).toBeLessThanOrEqual(GEOMETRY_TOLERANCE);

          const nextDigitLeft = Math.min(...next.nodeRects.map((r) => r.left));
          const digitClearance = nextDigitLeft - connector.right;
          expect(
            digitClearance,
            `${bondLabel}: линия подошла к чернилам цифры ${bondIndex + 2} на ${digitClearance.toFixed(2)}px (порог ${MIN_DIGIT_CLEARANCE}px)`,
          ).toBeGreaterThanOrEqual(MIN_DIGIT_CLEARANCE);

          const digitTop = Math.min(...current.nodeRects.map((r) => r.top));
          const digitBottom = Math.max(...current.nodeRects.map((r) => r.bottom));
          const digitCenterY = (digitTop + digitBottom) / 2;

          expect(
            Math.abs(connector.top - digitCenterY),
            `${bondLabel}: вертикаль коннектора (${connector.top.toFixed(2)}px) разошлась с центром цифры (${digitCenterY.toFixed(2)}px) больше чем на 2px`,
          ).toBeLessThanOrEqual(2);
        }

        expect(
          Math.abs(connectorWidths[0] - connectorWidths[1]),
          `при ${width}px/${locale}: линии разной длины — 1→2 ${connectorWidths[0].toFixed(2)}px, ` +
            `2→3 ${connectorWidths[1].toFixed(2)}px`,
        ).toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
      });
    }
  }
});
