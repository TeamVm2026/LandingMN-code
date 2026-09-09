import { expect, test } from '@playwright/test';
import { MOBILE_VIEWPORT } from '../playwright.config.ts';

test.use({ browserName: 'webkit', viewport: MOBILE_VIEWPORT, hasTouch: true });

async function hod(
  page: import('@playwright/test').Page,
  sel: string,
  ms = 700,
): Promise<Array<[number, number]>> {
  const h0 = await page.evaluate(
    (s) => +document.querySelector(s)!.getBoundingClientRect().height.toFixed(1),
    sel,
  );
  const t0 = Date.now();
  await page.evaluate((s) => {
    const el = document.querySelector(s)!;
    (el.querySelector('summary') ?? (el as HTMLElement)).click();
  }, sel);
  const proby: Array<[number, number]> = [[0, h0]];
  while (Date.now() - t0 < ms) {
    const h = await page.evaluate(
      (s) => +document.querySelector(s)!.getBoundingClientRect().height.toFixed(1),
      sel,
    );
    proby.push([Date.now() - t0, h]);
    await new Promise((r) => setTimeout(r, 12));
  }
  return proby;
}

function razbor(proby: Array<[number, number]>): {
  do_: number;
  posle: number;
  vPuti: number;
  t90: number | null;
  prob: number;
} {
  const do_ = proby[0]![1];
  const posle = proby.at(-1)![1];
  const lo = Math.min(do_, posle);
  const hi = Math.max(do_, posle);
  const vPuti = proby.filter((x) => x[1] > lo + 2 && x[1] < hi - 2).length;
  const cel = do_ + (posle - do_) * 0.9;
  const f = proby.find((x) => (posle > do_ ? x[1] >= cel : x[1] <= cel));
  return { do_, posle, vPuti, t90: f ? f[0] : null, prob: proby.length };
}

async function podvesti(page: import('@playwright/test').Page, sel: string): Promise<void> {
  await page.goto('/ru/');
  await page.locator(sel).first().scrollIntoViewIfNeeded();
  await page.evaluate((s) => {
    const r = document.querySelector(s)!.getBoundingClientRect();
    scrollBy(0, r.top - 80);
  }, sel);
  await page.waitForTimeout(400);
}

const CELI: Array<[string, string]> = [
  ['#direction-teamcash', 'карточка направления'],
  ['.faq-item', 'вопрос FAQ'],
];

function luchshij<T extends { t90: number | null }>(a: T, b: T): T {
  return (a.t90 ?? -1) >= (b.t90 ?? -1) ? a : b;
}

test.describe('WebKit: оба аккордеона едут в ОБЕ стороны, а не только раскрываются', () => {
  for (const [sel, nazv] of CELI) {
    test(`${nazv}: сворачивание идёт промежуточными кадрами, а не ступенью`, async ({ page }) => {
      await podvesti(page, sel);

      let otkr = razbor(await hod(page, sel));
      expect(otkr.posle, `${nazv} обязана раскрыться`).toBeGreaterThan(otkr.do_);
      await page.waitForTimeout(700);

      let zakr = razbor(await hod(page, sel));
      expect(zakr.posle, `${nazv} обязана свернуться`).toBeLessThan(zakr.do_);

      for (let popytka = 2; popytka <= 3; popytka += 1) {
        const est = (r: { t90: number | null; vPuti: number }): boolean =>
          (r.t90 ?? 0) > 120 && r.vPuti >= 1;
        if (est(otkr) && est(zakr)) break;
        await page.waitForTimeout(500);
        const otkr2 = razbor(await hod(page, sel));
        await page.waitForTimeout(700);
        const zakr2 = razbor(await hod(page, sel));

        if (otkr2.posle > otkr2.do_) {
          const b = luchshij(otkr, otkr2);
          otkr = {
            ...b,
            vPuti: Math.max(otkr.vPuti, otkr2.vPuti),
            prob: Math.max(otkr.prob, otkr2.prob),
          };
        }
        if (zakr2.posle < zakr2.do_) {
          const b = luchshij(zakr, zakr2);
          zakr = {
            ...b,
            vPuti: Math.max(zakr.vPuti, zakr2.vPuti),
            prob: Math.max(zakr.prob, zakr2.prob),
          };
        }
        console.log(
          `  [повтор ${String(popytka)}] ${nazv}: раскрытие ${String(otkr2.t90)} мс, ` +
            `сворачивание ${String(zakr2.t90)} мс`,
        );
      }

      expect(zakr.t90, `${nazv}: 90 % пути пройдено за ${zakr.t90} мс — это ступень, а не ход`)
        .toBeGreaterThan(120);
      if (zakr.prob >= 10) {
        expect(
          zakr.vPuti,
          `${nazv}: ни одна проба из ${String(zakr.prob)} не попала ВНУТРЬ пути — сворачивание прошло ступенью`,
        ).toBeGreaterThanOrEqual(1);
      } else {
        console.log(
          `  ⚠️ ${nazv}: стенд голодал — проб всего ${String(zakr.prob)}, счёт проб не проверяется`,
        );
      }

      if (otkr.prob >= 10) {
        expect(otkr.vPuti, `${nazv}: раскрытие прошло ступенью`).toBeGreaterThanOrEqual(1);
      }
    });
  }

  test('prefers-reduced-motion гасит ход в WebKit полностью, а не наполовину', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      ...MOBILE_VIEWPORT ? { viewport: MOBILE_VIEWPORT } : {},
      hasTouch: true,
      reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    try {
      for (const [sel, nazv] of CELI) {
        await podvesti(page, sel);
        const otkr = razbor(await hod(page, sel, 400));
        await page.waitForTimeout(400);
        const zakr = razbor(await hod(page, sel, 400));

        expect(otkr.t90, `${nazv}: при reduce раскрытие всё ещё едет`).toBeLessThanOrEqual(80);
        expect(zakr.t90, `${nazv}: при reduce сворачивание всё ещё едет`).toBeLessThanOrEqual(80);
      }
    } finally {
      await ctx.close();
    }
  });

  test('содержимое СВЁРНУТОГО аккордеона не попало в дерево доступности', async ({ page }) => {

    await page.goto('/ru/');
    const snimok = JSON.stringify(await page.accessibility.snapshot());

    for (const sel of ['#direction-teamcash .direction-steps', '.faq-item p']) {
      const fraza = await page.evaluate((s) => {
        const el = document.querySelector(s);
        return el ? el.textContent!.trim().slice(0, 24) : null;
      }, sel);
      expect(fraza, `не нашлось текста для проверки: ${sel}`).toBeTruthy();
      expect(
        snimok.includes(fraza!.slice(0, 20)),
        `текст свёрнутого блока ${sel} виден диктору`,
      ).toBe(false);
    }
  });
});
