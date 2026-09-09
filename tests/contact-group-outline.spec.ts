
import { test, expect } from '@playwright/test';
import { DESKTOP_VIEWPORT } from '../playwright.config';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';

const LOCALES: Locale[] = ['mn', 'ru', 'en'];

test.describe('Единое кольцо составного поля «контакт» (покой/фокус/ошибка)', () => {
  for (const locale of LOCALES) {
    test(`покой: только группа несёт кольцо, у инпута и префикса своего нет (${locale})`, async ({
      page,
    }) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await page.goto(PAGE_ROUTES.home[locale]);

      const group = page.locator('.field__contact-group');
      const prefix = page.locator('.field__phone-prefix');
      const input = page.locator('.field__input--contact');

      await expect(prefix).toBeVisible();

      const [groupShadow, prefixShadow, inputShadow] = await Promise.all([
        group.evaluate((el) => getComputedStyle(el).boxShadow),
        prefix.evaluate((el) => getComputedStyle(el).boxShadow),
        input.evaluate((el) => getComputedStyle(el).boxShadow),
      ]);

      expect(inputShadow, 'у .field__input--contact в покое не должно остаться собственного кольца').toBe(
        'none',
      );
      expect(groupShadow, 'кольцо группы .field__contact-group обязано остаться').not.toBe('none');
      expect(prefixShadow, 'у .field__phone-prefix не должно появиться нового кольца (не регресс)').toBe(
        'none',
      );

      const [groupBox, prefixBox] = await Promise.all([group.boundingBox(), prefix.boundingBox()]);
      if (!groupBox || !prefixBox) {
        throw new Error('геометрия группы/префикса недоступна');
      }
      expect(
        Math.abs(prefixBox.x - groupBox.x),
        `граница группы (x=${groupBox.x.toFixed(2)}) обязана совпадать с началом «+976» (x=${prefixBox.x.toFixed(2)})`,
      ).toBeLessThanOrEqual(1);
    });

    test(`фокус (регрессия): кольцо по-прежнему на группе, не на инпуте (${locale})`, async ({ page }) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await page.goto(PAGE_ROUTES.home[locale]);

      const group = page.locator('.field__contact-group');
      const input = page.locator('#lead-contact');

      await input.evaluate((el: HTMLElement) => el.focus({ focusVisible: true } as FocusOptions));

      const [groupOutlineStyleKbd, groupOutlineWidthKbd, inputOutlineStyleKbd] = await Promise.all([
        group.evaluate((el) => getComputedStyle(el).outlineStyle),
        group.evaluate((el) => parseFloat(getComputedStyle(el).outlineWidth)),
        input.evaluate((el) => getComputedStyle(el).outlineStyle),
      ]);

      expect(groupOutlineStyleKbd, 'кольцо фокуса группы (клавиатура) пропало').not.toBe('none');
      expect(groupOutlineWidthKbd, 'кольцо фокуса группы уже 2px').toBeGreaterThanOrEqual(2);
      expect(inputOutlineStyleKbd, 'у инпута не должно быть собственного outline').toBe('none');

      await input.click();
      const [groupOutlineStyleClick, inputOutlineStyleClick] = await Promise.all([
        group.evaluate((el) => getComputedStyle(el).outlineStyle),
        input.evaluate((el) => getComputedStyle(el).outlineStyle),
      ]);
      expect(groupOutlineStyleClick, 'кольцо фокуса группы (клик) пропало').not.toBe('none');
      expect(inputOutlineStyleClick, 'у инпута не должно быть собственного outline при клике').toBe('none');

    });

    test(`ошибка: кольцо группы отличимо от покоя (${locale})`, async ({ page }) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await page.goto(PAGE_ROUTES.home[locale]);

      const group = page.locator('.field__contact-group');
      const restShadow = await group.evaluate((el) => getComputedStyle(el).boxShadow);

      await page.evaluate(() => {
        document.querySelector('.field--contact')?.classList.add('has-error');
      });

      const errorShadow = await group.evaluate((el) => getComputedStyle(el).boxShadow);

      expect(errorShadow, 'состояние ошибки обязано визуально отличаться от покоя').not.toBe(restShadow);
      expect(errorShadow, 'кольцо ошибки не должно исчезнуть').not.toBe('none');
    });
  }
});
