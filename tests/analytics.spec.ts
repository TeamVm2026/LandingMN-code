
import { test, expect, type Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';
import { createBus } from '../src/scripts/analytics/bus';
import { EVENT_NAMES, PROVIDER_OWNED_EVENTS, type EventName } from '../src/scripts/analytics/events';
import { isOffCloudflareNoise } from './lib/console-noise';

import { withExclusiveBuildLock } from './lib/exclusive-build';
import { decodeStart } from '../src/lib/start-codec';
import { envValue } from '../scripts/lib/env-value';

const TG_BOT_URL = envValue('PUBLIC_TG_BOT_URL');

function recorder(): { calls: [EventName, Record<string, unknown>][]; sink: (n: EventName, p: Record<string, unknown>) => void } {
  const calls: [EventName, Record<string, unknown>][] = [];
  return { calls, sink: (n, p) => calls.push([n, p]) };
}

test.describe('шина событий', () => {
  test('track без приёмников не бросает, а копит событие в очереди', () => {
    const bus = createBus();
    expect(() => bus.track('form_open', { placement: 'hero' })).not.toThrow();

    const a = recorder();
    bus.registerSink(a.sink);
    expect(a.calls).toHaveLength(1);
    expect(a.calls[0][0]).toBe('form_open');
    expect(a.calls[0][1]).toMatchObject({ placement: 'hero' });
  });

  test('приёмник, зарегистрированный после трёх событий, получает все три по порядку', () => {
    const bus = createBus();
    bus.track('form_open', { placement: 'hero' });
    bus.track('direction_select', { direction: 'bank' });
    bus.track('messenger_click', { channel: 'telegram' });

    const a = recorder();
    bus.registerSink(a.sink);

    expect(a.calls.map(([name]) => name)).toEqual([
      'form_open',
      'direction_select',
      'messenger_click',
    ]);
  });

  test('второй приёмник получает ТУ ЖЕ накопленную историю, что и первый', () => {
    const bus = createBus();
    bus.track('form_open', {});
    bus.track('direction_select', {});
    bus.track('messenger_click', {});

    const a = recorder();
    const b = recorder();
    bus.registerSink(a.sink);
    bus.registerSink(b.sink);

    expect(b.calls.map(([name]) => name)).toEqual(a.calls.map(([name]) => name));
    expect(b.calls).toHaveLength(3);
  });

  test('приёмник, бросающий исключение, не мешает остальным и не роняет track', () => {
    const bus = createBus();
    const good = recorder();

    bus.registerSink(() => {
      throw new Error('блокировщик вырезал провайдер');
    });
    bus.registerSink(good.sink);

    expect(() => bus.track('form_error', { error_type: 'validation' })).not.toThrow();
    expect(good.calls).toHaveLength(1);
    expect(good.calls[0][0]).toBe('form_error');
  });

  test('общие параметры добавляются к каждому событию, но параметр события их перекрывает', () => {
    const bus = createBus();
    bus.setCommonParams({ lang: 'mn', ft_source: 'fb' });

    const a = recorder();
    bus.registerSink(a.sink);

    bus.track('form_open', { placement: 'form' });
    bus.track('language_change', { lang: 'ru' });

    expect(a.calls[0][1]).toEqual({ lang: 'mn', ft_source: 'fb', placement: 'form' });

    expect(a.calls[1][1]).toEqual({ lang: 'ru', ft_source: 'fb' });
  });

  test('очередь не растёт бесконечно: 60 событий без приёмников дают 50', () => {
    const bus = createBus();
    for (let i = 0; i < 60; i++) bus.track('form_open', { placement: String(i) });

    const a = recorder();
    bus.registerSink(a.sink);

    expect(a.calls).toHaveLength(50);

    expect(a.calls[0][1].placement).toBe('0');
    expect(a.calls[49][1].placement).toBe('49');
  });

  test('событие при живом приёмнике всё равно достаётся приёмнику, пришедшему позже', () => {
    const bus = createBus();
    const a = recorder();
    bus.registerSink(a.sink);

    bus.track('direction_select', { direction: 'teamcash' });
    expect(a.calls).toHaveLength(1);

    const b = recorder();
    bus.registerSink(b.sink);
    expect(b.calls).toHaveLength(1);
    expect(b.calls[0][0]).toBe('direction_select');

    expect(a.calls).toHaveLength(1);
  });
});

test.describe('словарь событий', () => {

  test('EVENT_NAMES не содержит page_view — его шлёт провайдер', () => {
    expect(EVENT_NAMES).not.toContain('page_view' as EventName);
    expect(PROVIDER_OWNED_EVENTS).toContain('page_view');
  });

  test('через шину проходят ровно шесть событий обещанной воронки', () => {
    expect([...EVENT_NAMES].sort()).toEqual(
      [
        'direction_select',
        'form_error',
        'form_open',
        'form_submit',
        'language_change',
        'messenger_click',
      ].sort(),
    );
  });
});

interface RecordedEvent {
  name: string;
  params: Record<string, string | number | undefined>;
  ts: number;
}

async function events(page: Page): Promise<RecordedEvent[]> {
  return page.evaluate(() => (window as { __lmnEvents?: RecordedEvent[] }).__lmnEvents ?? []);
}

async function waitForEvent(page: Page, name: string): Promise<RecordedEvent> {
  await expect
    .poll(async () => (await events(page)).filter((e) => e.name === name).length, { timeout: 5000 })
    .toBeGreaterThan(0);
  const found = (await events(page)).find((e) => e.name === name);
  return found!;
}

const LOCALES: Locale[] = ['mn', 'ru', 'en'];

test.describe('живая страница: искусственный приёмник', () => {
  test('приёмник включается параметром и события до него доходят', async ({ page }) => {
    await page.goto('/?__sink=1');

    await expect
      .poll(async () => page.evaluate(() => Array.isArray((window as { __lmnEvents?: unknown[] }).__lmnEvents)))
      .toBe(true);
  });

  test('раскрытие карточки направления даёт direction_select с направлением и размещением', async ({ page }) => {
    await page.goto('/?__sink=1');

    await page.locator('details[data-track-direction="bank"] > summary').evaluate((el) => (el as HTMLElement).click());

    const event = await waitForEvent(page, 'direction_select');
    expect(event.params.direction).toBe('bank');
    expect(event.params.placement).toBe('card');

    expect(event.params.lang).toBe('mn');
  });

  test('direction_select уходит РОВНО один раз на раскрытие и не уходит на сворачивание', async ({ page }) => {

    await page.goto('/?__sink=1');
    const summary = page.locator('details[data-track-direction="teamcash"] > summary');
    const count = async () =>
      (await events(page)).filter((e) => e.name === 'direction_select').length;

    const klik = () => summary.evaluate((el) => (el as HTMLElement).click());

    await klik();
    await expect.poll(count, { timeout: 5000 }).toBe(1);

    await klik();
    await page.waitForTimeout(300);
    expect(await count(), 'сворачивание карточки отправило direction_select').toBe(1);

    await klik();
    await expect.poll(count, { timeout: 5000 }).toBe(2);
  });

  test('клик по Telegram даёт messenger_click и НЕ задерживает переход', async ({ page, context }) => {

    await context.route('**/t.me/**', (route) => route.fulfill({ status: 200, body: 'ok' }));

    await page.goto('/?__sink=1');

    await page.evaluate(() => {
      (window as { __lmnPrevented?: boolean }).__lmnPrevented = undefined;
      document.addEventListener(
        'click',
        (e) => {
          (window as { __lmnPrevented?: boolean }).__lmnPrevented = e.defaultPrevented;
        },
        false,
      );
    });

    const telegram = page.locator('.contact-btn--telegram').first();
    const popupPromise = context.waitForEvent('page', { timeout: 10_000 });
    await telegram.click();

    const popup = await popupPromise;
    expect(popup).toBeTruthy();
    expect(await page.evaluate(() => (window as { __lmnPrevented?: boolean }).__lmnPrevented)).toBe(false);

    const event = await waitForEvent(page, 'messenger_click');
    expect(event.params.channel).toBe('telegram');
    expect(event.params.placement).toBe('hero');
    expect(event.params.direction).toBe('none');

    if (TG_BOT_URL === '') {

      expect(event.params.start_payload, 'бота нет, а метка в событии есть').toBeUndefined();
    } else {
      const raw = event.params.start_payload;
      expect(raw, 'бот включён, а метка в событие не попала').toBeTruthy();

      const decoded = decodeStart(String(raw));
      expect(decoded, `метка события «${raw}» не разбирается кодеком`).not.toBeNull();
      expect(decoded!.direction, 'направление метки разошлось с направлением события').toBe('none');
      expect(decoded!.locale).toBe('mn');
    }
  });

  test('первый фокус в поле формы даёт ровно один form_open', async ({ page }) => {
    await page.goto('/?__sink=1');

    await page.locator('#lead-name').focus();
    await waitForEvent(page, 'form_open');

    await page.locator('#lead-contact').focus();
    await page.waitForTimeout(200);

    const opens = (await events(page)).filter((e) => e.name === 'form_open');
    expect(opens).toHaveLength(1);
    expect(opens[0].params.placement).toBe('form');
  });

  test('отправка пустой формы даёт form_error с error_type=validation', async ({ page }) => {
    await page.goto('/?__sink=1');
    await page.locator('.lead-form__submit').click();

    const event = await waitForEvent(page, 'form_error');
    expect(event.params.error_type).toBe('validation');

    expect(event.params.field).toBe('direction');
  });

  test('form_submit существует в коде и вызывается через отладочную обёртку', async ({ page }) => {
    await page.goto('/?__sink=1');
    await expect
      .poll(async () => page.evaluate(() => typeof (window as { __lmnEmit?: { formSubmit?: unknown } }).__lmnEmit?.formSubmit))
      .toBe('function');

    await page.evaluate(() =>
      (window as { __lmnEmit?: { formSubmit: (d: string, c: string) => void } }).__lmnEmit!.formSubmit(
        'bank',
        'telegram',
      ),
    );

    const event = await waitForEvent(page, 'form_submit');
    expect(event.params.direction).toBe('bank');
    expect(event.params.contact_channel).toBe('telegram');
  });

  test('смена языка mn→ru: language_change приходит на СЛЕДУЮЩЕЙ загрузке', async ({ page }) => {
    await page.goto('/?utm_source=fb&utm_campaign=aug&__sink=1');
    await waitForEvent(page, 'form_open').catch(() => undefined);

    await page.locator('a.lang-item[hreflang="ru"]').click();
    await page.waitForURL('**/ru/**');

    const event = await waitForEvent(page, 'language_change');
    expect(event.params.lang_from).toBe('mn');
    expect(event.params.lang_to).toBe('ru');

    expect(event.params.ft_source).toBe('fb');
    expect(event.params.ft_campaign).toBe('aug');
    expect(event.params.lang).toBe('ru');
  });

  test('повторная загрузка того же адреса второго language_change не даёт', async ({ page }) => {
    await page.goto('/?__sink=1');
    await page.locator('a.lang-item[hreflang="ru"]').click();
    await page.waitForURL('**/ru/**');
    await waitForEvent(page, 'language_change');

    await page.reload();
    await page.waitForTimeout(400);
    const again = (await events(page)).filter((e) => e.name === 'language_change');
    expect(again).toHaveLength(0);
  });
});

test.describe('паритет разметки событий по локалям', () => {
  test('на всех трёх локалях одинаковое число [data-track] и один набор размещений', async ({ page }) => {
    const shape: Record<string, { count: number; placements: string[] }> = {};

    for (const locale of LOCALES) {
      await page.goto(PAGE_ROUTES.home[locale]);
      shape[locale] = await page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-track]'));
        return {
          count: nodes.length,
          placements: Array.from(
            new Set(nodes.map((n) => n.dataset.trackPlacement ?? '')),
          ).sort(),
        };
      });
    }

    expect(shape.ru).toEqual(shape.mn);
    expect(shape.en).toEqual(shape.mn);

    expect(shape.mn.count).toBeGreaterThan(0);
    expect(shape.mn.placements).toEqual(['hero', 'steps']);
  });
});

