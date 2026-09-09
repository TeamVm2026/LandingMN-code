
import { test, expect } from '@playwright/test';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';

const LOCALES: Locale[] = ['mn', 'ru', 'en'];

test.describe('Форма заявки — отправка не теряет данные и не светит их', () => {
  test('форма объявляет POST и не может утечь персональные данные в адрес', async ({ page }) => {
    await page.goto(PAGE_ROUTES.home.mn);
    const form = page.locator('form[data-lead-form]');
    await expect(form).toHaveCount(1);

    await expect(form).toHaveAttribute('method', /post/i);
    await expect(form).toHaveAttribute('action', /\/api\/lead/);
  });

  test('выбор канала связи работает: префикс без JS, подсказка и клавиатура со скриптом', async ({
    page,
  }) => {
    await page.goto(PAGE_ROUTES.home.mn);

    const contact = page.locator('#lead-contact');
    const prefix = page.locator('.field__phone-prefix');
    const phone = page.locator('input[name="contact_channel"][value="phone"]');
    const telegram = page.locator('input[name="contact_channel"][value="telegram"]');
    const messenger = page.locator('input[name="contact_channel"][value="messenger"]');

    await expect(page.locator('input[name="contact_channel"]')).toHaveCount(3);
    await expect(phone).toBeChecked();

    await expect(prefix).toBeVisible();
    await telegram.check();
    await expect(prefix).toBeHidden();
    await messenger.check();
    await expect(prefix).toBeHidden();
    await phone.check();
    await expect(prefix).toBeVisible();

    await expect(contact).toHaveJSProperty('inputMode', 'tel');
    const phoneHint = await contact.getAttribute('placeholder');

    await telegram.check();
    await expect(contact).toHaveJSProperty('inputMode', 'text');
    const tgHint = await contact.getAttribute('placeholder');
    expect(tgHint).not.toBe(phoneHint);
    expect(tgHint).toContain('@');

    await messenger.check();
    const fbHint = await contact.getAttribute('placeholder');
    expect(fbHint).not.toBe(tgHint);

    await phone.check();
    await contact.fill('99112233');
    await telegram.check();
    await expect(contact).toHaveValue('99112233');
  });

  test('заполненная форма не перезагружает страницу и говорит, что произошло', async ({ page }) => {
    await page.goto(PAGE_ROUTES.home.mn);

    await page.fill('#lead-name', 'Бат');
    await page.fill('#lead-contact', '99112233');

    await page.locator('input[name="contact_channel"][value="phone"]').check();
    await page.locator('input[name="direction"]').first().check();
    await page.locator('#lead-consent').check();

    const urlBefore = page.url();
    await page.locator('.lead-form__submit').click();
    await page.waitForTimeout(400);

    expect(page.url()).toBe(urlBefore);
    expect(page.url()).not.toContain('name=');
    expect(page.url()).not.toContain('contact=');

    await expect(page.locator('#lead-name')).toHaveValue('Бат');

    const notice = page.locator('[data-lead-status] .lead-form__notice');
    await expect(notice).toBeVisible();
    await expect(notice.locator('a')).toHaveAttribute('href', /t\.me\//);
  });
});

test.describe('Паритет локалей — три маршрута обязаны быть одной страницей', () => {
  for (const locale of LOCALES) {
    test(`структура совпадает с эталоном (${locale})`, async ({ page }) => {
      await page.goto(PAGE_ROUTES.home[locale]);

      await expect(page.locator('h1')).toHaveCount(1);

      await expect(page.locator('#faq-title')).toHaveCount(1);
      const labelled = page.locator('section[aria-labelledby="faq-title"]');
      await expect(labelled).toHaveCount(1);

      await expect(page.locator('#lead-form-title')).toHaveCount(1);

      await expect(page.locator('.final-cta')).toHaveCount(0);
      await expect(page.locator('.final-cta__title')).toHaveCount(0);

      await expect(page.locator('#partners-title')).toHaveCount(1);

      const anchors = await page.locator('a[href^="#"]').evaluateAll((els) =>
        [...new Set(els.map((e) => (e as HTMLAnchorElement).getAttribute('href')!))]
      );
      expect(anchors.length).toBeGreaterThan(0);
      for (const href of anchors) {
        await expect(page.locator(href), `якорь ${href} ведёт в никуда`).toHaveCount(1);
      }
    });
  }

  test('число секций и заголовков одинаково во всех трёх локалях', async ({ page }) => {
    const shapes: Record<string, string> = {};
    for (const locale of LOCALES) {
      await page.goto(PAGE_ROUTES.home[locale]);
      shapes[locale] = JSON.stringify({
        sections: await page.locator('section').count(),
        h1: await page.locator('h1').count(),
        h2: await page.locator('h2').count(),
        h3: await page.locator('h3').count(),
        dialogs: await page.locator('dialog').count(),
      });
    }
    expect(shapes.ru, 'ru разошлась с mn').toBe(shapes.mn);
    expect(shapes.en, 'en разошлась с mn').toBe(shapes.mn);
  });
});

test.describe('Страница 404 — рабочая, а не сырая', () => {
  test('есть h1, действие оформлено главной кнопкой, переключатель языка ведёт на главную', async ({ page }) => {
    await page.goto('/404.html');

    await expect(page.locator('h1')).toHaveCount(1);

    const cta = page.locator('.notfound-cta');
    await expect(cta).toBeVisible();

    const bg = await cta.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg, 'у действия 404 нет золотой заливки').toBe('rgb(241, 198, 50)');

    const langHrefs = await page
      .locator('a.lang-item')
      .evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).getAttribute('href')!));
    expect(langHrefs.length).toBeGreaterThan(0);
    for (const href of langHrefs) {
      expect(href, `переключатель языка на 404 ведёт на ${href}`).not.toContain('privacy');
    }
  });
});

