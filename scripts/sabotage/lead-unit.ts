
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');
const realModule = path.join(projectRoot, 'src', 'server', 'lead', 'message.ts');

const SUITE = 'tests/unit/lead-message.test.ts';

interface ModuleSwap {

  readonly id: string;

  readonly describe: string;

  readonly correct: string;

  readonly sabotaged: string;

  readonly anchorHint: string;

  readonly testNamePattern: string;

  readonly failureMarker: string;
}

function moduleSwapCase(swap: ModuleSwap): SabotageCase {

  let savedServerDir: string | undefined;
  let serverDirWasSet = false;
  const caseDir = path.join(tmpDir, swap.id);

  return {
    id: swap.id,
    gate: SUITE,
    describe: swap.describe,
    setup() {
      const source = readFileSync(realModule, 'utf8');

      const occurrences = source.split(swap.correct).length - 1;
      if (occurrences !== 1) {
        throw new Error(
          `в src/server/lead/message.ts ожидалось РОВНО ОДНО вхождение «${swap.correct}», ` +
            `найдено ${occurrences}. ${swap.anchorHint}`,
        );
      }

      const sabotaged = source.replace(swap.correct, swap.sabotaged);
      if (sabotaged === source) {
        throw new Error(`подмена «${swap.correct}» не изменила исходник`);
      }

      rmSync(caseDir, { recursive: true, force: true });
      mkdirSync(caseDir, { recursive: true });
      writeFileSync(path.join(caseDir, 'message.ts'), sabotaged, 'utf8');

      savedServerDir = process.env.LEAD_SERVER_DIR;
      serverDirWasSet = 'LEAD_SERVER_DIR' in process.env;
      process.env.LEAD_SERVER_DIR = caseDir;
    },

    command: [
      '--experimental-strip-types',
      '--test',
      '--test-name-pattern',
      swap.testNamePattern,
      SUITE,
    ],

    expectOutputContains: swap.failureMarker,

    greenRun: {
      command: [
        '--experimental-strip-types',
        '--test',
        '--test-name-pattern',
        swap.testNamePattern,
        SUITE,
      ],
    },
    teardown() {
      if (serverDirWasSet && savedServerDir !== undefined) {
        process.env.LEAD_SERVER_DIR = savedServerDir;
      } else {
        delete process.env.LEAD_SERVER_DIR;
      }
      savedServerDir = undefined;
      serverDirWasSet = false;
      rmSync(caseDir, { recursive: true, force: true });
    },
  };
}

const escapeOrder = moduleSwapCase({
  id: 'lead-unit-escape-order',
  describe:
    'в escapeHtml порядок замен переставлен: & заменяется ПОСЛЕДНИМ, из-за чего ' +
    'уже вставленные &lt; превращаются в &amp;lt; и менеджер читает абракадабру',
  correct: "value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')",
  sabotaged: "value.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;')",
  anchorHint:
    'Саботаж наводится на точный текст: если escapeHtml переписали — например перевели три ' +
    'замены на таблицу или на один проход replace(/[&<>]/g, …) — случай обязан упасть здесь, ' +
    'а не молча прогнать неизменённый модуль.',
  testNamePattern: 'ЭКРАНИРОВАНИЕ',
  failureMarker: 'ЭКРАНИРОВАНИЕ-НЕ-ПЕРВЫМ',
});

const timeZone = moduleSwapCase({
  id: 'lead-unit-timezone',
  describe:
    'преобразование пояса выброшено: время форматируется в UTC, и менеджер читает ' +
    '«20.08.2026, 14:57 (Улан-Батор, GMT)» вместо «22:57 (Улан-Батор, GMT+8)» — ' +
    'заявка выглядит пришедшей восемь часов назад',
  correct: '      timeZone: LEAD_TIME_ZONE,',
  sabotaged: "      timeZone: 'UTC',",
  anchorHint:
    'Саботаж подменяет ровно поле timeZone у Intl.DateTimeFormat. Если форматирование времени ' +
    'переписали (другое имя константы, другой способ получения местного времени), случай обязан ' +
    'упасть здесь: молчаливый прогон неизменённого модуля выдал бы работающий страж за доказанный.',
  testNamePattern: 'ВРЕМЯ',
  failureMarker: 'ВРЕМЯ-НЕ-МЕСТНОЕ',
});

export const cases: SabotageCase[] = [escapeOrder, timeZone];
