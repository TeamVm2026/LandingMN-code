
import { test, expect } from '@playwright/test';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';

const LOCALES: Locale[] = ['mn', 'ru', 'en'];

test.describe('Страница политики конфиденциальности', () => {
  for (const locale of LOCALES) {
    test(`читается как документ и не переполняет экран (${locale})`, async ({ page }) => {

      await page.setViewportSize({ width: 360, height: 740 });
      await page.goto(PAGE_ROUTES.privacy[locale]);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, 'страница политики вызывает горизонтальную прокрутку').toBeLessThanOrEqual(0);

      await expect(page.locator('h1')).toHaveCount(1);
      const h1Size = await page
        .locator('h1')
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(h1Size).toBeLessThanOrEqual(34);

      await expect(page.locator('.privacy-updated')).toHaveCount(1);

      const contact = page.locator('.privacy-contact');
      await expect(contact).toHaveCount(1);
      expect(await contact.getAttribute('href')).toMatch(/^https?:\/\//);

      const back = page.locator('.privacy-back');
      await expect(back).toHaveCount(1);
      expect(await back.getAttribute('href')).toBe(PAGE_ROUTES.home[locale]);
    });
  }

  const ANALYTICS_WORDS: Record<Locale, RegExp> = {
    mn: /аналитик/i,
    ru: /аналитик/i,
    en: /analytics/i,
  };

  for (const locale of LOCALES) {
    test(`раздел об аналитике на месте и назван своим словом (${locale})`, async ({ page }) => {
      await page.goto(PAGE_ROUTES.privacy[locale]);

      const sections = page.locator('.privacy-section');
      await expect(sections, 'разделов политики не пять — раздел об аналитике потерян').toHaveCount(5);

      const heading = await sections.nth(3).locator('.privacy-heading').innerText();
      expect(heading, 'четвёртый раздел не про аналитику').toMatch(ANALYTICS_WORDS[locale]);
      expect(heading.toLowerCase(), 'в заголовке нет слова про cookie').toContain('cookie');

      const body = await sections.nth(3).locator('.privacy-body').innerText();
      for (const required of ['Google', 'Clarity', 'Cloudflare', 'BeMob', '90']) {
        expect(body, `в разделе об аналитике не назван «${required}»`).toContain(required);
      }

      const retention = await sections.nth(2).locator('.privacy-body').innerText();
      expect(retention, 'раздел о хранении перестал называть 90 дней').toContain('90');
    });

    test(`ссылка на менеджера осталась в разделе о правах, а не в разделе об аналитике (${locale})`, async ({
      page,
    }) => {

      await page.goto(PAGE_ROUTES.privacy[locale]);

      const sections = page.locator('.privacy-section');
      expect(
        await sections.nth(4).locator('.privacy-contact').count(),
        'в последнем разделе (о правах) нет ссылки на менеджера',
      ).toBe(1);
      expect(
        await sections.nth(3).locator('.privacy-contact').count(),
        'ссылка на менеджера переехала в раздел об аналитике',
      ).toBe(0);
    });
  }

  test('все три локали отдают одну и ту же структуру', async ({ page }) => {

    const shapes: string[] = [];
    for (const locale of LOCALES) {
      await page.goto(PAGE_ROUTES.privacy[locale]);
      shapes.push(
        await page.evaluate(() =>
          [...document.querySelectorAll('main *')]
            .map((el) => el.tagName + '.' + (el.className || ''))
            .join('|'),
        ),
      );
    }
    expect(new Set(shapes).size, 'структура страницы политики разошлась между локалями').toBe(1);
  });
});

test.describe('Согласие ведёт к документу, с которым соглашаешься', () => {
  for (const locale of LOCALES) {
    test(`ссылка на политику внутри согласия (${locale})`, async ({ page }) => {
      await page.goto(PAGE_ROUTES.home[locale]);
      const link = page.locator('.consent-link').first();
      await expect(link, 'в согласии нет ссылки на политику').toHaveCount(1);
      expect(await link.getAttribute('href')).toBe(PAGE_ROUTES.privacy[locale]);

      expect(await link.getAttribute('target')).toBe('_blank');
      expect(await link.getAttribute('rel')).toContain('noopener');

      expect((await link.innerText()).trim().length).toBeGreaterThan(3);
    });
  }
});

