
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');
const standScript = 'scripts/check-sabotage.ts';

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', standScript, '--cases-dir', 'scripts/sabotage-fixtures/green'],
};

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

function writeCasesDir(id: string, source: string): string {
  const dir = path.join(tmpDir, `${id}-cases`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'fixture.ts'), source, 'utf8');
  return dir;
}

function cleanupCasesDir(id: string): void {
  rmSync(path.join(tmpDir, `${id}-cases`), { recursive: true, force: true });
}

const SUBSTRING_ON_GREEN_SOURCE = [
  '// Подложный случай саботажного стенда: подстрока достижима на зелёном прогоне.',
  '// Создан scripts/sabotage/sabotage-stand.ts, живёт доли секунды.',
  'export const cases = [',
  '  {',
  "    id: 'fixture-substring-on-green',",
  "    gate: 'check:turnstile-config',",
  "    describe: 'подстрока взята из успешного вывода гейта',",
  '    setup() {},',
  "    command: ['--experimental-strip-types', 'scripts/check-turnstile-config.ts'],",
  "    expectOutputContains: 'PASS',",
  '    greenRun: {',
  "      command: ['--experimental-strip-types', 'scripts/check-turnstile-config.ts'],",
  '      // Домен пришпилен к превью, чтобы эталон был одинаков на любой машине:',
  '      // на боевом домене с пустым sitekey гейт обязан падать, и подложный',
  '      // случай доказывал бы тогда не то, ради чего написан.',
  "      env: { PUBLIC_SITE_URL: 'https://landingmn.pages.dev', PUBLIC_TURNSTILE_SITEKEY: '' },",
  '    },',
  '    teardown() {},',
  '  },',
  '];',
  '',
].join('\n');

const substringOnGreen: SabotageCase = {
  id: 'stand-substring-reachable-on-green',
  gate: 'check:sabotage (фаза эталонов)',
  describe: 'подложный случай ждёт подстроку «PASS», которую его гейт печатает при УСПЕХЕ',
  setup() {
    writeCasesDir(this.id, SUBSTRING_ON_GREEN_SOURCE);
  },
  get command() {
    return [
      '--experimental-strip-types',
      standScript,
      '--cases-dir',
      argPath(path.join(tmpDir, `${this.id}-cases`)),
    ];
  },

  expectOutputContains: 'ПОДСТРОКА ДОСТИЖИМА НА ЗЕЛЁНОМ ПРОГОНЕ',
  greenRun: GREEN,
  teardown() {
    cleanupCasesDir(this.id);
  },
};

const WITHOUT_GREEN_SOURCE = [
  '// Подложный случай саботажного стенда: эталон не объявлен вовсе.',
  '// Создан scripts/sabotage/sabotage-stand.ts, живёт доли секунды.',
  'export const cases = [',
  '  {',
  "    id: 'fixture-without-green-run',",
  "    gate: 'check:turnstile-config',",
  "    describe: 'случай, забывший объявить greenRun',",
  '    setup() {},',
  "    command: ['--experimental-strip-types', 'scripts/check-turnstile-config.ts'],",
  "    expectOutputContains: 'TURNSTILE НА БОЕВОМ ДОМЕНЕ',",
  '    teardown() {},',
  '  },',
  '];',
  '',
].join('\n');

const withoutGreenRun: SabotageCase = {
  id: 'stand-case-without-green-run',
  gate: 'check:sabotage (разбор случаев)',
  describe: 'подложный случай не объявил greenRun — сверять его подстроку не с чем',
  setup() {
    writeCasesDir(this.id, WITHOUT_GREEN_SOURCE);
  },
  get command() {
    return [
      '--experimental-strip-types',
      standScript,
      '--cases-dir',
      argPath(path.join(tmpDir, `${this.id}-cases`)),
    ];
  },
  expectOutputContains: 'СЛУЧАЙ БЕЗ ЗЕЛЁНОГО ПРОГОНА',
  greenRun: GREEN,
  teardown() {
    cleanupCasesDir(this.id);
  },
};

export const cases: SabotageCase[] = [substringOnGreen, withoutGreenRun];