test.describe('Д-21: выход на главную у тупиковых страниц, три локали', () => {
  for (const locale of LOCALES) {
    test(`/404 (${locale}): ссылка ведёт на главную СВОЕЙ локали`, async ({ page }) => {
      await page.goto(PAGE_ROUTES.notFound[locale]);

      const cta = page.locator('.notfound-cta');
      await expect(cta).toHaveCount(1);
      await expect(cta).toBeVisible();

      expect(await cta.getAttribute('href')).toBe(PAGE_ROUTES.home[locale]);

      const bg = await cta.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg, 'у действия 404 нет золотой заливки').toBe('rgb(241, 198, 50)');
    });
  }

  const DEAD_ENDS: { name: string; url: (l: Locale) => string }[] = [
    { name: '/privacy/', url: (l) => PAGE_ROUTES.privacy[l] },
    { name: '/404', url: (l) => PAGE_ROUTES.notFound[l] },
    { name: '/thanks/', url: (l) => PAGE_ROUTES.thanks[l] },
  ];

  for (const locale of LOCALES) {
    for (const { name, url } of DEAD_ENDS) {
      test(`${name} (${locale}): логотип шапки ведёт на главную своей локали`, async ({ page }) => {
        await page.goto(url(locale));

        const brand = page.locator('.site-header a.brand');
        await expect(brand).toHaveCount(1);
        await expect(brand).toBeVisible();
        expect(await brand.getAttribute('href')).toBe(PAGE_ROUTES.home[locale]);

        const position = await page
          .locator('.site-header')
          .evaluate((el) => getComputedStyle(el).position);
        expect(position, 'шапка перестала быть липкой — логотип виден только вверху').toBe(
          'sticky',
        );
      });
    }
  }
});

