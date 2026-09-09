import { expect, test } from '@playwright/test';
import { MOBILE_VIEWPORT, DESKTOP_VIEWPORT } from '../playwright.config.ts';

function splitShadows(value: string): string[] {
  return value.split(/,(?![^()]*\))/).map((part) => part.trim()).filter(Boolean);
}

type Recipe = {
  shadows: string[];
  isolation: string;
  beforeOpacity: string;
  beforeShadow: string;
};

async function recipe(page: import('@playwright/test').Page, selector: string): Promise<Recipe> {
  const raw = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const self = getComputedStyle(el);
    const before = getComputedStyle(el, '::before');
    return {
      shadow: self.boxShadow,
      isolation: self.isolation,
      beforeOpacity: before.opacity,
      beforeShadow: before.boxShadow,
    };
  }, selector);
  expect(raw, `элемент ${selector} не найден на странице`).not.toBeNull();
  return {
    shadows: splitShadows(raw!.shadow),
    isolation: raw!.isolation,
    beforeOpacity: raw!.beforeOpacity,
    beforeShadow: raw!.beforeShadow,
  };
}

test.describe('Один рецепт стекла: карточка направления, вопросы, форма заявки', () => {
  test('десктоп 1440: пара верхней грани, полная сила блика и контекст наложения совпадают', async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/ru/');

    const reference = await recipe(page, '#how-to-start .contact-btn--telegram');
    expect(reference.shadows, 'у эталона ровно две тени — пара грани').toHaveLength(2);

    const card = await recipe(page, '#direction-bank');
    const faqItem = await recipe(page, '.faq-item');
    const form = await recipe(page, '.lead-form__form');

    for (const [name, surface] of [
      ['.direction-card', card],
      ['.faq-item', faqItem],
      ['.lead-form__form', form],
    ] as const) {
      expect(
        surface.shadows.slice(0, 2),
        `${name}: верхняя грань обязана стоять на САМОЙ поверхности и первой в списке теней, значениями эталона`,
      ).toEqual(reference.shadows);

      expect(
        surface.isolation,
        `${name}: контекст наложения обязан быть заведён явно (isolation: isolate)`,
      ).toBe('isolate');

      expect(
        surface.beforeOpacity,
        `${name}: слой толщины (::before) обязан идти в полную силу — приглушения нет ни у кого`,
      ).toBe('1');

      expect(
        surface.beforeShadow,
        `${name}: у слоя толщины своей тени быть не должно — грань ровно одна`,
      ).toBe('none');
    }
  });

  test('мобайл 390: тот же рецепт у карточки, панели вопросов и панели заявки', async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto('/ru/');

    const reference = await recipe(page, '#how-to-start .contact-btn--telegram');
    const card = await recipe(page, '#direction-bank');

    const faqPanel = await recipe(page, '.faq-accordion');
    const form = await recipe(page, '.lead-form__form');

    for (const [name, surface] of [
      ['.direction-card', card],
      ['.faq-accordion', faqPanel],
      ['.lead-form__form', form],
    ] as const) {
      expect(surface.shadows.slice(0, 2), `${name}: пара верхней грани (390)`).toEqual(reference.shadows);
      expect(surface.isolation, `${name}: isolation (390)`).toBe('isolate');
      expect(surface.beforeOpacity, `${name}: полная сила блика (390)`).toBe('1');
    }
  });

  test('карточка: список теней одной длины в покое, под курсором и под пальцем', async ({ page }) => {

    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/ru/');

    const card = page.locator('#direction-bank');
    await card.scrollIntoViewIfNeeded();
    await page.mouse.move(4, 4);
    await page.waitForTimeout(200);

    const read = async () => splitShadows(
      await page.evaluate(() => getComputedStyle(document.querySelector('#direction-bank')!).boxShadow),
    );

    const rest = await read();

    const summary = page.locator('#direction-bank > summary');
    const box = await summary.boundingBox();
    expect(box, 'summary карточки обязан иметь геометрию').not.toBeNull();
    const cx = Math.round(box!.x + box!.width / 2);
    const cy = Math.round(box!.y + box!.height / 2);

    await page.mouse.move(cx, cy);
    await page.waitForTimeout(250);
    const hover = await read();

    await page.mouse.down();
    await page.waitForTimeout(250);
    const active = await read();
    await page.mouse.up();

    expect(rest, 'в покое: пара грани + заливка').toHaveLength(3);
    expect(hover, 'под курсором список той же длины').toHaveLength(rest.length);
    expect(active, 'под пальцем список той же длины').toHaveLength(rest.length);

    expect(hover.slice(0, 2), 'грань под курсором не меняется').toEqual(rest.slice(0, 2));
    expect(active.slice(0, 2), 'грань под пальцем не меняется').toEqual(rest.slice(0, 2));

    for (const [name, list] of [['покой', rest], ['наведение', hover], ['нажатие', active]] as const) {
      expect(list.at(-1), `${name}: заливка обязана оставаться 200px`).toContain('200px');
    }

    const alpha = (shadow: string) => {
      const m = shadow.match(/rgba?\(\s*255,\s*255,\s*255,\s*([\d.]+)\s*\)/);
      return m ? Number(m[1]) : 0;
    };
    expect(alpha(rest.at(-1)!), 'в покое заливка прозрачна').toBe(0);
    expect(alpha(hover.at(-1)!), 'наведение светлит поверхность').toBeGreaterThan(alpha(rest.at(-1)!));
    expect(alpha(active.at(-1)!), 'нажатие светлит сильнее наведения').toBeGreaterThan(alpha(hover.at(-1)!));
  });
});
