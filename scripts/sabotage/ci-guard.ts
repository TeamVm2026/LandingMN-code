
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');
const id = 'ci-guard-fork-clause-lost';

const CORRECT = '      && github.event.workflow_run.head_repository.full_name == github.repository }}';
const SABOTAGED = '      }}';

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

const deployCopy = path.join(tmpDir, `${id}-deploy.yml`);
const realCi = path.join(projectRoot, '.github', 'workflows', 'ci.yml');

const GREEN: GreenRun = { command: ['scripts/check-ci-guard.mjs'] };

const forkClauseLost: SabotageCase = {
  id,
  gate: 'check:ci-guard',
  describe:
    'из условия задания выкладки убрана клауза происхождения прогона: pull request из ' +
    'форка после зелёного CI доезжает до секретов и боевого воркера',
  setup() {
    const source = readFileSync(path.join(projectRoot, '.github', 'workflows', 'deploy.yml'), 'utf8');
    const occurrences = source.split(CORRECT).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `в deploy.yml ожидалось РОВНО ОДНО вхождение «${CORRECT.trim()}», найдено ${occurrences}. ` +
          'Если условие переписали, случай обязан упасть здесь, а не прогнать неизменённый файл.',
      );
    }
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(deployCopy, source.replace(CORRECT, SABOTAGED), 'utf8');
  },
  command: ['scripts/check-ci-guard.mjs', argPath(deployCopy), argPath(realCi)],
  expectOutputContains: 'ЭТО ТА САМАЯ ДЫРА',
  greenRun: GREEN,
  teardown() {
    rmSync(deployCopy, { force: true });
  },
};

export const cases: SabotageCase[] = [forkClauseLost];
