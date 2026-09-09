
import { mkdirSync, copyFileSync, appendFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const caseDir = path.join(projectRoot, '.sabotage-tmp', 'critical-path');

const REAL_SPEC = 'tests/critical-path.spec.ts';
const REAL_GUARD = 'tests/unit/critical-path-inventory.test.ts';

const COPY_SPEC = '.sabotage-tmp/critical-path/critical-path.spec.ts';
const COPY_GUARD = '.sabotage-tmp/critical-path/critical-path-inventory.test.ts';

const NAME_PATTERN = 'ПРОПУСК';

const SPEC_ENV = 'CRITICAL_PATH_SPEC';

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', '--test', '--test-name-pattern', NAME_PATTERN, REAL_GUARD],
  env: { [SPEC_ENV]: REAL_SPEC },
};

let savedSpecEnv: string | undefined;
let specEnvWasSet = false;

const skippedCriticalPath: SabotageCase = {
  id: 'critical-path-silently-skipped',
  gate: REAL_GUARD,
  describe:
    'сквозной тест критического пути помечен пропуском — Playwright при этом ЗЕЛЁН, ' +
    'тест просто исчезает из отчёта, и закричать обязан только страж инвентаря',
  setup() {
    rmSync(caseDir, { recursive: true, force: true });
    mkdirSync(caseDir, { recursive: true });
    copyFileSync(path.join(projectRoot, REAL_SPEC), path.join(projectRoot, COPY_SPEC));
    copyFileSync(path.join(projectRoot, REAL_GUARD), path.join(projectRoot, COPY_GUARD));

    appendFileSync(
      path.join(projectRoot, COPY_SPEC),
      [
        '',
        '// Дописано саботажным стендом. Живёт доли секунды, копия удаляется в teardown().',
        "test.skip('временно выключено перед релизом', async () => {});",
        '',
      ].join('\n'),
      'utf8',
    );

    savedSpecEnv = process.env[SPEC_ENV];
    specEnvWasSet = SPEC_ENV in process.env;
    process.env[SPEC_ENV] = COPY_SPEC;
  },

  command: ['--experimental-strip-types', '--test', '--test-name-pattern', NAME_PATTERN, COPY_GUARD],

  expectOutputContains: 'КРИТИЧЕСКИЙ-ПУТЬ-ВЫКЛЮЧЕН',
  greenRun: GREEN,
  teardown() {
    if (specEnvWasSet && savedSpecEnv !== undefined) {
      process.env[SPEC_ENV] = savedSpecEnv;
    } else {
      delete process.env[SPEC_ENV];
    }
    savedSpecEnv = undefined;
    specEnvWasSet = false;
    rmSync(caseDir, { recursive: true, force: true });
  },
};

export const cases: SabotageCase[] = [skippedCriticalPath];
