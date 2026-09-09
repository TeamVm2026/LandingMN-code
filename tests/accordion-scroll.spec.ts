import { test, expect, type Page } from '@playwright/test';
import { PAGE_ROUTES } from '../src/i18n/routes';
import { MOBILE_VIEWPORT } from '../playwright.config';

const PROGRAMS = ['affiliate', 'bank', 'teamcash'] as const;
const cardSel = (p: string) => `#direction-${p}`;

async function podvesti(page: Page, sel: string): Promise<void> {
  await page.locator(sel).scrollIntoViewIfNeeded();
  await page.evaluate((s) => {
    const r = document.querySelector(s)!.getBoundingClientRect();
    scrollBy(0, r.top - 40);
  }, sel);
  await page.waitForTimeout(300);
}

async function raskryt(page: Page, sel: string): Promise<void> {
  const open = await page.evaluate((s) => (document.querySelector(s) as HTMLDetailsElement).open, sel);
  if (!open) {
    await page.evaluate((s) => document.querySelector(s)!.querySelector('summary')!.click(), sel);
    await page.waitForTimeout(600);
  }
}

async function zakryt(page: Page, sel: string): Promise<{
  doY: number; posleY: number; doVerh: number; posleVerh: number; okno: number;
}> {
  const doo = await page.evaluate((s) => {
    const sum = document.querySelector(s)!.querySelector('summary')!;
    return { y: Math.round(scrollY), verh: Math.round(sum.getBoundingClientRect().top) };
  }, sel);
  await page.evaluate((s) => document.querySelector(s)!.querySelector('summary')!.click(), sel);
  await page.waitForTimeout(1200);
  const posle = await page.evaluate((s) => {
    const sum = document.querySelector(s)!.querySelector('summary')!;
    return { y: Math.round(scrollY), verh: Math.round(sum.getBoundingClientRect().top), okno: innerHeight };
  }, sel);
  return { doY: doo.y, posleY: posle.y, doVerh: doo.verh, posleVerh: posle.verh, okno: posle.okno };
}

test.describe('Экран подводится к карточке при закрытии (удобство 2)', () => {
  test.use({ ...MOBILE_VIEWPORT ? { viewport: MOBILE_VIEWPORT } : {}, hasTouch: true });

  test('заголовок ушёл выше экрана — экран подводится к нему', async ({ page }) => {
    await page.goto(PAGE_ROUTES.home.en);
    let proverено = 0;
    for (const program of PROGRAMS) {
      const sel = cardSel(program);
      await podvesti(page, sel);
      await raskryt(page, sel);

      await page.evaluate((s) => {
        const r = document.querySelector(s)!.getBoundingClientRect();
        scrollBy(0, r.bottom - innerHeight + 40);
      }, sel);
      await page.waitForTimeout(500);
      const r = await zakryt(page, sel);
      if (r.doVerh >= 0) continue;
      proverено++;
      expect(
        r.posleVerh,
        `${program}: после закрытия заголовок остался выше экрана (${r.posleVerh})`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        r.posleVerh,
        `${program}: после закрытия заголовок ушёл за нижнюю кромку (${r.posleVerh})`,
      ).toBeLessThan(r.okno);
      await page.waitForTimeout(500);
    }
    expect(proverено, 'ни один случай «заголовок выше экрана» не воспроизвёлся').toBeGreaterThan(0);
  });

  test('заголовок виден — прокрутки НОЛЬ пикселей', async ({ page }) => {

    await page.goto(PAGE_ROUTES.home.en);
    for (const program of PROGRAMS) {
      const sel = cardSel(program);
      await podvesti(page, sel);
      await raskryt(page, sel);
      await page.evaluate((s) => {
        const r = document.querySelector(s)!.querySelector('summary')!.getBoundingClientRect();
        scrollBy(0, r.top - 120);
      }, sel);
      await page.waitForTimeout(500);
      const r = await zakryt(page, sel);
      expect(r.doVerh, `${program}: подготовка не удалась, заголовок не виден`).toBeGreaterThanOrEqual(0);
      expect(r.posleY, `${program}: экран дёрнулся при видимом заголовке`).toBe(r.doY);
      await page.waitForTimeout(400);
    }
  });

  test('тот же закон на втором аккордеоне — вопрос FAQ', async ({ page }) => {

    await page.goto(PAGE_ROUTES.home.en);
    const sel = '.faq-item:nth-of-type(1)';
    await podvesti(page, sel);
    await raskryt(page, sel);
    await page.evaluate((s) => {
      const r = document.querySelector(s)!.querySelector('summary')!.getBoundingClientRect();
      scrollBy(0, r.top - 120);
    }, sel);
    await page.waitForTimeout(400);
    const r = await zakryt(page, sel);
    expect(r.posleY, 'FAQ: экран дёрнулся при видимом заголовке').toBe(r.doY);
  });
});

test.describe('Подведение при prefers-reduced-motion — мгновенное', () => {

  test('экран встаёт на место одним кадром, а не едет', async ({ browser, baseURL }) => {
    const ctx = await browser.newContext({
      viewport: MOBILE_VIEWPORT,
      hasTouch: true,
      reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    try {
      await page.goto(new URL(PAGE_ROUTES.home.en, baseURL).toString());
      expect(
        await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
        'настройка reduce до страницы не доехала — тест мерил бы не то',
      ).toBe(true);

      const sel = cardSel('bank');
      await podvesti(page, sel);
      await raskryt(page, sel);
      await page.evaluate((s) => {
        const r = document.querySelector(s)!.getBoundingClientRect();
        scrollBy(0, r.bottom - innerHeight + 40);
      }, sel);
      await page.waitForTimeout(500);

      const doVerh = await page.evaluate(
        (s) => Math.round(document.querySelector(s)!.querySelector('summary')!.getBoundingClientRect().top),
        sel,
      );
      expect(doVerh, 'подготовка не удалась: заголовок не ушёл выше экрана').toBeLessThan(0);

      await page.evaluate((s) => document.querySelector(s)!.querySelector('summary')!.click(), sel);

      await page.waitForTimeout(80);
      const rano = await page.evaluate(
        (s) => Math.round(document.querySelector(s)!.querySelector('summary')!.getBoundingClientRect().top),
        sel,
      );
      expect(rano, 'при reduce подведение всё ещё едет, а обязано быть ступенью').toBeGreaterThanOrEqual(0);
    } finally {
      await ctx.close();
    }
  });
});
