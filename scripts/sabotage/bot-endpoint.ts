
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');
const realBotDir = path.join(projectRoot, 'workers', 'bot');

const id = 'bot-endpoint-secret-ignored';
const copyDir = path.join(tmpDir, id);
const copyConfig = path.join(copyDir, 'wrangler.jsonc');

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', 'scripts/check-bot-webhook.ts'],
  costly:
    'поднимает рантайм Workers на порту 8789 (пять запусков `wrangler dev`) и локальную заглушку Bot API — 9 с и занятый порт',
};

function copyBotDir(): string {
  rmSync(copyDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  cpSync(realBotDir, copyDir, {
    recursive: true,
    filter: (source) => {
      const name = path.basename(source);
      return name !== '.wrangler' && name !== '.dev.vars';
    },
  });
  return copyDir;
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

function assertConfigPointsIntoCopy(): void {
  const raw = readFileSync(copyConfig, 'utf8');

  const match = /"main"\s*:\s*"([^"]+)"/.exec(raw);
  if (match === null) {
    throw new Error(
      'в копии wrangler.jsonc не найдено поле "main" — проверить, во что она указывает, нечем.',
    );
  }
  const resolved = path.resolve(copyDir, match[1] as string);
  const inside = resolved === copyDir || resolved.startsWith(`${copyDir}${path.sep}`);
  if (!inside || !existsSync(resolved)) {
    throw new Error(
      `"main" копии («${match[1]}») резолвится в ${resolved}, что вне каталога копии или не существует. ` +
        'Случай прогнал бы НАСТОЯЩИЙ воркер и доказал бы ровно ничего.',
    );
  }
  const entry = readFileSync(resolved, 'utf8');
  if (!entry.includes("'./webhook.ts'")) {
    throw new Error(
      `вход копии (${path.basename(resolved)}) больше не импортирует './webhook.ts' — ` +
        'саботаж наведён на файл, который в сборку не попадает.',
    );
  }
}

const secretIgnored: SabotageCase = {
  id,
  gate: 'check:bot-webhook',
  describe:
    'сверка X-Telegram-Bot-Api-Secret-Token выключена в СОБРАННОМ бандле воркера: ' +
    'настоящий рантайм принимает апдейт без заголовка и заводит лида в чат менеджеров',
  setup() {
    copyBotDir();
    replaceOnce(
      path.join(copyDir, 'webhook.ts'),
      "  if (configuredSecret === '' || !timingSafeEqualStr(presentedSecret, configuredSecret)) {",
      '  if (false) {',
      'сверку секрета вебхука',
    );
    assertConfigPointsIntoCopy();
  },
  command: [
    '--experimental-strip-types',
    'scripts/check-bot-webhook.ts',
    '--config',
    `.sabotage-tmp/${id}/wrangler.jsonc`,
  ],
  expectOutputContains: 'ВЕБХУК ПРИНЯЛ ЧУЖОЙ СЕКРЕТ',
  greenRun: GREEN,
  teardown() {
    rmSync(copyDir, { recursive: true, force: true });
  },
};

export const cases: SabotageCase[] = [secretIgnored];
