
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');
const realBotDir = path.join(projectRoot, 'workers', 'bot');

const id = 'bot-reply-outcome-ignored';
const suite = 'tests/unit/bot-webhook.test.ts';

const CORRECT = "    failure: disposition.kind === 'delivered' ? null : disposition,";
const SABOTAGED = '    failure: null,';

const command = [
  '--experimental-strip-types',
  '--test',
  '--test-name-pattern',
  'ОТВЕТ-ПОСЕТИТЕЛЮ',
  suite,
];

let savedDir: string | undefined;
let dirWasSet = false;

const replyOutcomeIgnored: SabotageCase = {
  id,
  gate: suite,
  describe:
    'исход отправки ответа посетителю отброшен: при 403 «заблокирован», 429 и таймауте ' +
    'конвейер идёт дальше как ни в чём не бывало — человек не получил контакта менеджера, ' +
    'менеджер считает передачу состоявшейся, и не знает об этом никто (Д-01 отменяется молча)',
  setup() {
    const dest = path.join(tmpDir, id);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    cpSync(realBotDir, dest, { recursive: true });

    const file = path.join(dest, 'webhook.ts');
    const source = readFileSync(file, 'utf8');
    const occurrences = source.split(CORRECT).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `в workers/bot/webhook.ts ожидалось РОВНО ОДНО вхождение «${CORRECT.trim()}», ` +
          `найдено ${occurrences}. Саботаж наводится на точный текст: если разбор исхода ` +
          'ответа переписали (другое имя поля, вынесенный помощник, ранний возврат), случай ' +
          'обязан упасть ЗДЕСЬ, а не молча прогнать неизменённый код и выдать страж за ' +
          'доказанный.',
      );
    }
    writeFileSync(file, source.replace(CORRECT, SABOTAGED), 'utf8');

    savedDir = process.env.BOT_MODULE_DIR;
    dirWasSet = 'BOT_MODULE_DIR' in process.env;
    process.env.BOT_MODULE_DIR = dest;
  },
  command,

  expectOutputContains: 'ИСХОД-ОТВЕТА-НЕ-ПРОВЕРЕН',

  greenRun: { command } satisfies GreenRun,
  teardown() {
    if (dirWasSet && savedDir !== undefined) process.env.BOT_MODULE_DIR = savedDir;
    else delete process.env.BOT_MODULE_DIR;
    savedDir = undefined;
    dirWasSet = false;
    rmSync(path.join(tmpDir, id), { recursive: true, force: true });
  },
};

export const cases: SabotageCase[] = [replyOutcomeIgnored];