const projectRoot = path.resolve(import.meta.dirname, '..');

function distFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) distFiles(full, out);
    else if (/\.(js|html)$/.test(entry)) out.push(full);
  }
  return out;
}

test.describe('провайдеры при ПУСТЫХ идентификаторах', () => {

  test.describe.configure({ mode: 'serial' });

  let server: Server;
  let origin = '';

  test.beforeAll(async () => {
    test.setTimeout(180_000);

    rmSync(EMPTY_DIST, { recursive: true, force: true });
    const build = withExclusiveBuildLock(() =>
      spawnSync(
        process.execPath,
        [path.join(projectRoot, 'node_modules', 'astro', 'astro.js'), 'build', '--outDir', EMPTY_DIST],
        {
          cwd: projectRoot,
          encoding: 'utf8',

          env: { ...process.env, PUBLIC_GA_ID: '', PUBLIC_CLARITY_ID: '' },
        },
      ),
    );
    if (build.status !== 0) {
      throw new Error(`сборка с пустыми ID не удалась:\n${build.stdout}\n${build.stderr}`);
    }

    ({ server, origin } = await serveDir(EMPTY_DIST));
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(EMPTY_DIST, { recursive: true, force: true });
  });

  test('чанк провайдеров не собран: в сборке нет ни одного упоминания провайдеров', () => {
    const files = distFiles(EMPTY_DIST);
    expect(files.length).toBeGreaterThan(0);

    const guilty = files
      .filter((f) => /googletagmanager|clarity\.ms/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(projectRoot, f));

    expect(guilty).toEqual([]);
  });

  test('страница не делает ни одного запроса к провайдерам и не пишет ошибок в консоль', async ({ page }) => {
    const thirdParty: string[] = [];
    const errors: string[] = [];

    page.on('request', (r) => {
      if (/googletagmanager\.com|clarity\.ms/.test(r.url())) thirdParty.push(r.url());
    });
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto(origin);
    await page.waitForLoadState('load');

    await page.waitForTimeout(5000);

    expect(thirdParty).toEqual([]);
    expect(errors).toEqual([]);
  });
});

