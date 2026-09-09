
import { cpSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const distDir = path.join(projectRoot, 'dist');

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', 'scripts/check-seo.ts'],
  costly: 'нужна собранная dist/ (npm run build) — гейт читает готовые HTML шести страниц',
};

function sandbox(id: string): string {
  return path.join(distDir, `__sabotage-${id}`);
}

function prepareCopy(id: string): string {
  const target = sandbox(id);
  rmSync(target, { recursive: true, force: true });
  if (!existsSync(distDir)) throw new Error('dist/ не собран — саботировать нечего');

  for (const rel of [
    'index.html',
    'ru/index.html',
    'en/index.html',
    'privacy/index.html',
    'ru/privacy/index.html',
    'en/privacy/index.html',
  ]) {
    const from = path.join(distDir, rel);
    if (!existsSync(from)) throw new Error(`в сборке нет ${rel}`);
    cpSync(from, path.join(target, rel), { recursive: false, force: true });
  }
  return target;
}

const ogTitleOfHome: SabotageCase = {
  id: 'seo-og-title-of-home-on-privacy',
  gate: 'check:seo',
  describe: 'политика конфиденциальности отдаёт в соцсети og:title ГЛАВНОЙ страницы',
  setup() {
    const target = prepareCopy(this.id);
    const file = path.join(target, 'privacy', 'index.html');
    const html = readFileSync(file, 'utf8');
    const home = readFileSync(path.join(target, 'index.html'), 'utf8');
    const homeOg = home.match(/property="og:title"\s+content="([^"]*)"/)?.[1];
    if (!homeOg) throw new Error('на главной не найден og:title — саботировать нечем');
    const patched = html.replace(
      /(property="og:title"\s+content=")[^"]*(")/,
      `$1${homeOg}$2`,
    );
    if (patched === html) throw new Error('og:title политики не найден — якорь случая умер');
    writeFileSync(file, patched, 'utf8');
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-seo.ts',
      '--dist',
      path.relative(projectRoot, sandbox(this.id)).replace(/\\/g, '/'),
    ];
  },
  expectOutputContains: 'не совпадает с её <title>',
  greenRun: GREEN,
  teardown() {
    rmSync(sandbox(this.id), { recursive: true, force: true });
  },
};

export const cases: SabotageCase[] = [ogTitleOfHome];
