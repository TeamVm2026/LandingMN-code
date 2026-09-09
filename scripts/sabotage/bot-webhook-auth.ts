
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');
const realBotDir = path.join(projectRoot, 'workers', 'bot');

function copyBotDir(id: string): string {
  const dest = path.join(tmpDir, id);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  cpSync(realBotDir, dest, { recursive: true });
  return dest;
}

function replaceOnce(file: string, correct: string, sabotaged: string, what: string): void {
  const source = readFileSync(file, 'utf8');
  const occurrences = source.split(correct).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `в ${path.relative(projectRoot, file).replace(/\\/g, '/')} ожидалось РОВНО ОДНО вхождение ` +
        `«${correct.trim()}», найдено ${occurrences}. Саботаж наводится на точный текст: если ${what} ` +
        'переписали, случай обязан упасть здесь, а не молча прогнать неизменённый код.',
    );
  }
  writeFileSync(file, source.replace(correct, sabotaged), 'utf8');
}

function moduleDirSwap() {
  let saved: string | undefined;
  let wasSet = false;
  return {
    set(dir: string): void {
      saved = process.env.BOT_MODULE_DIR;
      wasSet = 'BOT_MODULE_DIR' in process.env;

      process.env.BOT_MODULE_DIR = dir;
    },
    restore(): void {
      if (wasSet && saved !== undefined) process.env.BOT_MODULE_DIR = saved;
      else delete process.env.BOT_MODULE_DIR;
      saved = undefined;
      wasSet = false;
    },
  };
}

const webhookSecretIgnored: SabotageCase = (() => {
  const id = 'bot-webhook-secret-ignored';
  const suite = 'tests/unit/bot-webhook.test.ts';
  const swap = moduleDirSwap();

  const command = [
    '--experimental-strip-types',
    '--test',
    '--test-name-pattern',
    'СЕКРЕТ',
    suite,
  ];

  const correct =
    "  if (configuredSecret === '' || !timingSafeEqualStr(presentedSecret, configuredSecret)) {";
  const sabotaged = '  if (false) {';

  return {
    id,
    gate: suite,
    describe:
      'сверка X-Telegram-Bot-Api-Secret-Token выключена: публичный адрес вебхука ' +
      'принимает апдейт от кого угодно и заводит лида в чат менеджеров',
    setup() {
      const dir = copyBotDir(id);
      replaceOnce(path.join(dir, 'webhook.ts'), correct, sabotaged, 'сверку секрета вебхука');
      swap.set(dir);
    },
    command,

    expectOutputContains: 'ВЕБХУК-БЕЗ-СЕКРЕТА-ПРИНЯТ',

    greenRun: { command } satisfies GreenRun,
    teardown() {
      swap.restore();
      rmSync(path.join(tmpDir, id), { recursive: true, force: true });
    },
  };
})();

const adminSecretIgnored: SabotageCase = (() => {
  const id = 'bot-admin-secret-ignored';
  const suite = 'tests/unit/bot-admin.test.ts';
  const swap = moduleDirSwap();

  const command = [
    '--experimental-strip-types',
    '--test',
    '--test-name-pattern',
    'АДМИНКА',
    suite,
  ];

  const correct = '  if (!timingSafeEqualStr(presented, adminToken)) return empty(401);';
  const sabotaged = '  if (false && !timingSafeEqualStr(presented, adminToken)) return empty(401);';

  return {
    id,
    gate: suite,
    describe:
      'сверка X-Bot-Admin-Token выключена: перерегистрировать и УДАЛИТЬ вебхук ' +
      'может кто угодно, а выключённый бот не даёт ни ошибки, ни красного теста',
    setup() {
      const dir = copyBotDir(id);
      replaceOnce(path.join(dir, 'admin.ts'), correct, sabotaged, 'сверку админ-токена');
      swap.set(dir);
    },
    command,

    expectOutputContains: 'АДМИНКА-БЕЗ-ТОКЕНА-ПРИНЯЛА',
    greenRun: { command } satisfies GreenRun,
    teardown() {
      swap.restore();
      rmSync(path.join(tmpDir, id), { recursive: true, force: true });
    },
  };
})();

export const cases: SabotageCase[] = [webhookSecretIgnored, adminSecretIgnored];