const ANALYTICS_DIST = path.join(projectRoot, 'dist-analytics');

const EMPTY_DIST = path.join(projectRoot, 'dist-empty-analytics');
const FAKE_GA_ID = 'G-TESTONLY01';
const FAKE_CLARITY_ID = 'testonly01';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
};

async function serveDir(dir: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let file = path.join(dir, decodeURIComponent(url.pathname));
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!existsSync(file) || statSync(file).isDirectory()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test.describe('провайдеры при ЗАДАННЫХ идентификаторах', () => {

  test.describe.configure({ mode: 'serial' });

  let server: Server;
  let origin = '';

  test.beforeAll(async () => {
    test.setTimeout(180_000);

    rmSync(ANALYTICS_DIST, { recursive: true, force: true });
    const build = withExclusiveBuildLock(() =>
      spawnSync(
        process.execPath,
        [path.join(projectRoot, 'node_modules', 'astro', 'astro.js'), 'build', '--outDir', ANALYTICS_DIST],
        {
          cwd: projectRoot,
          encoding: 'utf8',
          env: { ...process.env, PUBLIC_GA_ID: FAKE_GA_ID, PUBLIC_CLARITY_ID: FAKE_CLARITY_ID },
        },
      ),
    );
    if (build.status !== 0) {
      throw new Error(`сборка с искусственными ID не удалась:\n${build.stdout}\n${build.stderr}`);
    }

    ({ server, origin } = await serveDir(ANALYTICS_DIST));
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(ANALYTICS_DIST, { recursive: true, force: true });
  });

  test('в сборке с ID чанк провайдеров ЕСТЬ (контроль осмысленности остальных тестов)', () => {
    const guilty = distFiles(ANALYTICS_DIST).filter((f) =>
      readFileSync(f, 'utf8').includes('googletagmanager'),
    );
    expect(guilty.length).toBeGreaterThan(0);
  });

  test('запрос к gtag.js уходит СТРОГО после события load', async ({ page }) => {

    await page.route(/\.(avif|webp|jpg|png)(\?.*)?$/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await route.continue();
    });

    await page.route('**www.googletagmanager.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }),
    );
    await page.route('**clarity.ms/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }),
    );

    await page.goto(origin);

    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            performance.getEntriesByType('resource').some((r) => r.name.includes('googletagmanager')),
          ),
        { timeout: 20_000 },
      )
      .toBe(true);

    const timing = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      const tag = performance
        .getEntriesByType('resource')
        .find((r) => r.name.includes('googletagmanager'))!;
      return { loadEventEnd: nav.loadEventEnd, tagStart: tag.startTime };
    });

    expect(timing.loadEventEnd).toBeGreaterThan(0);
    expect(timing.tagStart).toBeGreaterThan(timing.loadEventEnd);
  });

  test('порядок согласия и page_view: два consent до config, региональное вторым, ручного page_view нет', async ({ page }) => {
    await page.route('**www.googletagmanager.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }),
    );
    await page.route('**clarity.ms/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }),
    );

    await page.goto(origin);
    await expect
      .poll(async () => (await dataLayerCommands(page)).includes('config'), { timeout: 20_000 })
      .toBe(true);

    expect(await dataLayerCommands(page)).toEqual(['consent', 'consent', 'js', 'config']);

    const layer = await page.evaluate(() =>
      (window.dataLayer ?? []).map((entry) => Array.from(entry as ArrayLike<unknown>)),
    );

    const general = layer[0][2] as Record<string, unknown>;
    expect(general.analytics_storage).toBe('granted');
    expect(general.ad_storage).toBe('denied');
    expect(general).not.toHaveProperty('region');

    const regional = layer[1][2] as Record<string, unknown>;
    expect(regional.analytics_storage).toBe('denied');
    expect(regional.wait_for_update).toBe(500);
    expect(regional.region).toContain('DE');
    expect(regional.region).toContain('GB');

    expect(regional.region).not.toContain('MN');

    const configArgs = layer[3];
    expect(configArgs[1]).toBe(FAKE_GA_ID);
    expect(configArgs[2] as Record<string, unknown>).not.toHaveProperty('send_page_view');
    expect((configArgs[2] as Record<string, unknown>).allow_google_signals).toBe(false);

    expect(await dataLayerEvents(page)).not.toContain('page_view');
  });

  test('блокировщик провайдеров не ломает страницу: кнопки, модалка, форма, события', async ({ page }) => {

    const providerHosts = /googletagmanager\.com|clarity\.ms/;
    const pageErrors: string[] = [];
    const consoleErrors: { text: string; url: string }[] = [];
    const blocked: string[] = [];

    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push({ text: m.text(), url: m.location().url });
    });
    page.on('requestfailed', (r) => {
      if (providerHosts.test(r.url())) blocked.push(r.url());
    });

    await page.route('**www.googletagmanager.com/**', (route) => route.abort('blockedbyclient'));
    await page.route('**clarity.ms/**', (route) => route.abort('blockedbyclient'));

    await page.goto(`${origin}/?__sink=1`);

    await page
      .locator('details[data-track-direction="bank"] > summary')
      .evaluate((el) => (el as HTMLElement).click());
    await expect(page.locator('details[data-track-direction="bank"]')).toHaveAttribute('open', '');

    const selected = await waitForEvent(page, 'direction_select');
    expect(selected.params.direction).toBe('bank');

    await page
      .locator('details[data-track-direction="bank"] > summary')
      .evaluate((el) => (el as HTMLElement).click());
    await expect(page.locator('details[data-track-direction="bank"]')).not.toHaveAttribute('open', '');

    await page.locator('#lead-name').fill('Бат');
    await page.locator('#lead-contact').fill('99001122');
    await page.locator('input[name="contact_channel"][value="phone"]').check();
    await page.locator('input[name="direction"]').first().check();
    await page.locator('#lead-consent').check();
    await page.locator('.lead-form__submit').click();
    await expect(page.locator('[data-lead-status] .lead-form__notice')).toBeVisible();

    expect(blocked.length).toBeGreaterThan(0);

    expect(pageErrors).toEqual([]);

    const ours = consoleErrors.filter(
      (e) =>
        !providerHosts.test(e.url) &&
        !/ERR_BLOCKED_BY_CLIENT/.test(e.text) &&
        !isOffCloudflareNoise(e.text, e.url),
    );
    expect(ours).toEqual([]);
  });

  test('события, случившиеся ДО загрузки тега, доезжают до GA4 после неё', async ({ page }) => {
    let requested = false;
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    await page.route('**www.googletagmanager.com/**', async (route) => {
      requested = true;
      await held;
      await route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
    });
    await page.route('**clarity.ms/**', (route) => route.abort('blockedbyclient'));

    await page.goto(`${origin}/?__sink=1`);
    await expect.poll(() => requested, { timeout: 20_000 }).toBe(true);

    await page
      .locator('details[data-track-direction="bank"] > summary')
      .evaluate((el) => (el as HTMLElement).click());
    await waitForEvent(page, 'direction_select');

    expect(await dataLayerCommands(page)).not.toContain('event');

    release();

    await expect
      .poll(async () => (await dataLayerEvents(page)).includes('direction_select'), { timeout: 20_000 })
      .toBe(true);
  });
});

async function dataLayerCommands(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window.dataLayer ?? []).map((entry) => String(Array.from(entry as ArrayLike<unknown>)[0])),
  );
}

async function dataLayerEvents(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window.dataLayer ?? [])
      .map((entry) => Array.from(entry as ArrayLike<unknown>))
      .filter((args) => args[0] === 'event')
      .map((args) => String(args[1])),
  );
}
