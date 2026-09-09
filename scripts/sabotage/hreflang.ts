
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', 'scripts/check-hreflang.ts'],
  costly: 'нужна собранная dist/ (npm run build) — гейт читает готовый HTML',
};

import { PAGE_ROUTES } from '../../src/i18n/routes.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const realDist = path.join(projectRoot, 'dist');
const copyDir = path.join(projectRoot, '.sabotage-tmp', 'hreflang-dist');

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

const GATE_ARGV = [
  '--experimental-strip-types',
  'scripts/check-hreflang.ts',
  '--dist',
  argPath(copyDir),
];

function listHtml(dir: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...listHtml(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.html')) found.push(rel);
  }
  return found;
}

function indexableHeadBlock(): string {
  const landing = readFileSync(path.join(realDist, 'index.html'), 'utf8');

  const alternates = landing.match(/<link[^>]*rel="alternate"[^>]*hreflang="[^"]*"[^>]*>/g) ?? [];
  const canonical = landing.match(/<link[^>]*rel="canonical"[^>]*>/g) ?? [];
  if (alternates.length !== 4 || canonical.length !== 1) {
    throw new Error(
      `dist/index.html не выглядит индексируемой страницей: ${alternates.length} hreflang ` +
        `(ожидалось 4 с x-default) и ${canonical.length} canonical (ожидался 1) — ` +
        'брать образец тегов не из чего',
    );
  }

  const href = canonical[0].match(/href="([^"]+)"/)?.[1];
  if (!href) throw new Error('в canonical главной страницы нет href — не из чего взять origin');
  const { origin } = new URL(href);

  let block = [...alternates, ...canonical].join('');
  for (const locale of ['mn', 'ru', 'en'] as const) {
    const from = `href="${origin}${PAGE_ROUTES.home[locale]}"`;
    const to = `href="${origin}${PAGE_ROUTES.thanks[locale]}"`;
    const moved = block.replaceAll(from, to);
    if (moved === block) {
      throw new Error(`в тегах главной не нашлось адреса ${from} — форма адресов изменилась`);
    }
    block = moved;
  }
  return block;
}

const thanksIndexable: SabotageCase = {
  id: 'hreflang-thanks-indexable',
  gate: 'check:hreflang',
  describe: 'страница /thanks/ собрана без noindex, зато с canonical и полным набором hreflang',

  setup() {
    rmSync(copyDir, { recursive: true, force: true });

    if (!existsSync(realDist)) {
      throw new Error('нет каталога dist/ — сначала npm run build');
    }
    const pages = listHtml(realDist);
    if (pages.length === 0) {
      throw new Error('в dist/ нет ни одной .html — сборка пуста или идёт прямо сейчас');
    }
    for (const rel of pages) {
      const dest = path.join(copyDir, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(path.join(realDist, rel)));
    }

    const clean = spawnSync(process.execPath, GATE_ARGV, { cwd: projectRoot, encoding: 'utf8' });
    if (clean.status !== 0) {
      throw new Error(
        'копия dist/ не зелёная ДО подстановки — падение гейта было бы не по делу:\n' +
          `${clean.stdout ?? ''}${clean.stderr ?? ''}`,
      );
    }

    const target = path.join(copyDir, 'thanks', 'index.html');
    const original = readFileSync(target, 'utf8');
    const block = indexableHeadBlock();
    const broken = original.replace(/<meta[^>]*name="robots"[^>]*>/, () => block);
    if (broken === original) {
      throw new Error(
        'подстановка в thanks/index.html ничего не изменила — искали <meta name="robots">',
      );
    }
    writeFileSync(target, broken, 'utf8');
  },

  command: GATE_ARGV,

  expectOutputContains: `FAIL [thanks/mn] ${argPath(copyDir)}/thanks/index.html`,
  greenRun: GREEN,

  teardown() {
    rmSync(copyDir, { recursive: true, force: true });
  },
};

export const cases: SabotageCase[] = [thanksIndexable];
