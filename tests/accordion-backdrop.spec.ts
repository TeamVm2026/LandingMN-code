import { test, expect, type Page } from '@playwright/test';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';
import { MOBILE_VIEWPORT, DESKTOP_VIEWPORT } from '../playwright.config';

const PROGRAMS = ['affiliate', 'bank', 'teamcash'] as const;
const cardSel = (p: string) => `#direction-${p}`;

async function tochkaFona(page: Page, sel: string): Promise<[number, number] | null> {
  return page.evaluate((s) => {
    const card = document.querySelector(s)!;
    const r = card.getBoundingClientRect();
    const sum = card.querySelector('summary')!;
    const sr = sum.getBoundingClientRect();
    const c = card.querySelector('.direction-caret')!.getBoundingClientRect();
    for (let y = Math.min(r.bottom - 6, innerHeight - 6); y > sr.bottom + 6; y -= 4) {
      for (const x of [r.left + 6, r.left + r.width / 2, r.right - 6]) {
        if (x < 2 || x > innerWidth - 2 || y < 2) continue;

        if (Math.abs(x - (c.left + c.width / 2)) < 26 && Math.abs(y - (c.top + c.height / 2)) < 26) continue;
        const el = document.elementFromPoint(x, y);
        if (el && el.tagName === 'SUMMARY' && card.contains(el)) return [x, y] as [number, number];
      }
    }
    return null;
  }, sel);
}

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

const otkryta = (page: Page, sel: string): Promise<boolean> =>
  page.evaluate((s) => (document.querySelector(s) as HTMLDetailsElement).open, sel);

