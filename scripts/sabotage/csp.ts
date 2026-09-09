
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';
import { ENFORCE_HEADER, REPORT_ONLY_HEADER } from '../lib/csp-sources.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const realDist = path.join(projectRoot, 'dist');
const copyDir = path.join(projectRoot, '.sabotage-tmp', 'csp-dist');

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

const GATE_ARGV = ['--experimental-strip-types', 'scripts/check-csp.ts', '--dist', argPath(copyDir)];

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', 'scripts/check-csp.ts'],
  costly: 'нужна собранная dist/ (npm run build) — гейт читает готовый _headers и готовый HTML',
};

const FOREIGN_ORIGIN = 'https://evil.example.com';

function neededFiles(dir: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...neededFiles(path.join(dir, entry.name), rel));
    else if (entry.name === '_headers' || /\.(?:html|js|mjs|css)$/.test(entry.name)) found.push(rel);
  }
  return found;
}

function prepareCleanCopy(): void {
  rmSync(copyDir, { recursive: true, force: true });

  if (!existsSync(realDist)) throw new Error('нет каталога dist/ — сначала npm run build');
  const files = neededFiles(realDist);
  if (files.length === 0) throw new Error('в dist/ нет ни html, ни _headers — сборка пуста или идёт прямо сейчас');
  for (const rel of files) {
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
}

const foreignOrigin: SabotageCase = {
  id: 'csp-foreign-origin',
  gate: 'check:csp',
  describe:
    `в разметку попал <script src="${FOREIGN_ORIGIN}/x.js">, не заявленный ни в манифесте ` +
    'внешних оригенов, ни в политике — в enforce это белый экран у посетителя',

  setup() {
    prepareCleanCopy();

    const target = path.join(copyDir, 'index.html');
    const original = readFileSync(target, 'utf8');

    const marker = '</head>';
    if (!original.includes(marker)) {
      throw new Error('в копии index.html нет </head> — вставлять скрипт некуда');
    }
    writeFileSync(
      target,
      original.replace(marker, `<script src="${FOREIGN_ORIGIN}/x.js"></script>${marker}`),
      'utf8',
    );
  },

  command: GATE_ARGV,

  expectOutputContains: `FAIL [csp] ${FOREIGN_ORIGIN} встречается в сборке`,
  greenRun: GREEN,

  teardown() {
    rmSync(copyDir, { recursive: true, force: true });
  },
};

const enforceTooEarly: SabotageCase = {
  id: 'csp-enforce-too-early',
  gate: 'check:csp',
  describe:
    `в _headers стёрли «-Report-Only» — то есть включили ${ENFORCE_HEADER} до подтверждения ` +
    'интеграций на живом домене (угроза T-08-17, запрет Д-01)',

  setup() {
    prepareCleanCopy();

    const target = path.join(copyDir, '_headers');
    const original = readFileSync(target, 'utf8');
    const broken = original.replace(`${REPORT_ONLY_HEADER}:`, `${ENFORCE_HEADER}:`);
    if (broken === original) {
      throw new Error(
        `подстановка в _headers ничего не изменила — искали «${REPORT_ONLY_HEADER}:»; ` +
          'политику в копию не дописало пост-сборочное звено',
      );
    }
    writeFileSync(target, broken, 'utf8');
  },

  command: GATE_ARGV,

  expectOutputContains: `стоит заголовок ${ENFORCE_HEADER} (режим принуждения)`,
  greenRun: GREEN,

  teardown() {
    rmSync(copyDir, { recursive: true, force: true });
  },
};

export const cases: SabotageCase[] = [foreignOrigin, enforceTooEarly];