test.describe('Сообщения валидации — свои, а не браузерные', () => {
  test('пустая форма показывает сообщения у каждого поля и снимает их при исправлении', async ({
    page,
  }) => {
    await page.goto(PAGE_ROUTES.home.ru);
    await page.locator('form[data-lead-form]').scrollIntoViewIfNeeded();
    await page.locator('.lead-form__submit').click();
    await page.waitForTimeout(300);

    const errors = page.locator('[data-field-error]');
    const count = await errors.count();
    expect(count, 'ни одного собственного сообщения — значит показался нативный пузырь').toBe(4);

    for (let i = 0; i < count; i++) {
      expect(await errors.nth(i).getAttribute('role')).toBe('alert');
      expect((await errors.nth(i).innerText()).trim().length).toBeGreaterThan(3);
    }

    expect(await page.locator('.has-error').count()).toBeGreaterThan(0);

    await page.fill('#lead-name', 'Бат');
    await page.waitForTimeout(200);
    expect(await page.locator('[data-field-error]').count()).toBe(count - 1);
  });

  test('ошибка пустого поля контакта не красит чипы канала', async ({ page }) => {

    await page.goto(PAGE_ROUTES.home.ru);
    await page.locator('.lead-form__submit').click();
    await page.waitForTimeout(300);

    const [channelChip, directionChip] = await page.evaluate(() => {
      const read = (sel: string) => {
        const el = document.querySelector<HTMLElement>(sel);
        if (!el) return null;
        const shadow = getComputedStyle(el).boxShadow;
        const m = shadow.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\/\s*([\d.]+)\)/);
        return { shadow, redChannel: m ? Number(m[1]) : null };
      };
      return [read('.field--contact .chip-radio'), read('.field--direction .chip-radio')];
    });

    expect(
      channelChip?.redChannel,
      `чипы выбора канала помечены цветом ошибки, хотя канал выбран корректно (${channelChip?.shadow})`,
    ).toBeNull();
    expect(directionChip?.redChannel, `у чипа направления нет кромки ошибки (${directionChip?.shadow})`).not.toBeNull();
    expect(directionChip!.redChannel!).toBeGreaterThan(0.9);

    expect(directionChip?.shadow).not.toBe(channelChip?.shadow);
  });

  test('переключение канала не гасит ошибку пустого поля контакта', async ({ page }) => {

    await page.goto(PAGE_ROUTES.home.ru);
    await page.locator('.lead-form__submit').click();
    await page.waitForTimeout(300);

    const contactHasError = () =>
      page.evaluate(() => document.querySelector('.field--contact')?.classList.contains('has-error'));
    expect(await contactHasError()).toBe(true);

    await page.locator('input[name="contact_channel"][value="telegram"]').check();
    await page.waitForTimeout(250);

    expect(
      await contactHasError(),
      'ошибка снялась, хотя поле контакта осталось пустым',
    ).toBe(true);

    await page.fill('#lead-contact', '@batbold');
    await page.waitForTimeout(250);
    expect(await contactHasError()).toBe(false);
  });

  test('заполненная форма не показывает ни одного сообщения', async ({ page }) => {
    await page.goto(PAGE_ROUTES.home.ru);
    await page.fill('#lead-name', 'Бат');
    await page.fill('#lead-contact', '99112233');
    await page.locator('input[name="direction"]').first().check();
    await page.locator('#lead-consent').check();
    await page.locator('.lead-form__submit').click();
    await page.waitForTimeout(300);
    expect(await page.locator('[data-field-error]').count()).toBe(0);
  });
});

test.describe('Прокрутка на тач-устройствах', () => {
  test('scroll-behavior: smooth не применяется на телефоне', async ({ browser }) => {

    const touch = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const touchPage = await touch.newPage();
    await touchPage.goto(PAGE_ROUTES.home.ru);
    const touchBehavior = await touchPage.evaluate(
      () => getComputedStyle(document.documentElement).scrollBehavior,
    );
    expect(touchBehavior, 'на тач-устройстве осталась анимированная прокрутка').toBe('auto');
    await touch.close();

    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const desktopPage = await desktop.newPage();
    await desktopPage.goto(PAGE_ROUTES.home.ru);
    const desktopBehavior = await desktopPage.evaluate(
      () => getComputedStyle(document.documentElement).scrollBehavior,
    );
    expect(desktopBehavior).toBe('smooth');
    await desktop.close();
  });
});
