
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp', 'unit-runner');
const rel = (p: string): string => path.relative(projectRoot, p).split(String.fromCharCode(92)).join('/');

const GREEN: GreenRun = {
  command: ['scripts/run-unit-tests.mjs', '--glob', 'tests/unit/report-throttle.test.ts'],
};

export const cases: SabotageCase[] = [
  {
    id: 'unit-runner-keeps-real-failure-red',
    gate: 'check:lead-unit',
    describe:
      'Настоящее падение утверждения (`not ok` внутри файла) обязано пройти сквозь обёртку ' +
      'красным и без повтора: повтор разрешён только строке ошибки Node.',
    greenRun: GREEN,
    expectOutputContains: 'настоящая краснота модульных тестов — повтор не применяется',
    setup() {
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(
        path.join(tmpDir, 'krasnyj.test.ts'),
        "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n" +
          "test('заведомо красный', () => { assert.equal(1, 2); });\n",
        'utf8',
      );
    },
    command: ['scripts/run-unit-tests.mjs', '--glob', rel(path.join(tmpDir, '*.test.ts'))],
    teardown() {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  },
];
