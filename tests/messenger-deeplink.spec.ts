
import { test, expect } from '@playwright/test';

const BTN = 'a[data-track-channel="messenger"]';
const UAS: Record<string, string | undefined> = {
  'десктоп': undefined,
  'Android Chrome': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128 Mobile Safari/537.36',
  'iPhone Safari': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
  'iPhone внутри Facebook': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 [FBAN/FBIOS;FBAV/430.0.0;FBDV/iPhone15,2;FBSN/iOS;FBSV/17.0]',
  'iPhone внутри Messenger': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 [FBAN/MessengerForiOS;FBAV/430.0;FBDV/iPhone15,2;FBSN/iOS;FBSV/17.0]',
  'Android внутри Facebook': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/430.0.0.0;]',
};

for (const [name, userAgent] of Object.entries(UAS)) {
  test(`${name}: кнопка Messenger — обычная m.me, скрипт её не переписывает и не перехватывает`, async ({ browser }) => {
    const mobile = userAgent !== undefined;
    const ctx = await browser.newContext(
      mobile ? { userAgent, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {},
    );
    const page = await ctx.newPage();
    await page.goto('/');
    await page.waitForSelector('form[data-lead-form][data-lead-form-ready]');
    const hrefs = await page.$$eval(BTN, (els) => els.map((a) => a.getAttribute('href') ?? ''));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) expect(h, name).toMatch(/^https:\/\/m\.me\//);
    expect(await page.locator(`${BTN}[data-deeplink]`).count(), 'след снятого диплинка').toBe(0);

    const prevented = await page.evaluate(() => {
      const a = document.querySelector('a[data-track-channel="messenger"]') as HTMLAnchorElement;
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
      let stopped = false;
      a.addEventListener('click', (e) => { stopped = e.defaultPrevented; });

      a.addEventListener('click', (e) => e.preventDefault(), { capture: false });
      a.dispatchEvent(ev);
      return stopped;
    });
    expect(prevented, `${name}: клик перехвачен скриптом`).toBe(false);
    await ctx.close();
  });
}
