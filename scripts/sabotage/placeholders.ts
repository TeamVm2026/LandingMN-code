
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', 'scripts/check-placeholders.ts'],
  env: { PUBLIC_SITE_URL: 'https://landingmn.pages.dev' },
  costly: 'нужна собранная dist/ (npm run build) — гейт считает заглушки в готовом HTML',
};

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

function distPath(id: string): string {
  return path.join(tmpDir, `${id}-dist`);
}

function writeFakeDist(id: string, body: string): void {
  const dest = distPath(id);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  writeFileSync(path.join(dest, 'index.html'), body, 'utf8');
}

function cleanupDist(id: string): void {
  rmSync(distPath(id), { recursive: true, force: true });
}

const WITH_PLACEHOLDER =
  '<!doctype html><html lang="mn"><body>' +
  '<a href="https://t.me/PLACEHOLDER_MANAGER">Telegram</a>' +
  '<a href="https://m.me/PLACEHOLDER_FB_PAGE">Messenger</a>' +
  '</body></html>\n';

const ENV_KEYS = ['PUBLIC_SITE_URL'] as const;
let savedEnv: Record<string, string | undefined> = {};

function setProdDomain(): void {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.PUBLIC_SITE_URL = 'https://partner-melbet.com';
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const previous = savedEnv[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

const placeholdersOnProd: SabotageCase = {
  id: 'placeholders-on-prod-domain',
  gate: 'check:placeholders',
  describe: 'PUBLIC_SITE_URL переключён на боевой домен, а в сборке остались PLACEHOLDER-контакты',
  setup() {
    writeFakeDist(this.id, WITH_PLACEHOLDER);
    setProdDomain();
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-placeholders.ts',
      '--dist',
      argPath(distPath(this.id)),
    ];
  },
  expectOutputContains: 'ЗАГЛУШКИ В БОЕВОЙ СБОРКЕ',
  greenRun: GREEN,
  teardown() {
    restoreEnv();
    cleanupDist(this.id);
  },
};

const missingDist: SabotageCase = {
  id: 'placeholders-missing-dist',
  gate: 'check:placeholders',
  describe: 'каталога сборки нет вовсе — гейт обязан упасть, а не отчитаться «заглушек нет»',
  setup() {
    cleanupDist(this.id);
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-placeholders.ts',
      '--dist',
      argPath(distPath(this.id)),
    ];
  },
  expectOutputContains: 'сначала `npm run build`',
  greenRun: GREEN,
  teardown() {
    cleanupDist(this.id);
  },
};

export const cases: SabotageCase[] = [placeholdersOnProd, missingDist];
