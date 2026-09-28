
import type { Page } from '@playwright/test';

const CAP_MS = 3000;

export async function waitSettled(page: Page, scope?: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);

  await page.evaluate(
    (cap) =>
      Promise.all(
        [...document.images]
          .filter((i) => {
            if (i.complete) return false;
            const r = i.getBoundingClientRect();
            return r.bottom > 0 && r.top < window.innerHeight;
          })
          .map(
            (i) =>
              new Promise<void>((res) => {
                const done = (): void => res();
                i.addEventListener('load', done, { once: true });
                i.addEventListener('error', done, { once: true });
                setTimeout(done, cap);
              }),
          ),
      ).then(() => undefined),
    CAP_MS,
  );

  if (scope !== undefined) {

    await page.evaluate(
      async ([sel, cap]) => {
        const running = [...document.querySelectorAll(sel as string)].flatMap((el) =>
          el.getAnimations?.({ subtree: true }) ?? [],
        );
        await Promise.race([
          Promise.all(running.map((a) => a.finished.then(() => undefined).catch(() => undefined))),
          new Promise<void>((r) => setTimeout(r, cap as number)),
        ]);
      },
      [scope, CAP_MS] as const,
    );
  }

  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}