test.describe('Фон раскрытой карточки закрывает её (удобство 1, ноль JS)', () => {
  test.use({ ...MOBILE_VIEWPORT ? { viewport: MOBILE_VIEWPORT } : {}, hasTouch: true });

  for (const locale of ['mn', 'ru', 'en'] as Locale[]) {
    test(`[${locale}] тап по пустому фону сворачивает все три карточки`, async ({ page }) => {
      await page.goto(PAGE_ROUTES.home[locale]);
      for (const program of PROGRAMS) {
        const sel = cardSel(program);
        await podvesti(page, sel);
        await raskryt(page, sel);
        const t = await tochkaFona(page, sel);
        expect(t, `${program}: у раскрытой карточки не нашлось ни одной точки фона`).not.toBeNull();
        await page.touchscreen.tap(t![0], t![1]);
        await page.waitForTimeout(600);
        expect(await otkryta(page, sel), `${program}: тап по фону не закрыл карточку`).toBe(false);
      }
    });

    test(`[${locale}] тап по тексту и по стеклянной панели НЕ закрывает`, async ({ page }) => {
      await page.goto(PAGE_ROUTES.home[locale]);

      const celi = [
        ['.direction-section-title', 'levo'],
        ['.direction-gains', 'centr'],
        ['.direction-steps', 'centr'],
      ] as const;
      for (const program of PROGRAMS) {
        const sel = cardSel(program);
        for (const [vnutri, gde] of celi) {
          await podvesti(page, sel);
          await raskryt(page, sel);
          const t = await page.evaluate(([s, v, g]) => {
            const el = document.querySelector(`${s} ${v}`);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            if (r.height < 10 || r.width < 10 || r.top < 4 || r.bottom > innerHeight - 4) return null;
            return g === 'centr'
              ? [r.left + r.width / 2, r.top + r.height / 2]
              : [r.left + Math.min(24, r.width / 3), r.top + r.height / 2];
          }, [sel, vnutri, gde] as const);
          if (!t) continue;
          await page.touchscreen.tap(t[0]!, t[1]!);
          await page.waitForTimeout(400);
          expect(
            await otkryta(page, sel),
            `${program}: тап по ${vnutri} закрыл карточку — фон перехватил нарисованное`,
          ).toBe(true);
        }
      }
    });
  }

  test('прежние способы закрытия целы: заголовок, каретка, клавиатура', async ({ page }) => {
    await page.goto(PAGE_ROUTES.home.mn);
    for (const program of PROGRAMS) {
      const sel = cardSel(program);
      const d = page.locator(sel);

      await podvesti(page, sel);
      await raskryt(page, sel);
      await page.locator(`${sel} .direction-summary-copy`).click();
      await expect(d, `${program}: заголовок перестал закрывать`).toHaveJSProperty('open', false);

      await raskryt(page, sel);
      await page.waitForTimeout(600);
      await page.locator(`${sel} .direction-caret`).scrollIntoViewIfNeeded();
      const box = (await page.locator(`${sel} .direction-caret`).boundingBox())!;
      await page.mouse.click(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
      await expect(d, `${program}: каретка перестала закрывать`).toHaveJSProperty('open', false);

      await raskryt(page, sel);
      await page.waitForTimeout(600);
      await page.locator(`${sel} > summary`).focus();
      await page.keyboard.press('Enter');
      await expect(d, `${program}: клавиатура перестала закрывать`).toHaveJSProperty('open', false);
      await page.waitForTimeout(600);
    }
  });
});

test.describe('Фон закрывает и при полностью выключенном JavaScript', () => {
  test.use({ javaScriptEnabled: false, ...MOBILE_VIEWPORT ? { viewport: MOBILE_VIEWPORT } : {} });

  for (const locale of ['mn', 'ru', 'en'] as Locale[]) {
    test(`[${locale}] без JS фон сворачивает все три карточки`, async ({ page }) => {
      await page.goto(PAGE_ROUTES.home[locale]);
      for (const program of PROGRAMS) {
        const sel = cardSel(program);
        const d = page.locator(sel);
        await d.scrollIntoViewIfNeeded();
        await page.locator(`${sel} .direction-summary-copy`).click();
        await expect(d).toHaveJSProperty('open', true);
        await page.waitForTimeout(700);

        await page.locator(`${sel} .direction-steps`).scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        const card = (await d.boundingBox())!;
        const fact = (await page.locator(`${sel} .direction-steps`).boundingBox())!;
        const y = Math.round((fact.y + fact.height + Math.min(card.y + card.height, 840)) / 2);
        const x = Math.round(card.x + 24);
        await page.mouse.click(x, y);
        await expect(d, `${program}: без JS фон не закрыл карточку`).toHaveJSProperty('open', false);
        await page.waitForTimeout(700);
      }
    });
  }
});

test.describe('Фон не притворяется кнопкой на десктопе', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('курсор над фоном — не рука', async ({ page }) => {

    await page.goto(PAGE_ROUTES.home.mn);
    for (const program of PROGRAMS) {
      const sel = cardSel(program);
      await podvesti(page, sel);
      await raskryt(page, sel);
      const kursor = await page.evaluate(
        (s) => getComputedStyle(document.querySelector(s)!.querySelector('summary')!, '::after').cursor,
        sel,
      );
      expect(kursor, `${program}: фон показывает руку и врёт про интерактивность`).not.toBe('pointer');
    }
  });

  test('выделение текста внутри раскрытой карточки работает', async ({ page }) => {
    await page.goto(PAGE_ROUTES.home.en);
    let vydeleno = 0;
    for (const program of PROGRAMS) {
      const sel = cardSel(program);
      await podvesti(page, sel);
      await raskryt(page, sel);

      await page.locator(`${sel} .direction-steps`).scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);

      const t = await page.evaluate((s) => {
        const leads = document.querySelectorAll(`${s} .direction-step-lead`);
        const tails = document.querySelectorAll(`${s} .direction-step-tail`);
        if (!leads.length || !tails.length) return null;
        const first = leads[0]!.getBoundingClientRect();
        const last = tails[tails.length - 1]!.getBoundingClientRect();
        if (first.top < 4 || last.bottom > innerHeight - 4) return null;
        return [first.left + 4, first.top + first.height / 2, last.right - 4, last.top + last.height / 2];
      }, sel);
      if (!t) continue;
      await page.mouse.move(t[0]!, t[1]!);
      await page.mouse.down();
      await page.mouse.move(t[2]!, t[3]!, { steps: 14 });
      await page.mouse.up();
      const dlina = await page.evaluate(() => (getSelection()?.toString() ?? '').trim().length);
      if (dlina > 3) vydeleno++;
      expect(await otkryta(page, sel), `${program}: выделение текста закрыло карточку`).toBe(true);
      await page.evaluate(() => getSelection()?.removeAllRanges());
    }
    expect(vydeleno, 'ни в одной карточке текст не выделился — правка съела выделение').toBeGreaterThan(0);
  });
});
