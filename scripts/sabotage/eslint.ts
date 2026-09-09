
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const caseDir = path.join(projectRoot, '.sabotage-tmp', 'eslint');
const brokenFile = path.join(caseDir, 'const-assign.js');

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

const ESLINT_BIN = 'node_modules/eslint/bin/eslint.js';

const GREEN: GreenRun = {
  command: [ESLINT_BIN, '.'],
};

const constAssign: SabotageCase = {
  id: 'eslint-const-assign',
  gate: 'npm run lint',
  describe: 'в дерево попал файл с присваиванием в const — линтер обязан назвать правило и упасть',
  setup() {
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(
      brokenFile,
      [
        '// Файл саботажного стенда. Живёт доли секунды, удаляется в teardown().',
        'const answer = 1;',
        'answer = 2;',
        'export { answer };',
        '',
      ].join('\n'),
      'utf8',
    );
  },

  command: [ESLINT_BIN, '--no-ignore', argPath(brokenFile)],
  expectOutputContains: 'no-const-assign',
  greenRun: GREEN,
  teardown() {
    rmSync(caseDir, { recursive: true, force: true });
  },
};

export const cases: SabotageCase[] = [constAssign];
