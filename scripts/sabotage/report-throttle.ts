
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');
const realModule = path.join(projectRoot, 'src', 'server', 'report', 'throttle.ts');
const caseDir = path.join(tmpDir, 'report-dedup-off');

const SUITE = 'tests/unit/report-throttle.test.ts';
const TEST_NAME_PATTERN = 'ДЕДУПЛИКАЦИЯ';
const FAILURE_MARKER = 'ДЕДУПЛИКАЦИЯ-ВЫКЛЮЧЕНА';

const CORRECT = 'export const DEDUP_WINDOW_MS = 60 * 60 * 1000;';
const SABOTAGED = 'export const DEDUP_WINDOW_MS = 0;';

let savedReportDir: string | undefined;
let reportDirWasSet = false;

const command = [
  '--experimental-strip-types',
  '--test',
  '--test-name-pattern',
  TEST_NAME_PATTERN,
  SUITE,
];

const dedupOff: SabotageCase = {
  id: 'report-dedup-off',
  gate: SUITE,
  describe:
    'окно дедупликации отчётов о клиентских ошибках выключено (0 мс): одна поломка у ' +
    'тысячи посетителей превращается в тысячу одинаковых сообщений, техчат перестают ' +
    'читать, и следующая настоящая авария проходит незамеченной',
  setup() {
    const source = readFileSync(realModule, 'utf8');

    const occurrences = source.split(CORRECT).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `в src/server/report/throttle.ts ожидалось РОВНО ОДНО вхождение «${CORRECT}», ` +
          `найдено ${occurrences}. Саботаж наводится на точный текст: если объявление окна ` +
          'переписали (другое имя, вычисляемое значение, перенос в другой файл), случай обязан ' +
          'упасть здесь, а не молча прогнать неизменённый модуль.',
      );
    }

    const sabotaged = source.replace(CORRECT, SABOTAGED);
    if (sabotaged === source) throw new Error(`подмена «${CORRECT}» не изменила исходник`);

    rmSync(caseDir, { recursive: true, force: true });
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(path.join(caseDir, 'throttle.ts'), sabotaged, 'utf8');

    savedReportDir = process.env.REPORT_SERVER_DIR;
    reportDirWasSet = 'REPORT_SERVER_DIR' in process.env;
    process.env.REPORT_SERVER_DIR = caseDir;
  },
  command,
  expectOutputContains: FAILURE_MARKER,

  greenRun: { command },
  teardown() {
    if (reportDirWasSet && savedReportDir !== undefined) {
      process.env.REPORT_SERVER_DIR = savedReportDir;
    } else {
      delete process.env.REPORT_SERVER_DIR;
    }
    savedReportDir = undefined;
    reportDirWasSet = false;
    rmSync(caseDir, { recursive: true, force: true });
  },
};

export const cases: SabotageCase[] = [dedupOff];
