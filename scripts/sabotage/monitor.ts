
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');
const realModule = path.join(projectRoot, 'workers', 'bot', 'monitor.ts');

const caseDir = path.join(tmpDir, 'monitor-flap');

const SUITE = 'tests/unit/monitor-uptime.test.ts';
const TEST_NAME_PATTERN = 'МИГАНИЕ';
const FAILURE_MARKER = 'МИГАНИЕ-ПОРОЖДАЕТ-СООБЩЕНИЯ';

const CORRECT = 'export const UPTIME_CONSECUTIVE_FAILURES = 2;';
const SABOTAGED = 'export const UPTIME_CONSECUTIVE_FAILURES = 1;';

let savedModuleDir: string | undefined;
let moduleDirWasSet = false;

const command = [
  '--experimental-strip-types',
  '--test',
  '--test-name-pattern',
  TEST_NAME_PATTERN,
  SUITE,
];

const flapThreshold: SabotageCase = {
  id: 'monitor-flap-threshold',
  gate: SUITE,
  describe:
    'порог подряд идущих неудач опущен до 1: одиночный сетевой всхлип снова порождает ' +
    'сообщение в техчат. Правка выглядит как ускорение обнаружения аварии вдвое, а на деле ' +
    'приучает не читать техчат — и следующая настоящая авария проходит незамеченной',
  setup() {
    const source = readFileSync(realModule, 'utf8');

    const occurrences = source.split(CORRECT).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `в workers/bot/monitor.ts ожидалось РОВНО ОДНО вхождение «${CORRECT}», ` +
          `найдено ${String(occurrences)}. Саботаж наводится на точный текст: если объявление ` +
          'порога переписали (другое имя, вычисляемое значение, перенос в другой файл), случай ' +
          'обязан упасть здесь, а не молча прогнать неизменённый модуль.',
      );
    }

    const sabotaged = source.replace(CORRECT, SABOTAGED);
    if (sabotaged === source) throw new Error(`подмена «${CORRECT}» не изменила исходник`);

    const depth = path.relative(projectRoot, caseDir).split(path.sep).filter(Boolean).length;
    if (depth !== 2) {
      throw new Error(
        `каталог копии «${path.relative(projectRoot, caseDir)}» лежит на глубине ${String(depth)}, ` +
          'а нужна ровно 2: monitor.ts импортирует ../../src/server/lead/message.ts, и с другой ' +
          'глубины этот путь уходит мимо дерева.',
      );
    }

    rmSync(caseDir, { recursive: true, force: true });
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(path.join(caseDir, 'monitor.ts'), sabotaged, 'utf8');

    savedModuleDir = process.env.MONITOR_MODULE_DIR;
    moduleDirWasSet = 'MONITOR_MODULE_DIR' in process.env;
    process.env.MONITOR_MODULE_DIR = caseDir;
  },
  command,
  expectOutputContains: FAILURE_MARKER,

  greenRun: { command },
  teardown() {
    if (moduleDirWasSet && savedModuleDir !== undefined) {
      process.env.MONITOR_MODULE_DIR = savedModuleDir;
    } else {
      delete process.env.MONITOR_MODULE_DIR;
    }
    savedModuleDir = undefined;
    moduleDirWasSet = false;
    rmSync(caseDir, { recursive: true, force: true });
  },
};

export const cases: SabotageCase[] = [flapThreshold];
