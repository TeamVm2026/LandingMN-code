
import { test, expect } from '@playwright/test';
import { PAGE_ROUTES } from '../src/i18n/routes';
import { CLIENT_MAX_PER_PAGELOAD } from '../src/server/report/throttle';

const ENDPOINT = '**/api/client-error';

interface Sent {
  kind?: string;
  message?: string;
  source?: string;
  line?: number | null;
  col?: number | null;
  route?: string;
  locale?: string;
  ua?: string;
}

async function collectReports(page: import('@playwright/test').Page): Promise<Sent[]> {
  const sent: Sent[] = [];
  await page.route(ENDPOINT, async (route) => {
    const body = route.request().postData() ?? '';
    try {
      sent.push(JSON.parse(body) as Sent);
    } catch {
      sent.push({});
    }
    await route.fulfill({ status: 204, body: '' });
  });
  return sent;
}

async function waitForDeferredModule(page: import('@playwright/test').Page): Promise<void> {
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.querySelector<HTMLInputElement>('#lead-contact')?.inputMode ?? '',
        ),
      { timeout: 10_000 },
    )
    .not.toBe('');
}

test.describe('MON-02: перехват клиентских ошибок', () => {
  test('исключение и отказ промиса уезжают в /api/client-error с нужными полями', async ({
    page,
  }) => {
    const sent = await collectReports(page);
    await page.goto(PAGE_ROUTES.home.ru);
    await waitForDeferredModule(page);

    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('ПРОВЕРКА ПЕРЕХВАТА: исключение');
      }, 0);
    });
    await expect.poll(() => sent.length, { timeout: 5000 }).toBe(1);

    const first = sent[0];
    expect(first?.kind).toBe('js-error');
    expect(first?.message).toContain('ПРОВЕРКА ПЕРЕХВАТА: исключение');
    expect(first?.route).toBe(PAGE_ROUTES.home.ru);
    expect(first?.locale).toBe('ru');
    expect(first?.ua ?? '').not.toBe('');
    expect(typeof first?.line).toBe('number');

    await page.evaluate(() => {
      void Promise.reject(new Error('ПРОВЕРКА ПЕРЕХВАТА: промис'));
    });
    await expect.poll(() => sent.length, { timeout: 5000 }).toBe(2);
    expect(sent[1]?.kind).toBe('promise');
    expect(sent[1]?.message).toContain('ПРОВЕРКА ПЕРЕХВАТА: промис');
  });

  test('потолок на загрузку страницы обрывает поток тел', async ({ page }) => {
    const sent = await collectReports(page);
    await page.goto(PAGE_ROUTES.home.ru);
    await waitForDeferredModule(page);

    const attempts = CLIENT_MAX_PER_PAGELOAD * 2;
    for (let i = 0; i < attempts; i++) {
      await page.evaluate((index: number) => {
        setTimeout(() => {
          throw new Error(`ПРОВЕРКА ПОТОЛКА ${String(index)}`);
        }, 0);
      }, i);
    }

    await expect.poll(() => sent.length, { timeout: 5000 }).toBe(CLIENT_MAX_PER_PAGELOAD);

    await page.waitForTimeout(500);
    expect(
      sent.length,
      `ПОТОЛОК-КЛИЕНТА-НЕ-СРАБОТАЛ: ${String(attempts)} ошибок дали ${String(sent.length)} тел`,
    ).toBe(CLIENT_MAX_PER_PAGELOAD);
  });

  test('ошибка загрузки ресурса (блокировщик) НЕ уезжает в техчат', async ({ page }) => {
    const sent = await collectReports(page);
    await page.goto(PAGE_ROUTES.home.ru);
    await waitForDeferredModule(page);

    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        const img = document.createElement('img');
        img.addEventListener('error', () => resolve());
        img.src = '/__нет-такой-картинки-8f3a.png';
        document.body.appendChild(img);
      });
    });
    await page.waitForTimeout(500);

    expect(sent.length, 'ШУМ-ДОСТАВЛЕН: ошибка загрузки ресурса ушла в приёмник').toBe(0);
  });
});