test.describe('Форма по макету: вид изменён, доступность и цель нажатия целы', () => {
  for (const locale of LOCALES) {
    test(`${locale}: у обеих групп выбора остались имена, а у поля имени — подпись`, async ({
      page,
    }) => {
      await page.goto(PAGE_ROUTES.home[locale]);

      for (const cls of ['field--direction', 'field--contact']) {
        const legend = page.locator(`.${cls} legend`);
        await expect(legend, `у .${cls} исчезла подпись группы`).toHaveCount(1);
        const text = (await legend.textContent())?.trim() ?? '';
        expect(text.length, `подпись группы .${cls} пуста`).toBeGreaterThan(0);

        const box = await legend.boundingBox();
        expect(box!.width, `подпись группы .${cls} снова видна`).toBeLessThan(3);
      }

      const pole = await page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>('#lead-name')!;
        const label = document.querySelector<HTMLLabelElement>('label[for="lead-name"]');
        return {
          estLabel: !!label,
          tekstLabel: label?.textContent?.trim() ?? '',
          vidimLabel: label ? label.getBoundingClientRect().width > 3 : true,
          placeholder: input.placeholder,
          autocomplete: input.autocomplete,
        };
      });
      expect(pole.estLabel, 'подпись поля имени удалена из разметки, а не скрыта').toBe(true);
      expect(pole.vidimLabel, 'подпись поля имени снова видна').toBe(false);

      expect(pole.placeholder).toBe(pole.tekstLabel);
      expect(pole.placeholder.length).toBeGreaterThan(0);
      expect(pole.autocomplete, 'автозаполнение имени потеряно').toBe('name');
    });

    test(`${locale}: плашка ниже 44px, но цель нажатия — 44px, и подпись в одну строку`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 360, height: 844 });
      await page.goto(PAGE_ROUTES.home[locale]);

      const chips = await page.evaluate(() =>
        [...document.querySelectorAll('.chip-radio')].map((el) => {
          const plate = el.getBoundingClientRect();
          const input = el.querySelector('input')!.getBoundingClientRect();
          const span = el.querySelector('.chip-radio__text')!.getBoundingClientRect();
          return {
            text: el.textContent!.trim(),
            plateH: plate.height,
            tapH: input.height,
            tapW: input.width,
            textH: span.height,
            textW: span.width,
            zapas: plate.width - span.width,
          };
        }),
      );
      expect(chips.length).toBe(6);
      for (const c of chips) {

        expect(c.plateH, `плашка «${c.text}» снова высокая — макет требует ~26`).toBeLessThanOrEqual(
          30,
        );

        expect(c.tapH, `цель нажатия «${c.text}» ниже 44px`).toBeGreaterThanOrEqual(44);
        expect(c.tapW, `цель нажатия «${c.text}» уже 44px`).toBeGreaterThanOrEqual(44);

        expect(c.textH, `подпись «${c.text}» переносится на две строки`).toBeLessThan(20);

        expect(c.zapas, `подписи «${c.text}» не хватает места в плашке`).toBeGreaterThan(2);
      }
    });

    test(`${locale}: цели нажатия внутри формы нигде не накладываются`, async ({ page }) => {

      await page.setViewportSize({ width: 360, height: 844 });
      await page.goto(PAGE_ROUTES.home[locale]);

      const peresecheniya = await page.evaluate(() => {
        const form = document.querySelector('.lead-form__form')!;
        const boxes = [...form.querySelectorAll('input:not([type=hidden]), button, a')]
          .map((el) => {
            const r = el.getBoundingClientRect();
            const node = el as HTMLInputElement;
            return {
              id: node.id || `${node.name}=${node.value}` || el.tagName,
              x: r.x,
              y: r.y,
              w: r.width,
              h: r.height,
            };
          })
          .filter((o) => o.w > 0.5 && o.h > 0.5);
        const out: string[] = [];
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i]!;
            const b = boxes[j]!;
            const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            if (ox > 0.5 && oy > 0.5) out.push(`${a.id} × ${b.id}`);
          }
        }
        return out;
      });
      expect(peresecheniya, 'цели нажатия перекрывают друг друга').toEqual([]);
    });
  }
});
