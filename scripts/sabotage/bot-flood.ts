
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');
const realBotDir = path.join(projectRoot, 'workers', 'bot');

const id = 'bot-flood-marks-every-update';
const suite = 'tests/unit/bot-webhook.test.ts';

const CORRECT = '    const visitorChat = String(parsed.chatId);';

const SABOTAGED = '    await markUpdate(kv, parsed.updateId);\n' + CORRECT;

const command = ['--experimental-strip-types', '--test', '--test-name-pattern', 'ФЛУД', suite];

let savedDir: string | undefined;
let dirWasSet = false;

const floodMarksEveryUpdate: SabotageCase = {
  id,
  gate: suite,
  describe:
    'метка дедупликации снова пишется на каждый апдейт, до окна охлаждения: тысяча ' +
    'сообщений боту от одного человека вычерпывает общий с журналом заявок суточный ' +
    'бюджет KV, и форма сайта отвечает 500 всем посетителям',
  setup() {
    const dest = path.join(tmpDir, id);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    cpSync(realBotDir, dest, { recursive: true });

    const file = path.join(dest, 'webhook.ts');
    const source = readFileSync(file, 'utf8');
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const occurrences = source.split(CORRECT).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `в workers/bot/webhook.ts ожидалось РОВНО ОДНО вхождение «${CORRECT.trim()}», ` +
          `найдено ${occurrences}. Саботаж наводится на точный текст: если конвейер ` +
          'переписали, случай обязан упасть ЗДЕСЬ, а не молча прогнать неизменённый код.',
      );
    }
    writeFileSync(file, source.replace(CORRECT, SABOTAGED.replace('\n', eol)), 'utf8');

    savedDir = process.env.BOT_MODULE_DIR;
    dirWasSet = 'BOT_MODULE_DIR' in process.env;
    process.env.BOT_MODULE_DIR = dest;
  },
  command,

  expectOutputContains: 'ФЛУД-ВЫЧЕРПЫВАЕТ-KV',
  greenRun: { command } satisfies GreenRun,
  teardown() {
    if (dirWasSet && savedDir !== undefined) process.env.BOT_MODULE_DIR = savedDir;
    else delete process.env.BOT_MODULE_DIR;
    savedDir = undefined;
    dirWasSet = false;
    rmSync(path.join(tmpDir, id), { recursive: true, force: true });
  },
};

export const cases: SabotageCase[] = [floodMarksEveryUpdate];
