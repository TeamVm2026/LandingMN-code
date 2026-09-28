
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';
import { PAGE_ROUTES } from '../../src/i18n/routes.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const realDist = path.join(projectRoot, 'dist');
const copyDir = path.join(projectRoot, '.sabotage-tmp', 'links-dist');

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

const GATE_ARGV = [
  '--experimental-strip-types',
  'scripts/check-links.ts',
  '--dist',
  argPath(copyDir),
];

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', 'scripts/check-links.ts'],
  costly: 'нужна собранная dist/ (npm run build) — гейт читает готовый HTML',
};

const MISSING_ROUTE = '/этой-страницы-нет-в-сборке/';

const LIVE_ROUTE = PAGE_ROUTES.privacy.mn;

function listFiles(dir: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...listFiles(path.join(dir, entry.name), rel));
    else found.push(rel);
  }
  return found;
}

function copyRealDist(into: string): void {
  rmSync(into, { recursive: true, force: true });

  if (!existsSync(realDist)) {
    throw new Error('нет каталога dist/ — сначала npm run build');
  }
  const files = listFiles(realDist);
  if (files.length === 0) {
    throw new Error('в dist/ нет ни одного файла — сборка пуста или идёт прямо сейчас');
  }
  for (const rel of files) {
    const dest = path.join(into, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(path.join(realDist, rel)));
  }
}

function requireGreen(argv: string[], why: string): void {
  const run = spawnSync(process.execPath, argv, { cwd: projectRoot, encoding: 'utf8' });
  if (run.status !== 0) {
    throw new Error(`${why}:\n${run.stdout ?? ''}${run.stderr ?? ''}`);
  }
}

const brokenInternalLink: SabotageCase = {
  id: 'links-internal-target-missing',
  gate: 'check:links',
  describe: `ссылка на ${LIVE_ROUTE} в подвале главной уехала на несуществующий адрес`,

  setup() {
    copyRealDist(copyDir);

    requireGreen(GATE_ARGV, 'копия dist/ не зелёная ДО подстановки — падение гейта было бы не по делу');

    const target = path.join(copyDir, 'index.html');
    const original = readFileSync(target, 'utf8');

    const broken = original.replace(`href="${LIVE_ROUTE}"`, `href="${MISSING_ROUTE}"`);
    if (broken === original) {
      throw new Error(
        `подстановка в index.html ничего не изменила — искали href="${LIVE_ROUTE}"; ` +
          'форма ссылки на страницу политики изменилась',
      );
    }
    writeFileSync(target, broken, 'utf8');
  },

  command: GATE_ARGV,

  expectOutputContains: `FAIL [ссылка] ${argPath(copyDir)}/index.html → ${MISSING_ROUTE}`,
  greenRun: GREEN,

  teardown() {
    rmSync(copyDir, { recursive: true, force: true });
  },
};

const glueCopyDir = path.join(projectRoot, '.sabotage-tmp', 'links-glue-dist');
const GLUE_ARGV = ['--experimental-strip-types', 'scripts/check-links.ts', '--dist', argPath(glueCopyDir)];
const UNDECLARED_ORIGIN = 'https://sabotage-undeclared.invalid';

const glue = (second: string): string =>
  `\n;var __sabotageA=\`https://t.me\`,__sabotageB=\`${second}\`;\n`;

function firstChunk(dir: string): string {
  const astroDir = path.join(dir, '_astro');
  const js = existsSync(astroDir) ? readdirSync(astroDir).filter((n) => n.endsWith('.js')).sort() : [];
  if (js.length === 0) throw new Error('в копии dist/_astro нет ни одного .js — сверять оригены в чанках нечем');
  return path.join(astroDir, js[0]!);
}

const templateLiteralOrigin: SabotageCase = {
  id: 'links-chunk-template-literal-origin',
  gate: 'check:links',
  describe:
    'в чанке склеены шаблонные литералы `https://t.me`,`…` — заявленная пара не должна давать ложной тревоги, незаявленный хост должен быть назван',

  setup() {
    copyRealDist(glueCopyDir);
    requireGreen(GLUE_ARGV, 'копия dist/ не зелёная ДО подстановки — падение гейта было бы не по делу');

    const chunk = firstChunk(glueCopyDir);
    const original = readFileSync(chunk, 'utf8');

    writeFileSync(chunk, original + glue('https://m.me'), 'utf8');
    requireGreen(
      GLUE_ARGV,
      'ЛОЖНАЯ ТРЕВОГА: склейка двух заявленных оригенов в шаблонных литералах валит гейт — ' +
        'обратная кавычка снова не считается концом адреса (scripts/check-links.ts, sweepOrigins)',
    );

    writeFileSync(chunk, original + glue(UNDECLARED_ORIGIN), 'utf8');
  },

  command: GLUE_ARGV,

  expectOutputContains: `FAIL [ориген] ${UNDECLARED_ORIGIN}\n`,
  greenRun: GREEN,

  teardown() {
    rmSync(glueCopyDir, { recursive: true, force: true });
  },
};

export const cases: SabotageCase[] = [brokenInternalLink, templateLiteralOrigin];
