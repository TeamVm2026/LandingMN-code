
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

const alwaysNew: SabotageCase = (() => {
  const id = 'bot-cooldown-always-new';
  const caseDir = path.join(tmpDir, id);
  const realModule = path.join(projectRoot, 'workers', 'bot', 'cooldown.ts');
  const suite = 'tests/unit/bot-cooldown.test.ts';

  const command = [
    '--experimental-strip-types',
    '--test',
    '--test-name-pattern',
    'ОКНО',
    suite,
  ];

  const correct =
    '  const withinWindow = previous !== null && now - previous.start < rules.windowSeconds * SECOND;';
  const sabotaged = '  const withinWindow = false;';

  let savedDir: string | undefined;
  let dirWasSet = false;

  return {
    id,
    gate: suite,
    describe:
      'окно охлаждения потеряло сравнение со временем первого обращения: каждое ' +
      'нажатие даёт вердикт new, и в чат менеджеров уходит полный дубль вместо ' +
      'короткой пометки повтора',
    setup() {
      const source = readFileSync(realModule, 'utf8');
      const occurrences = source.split(correct).length - 1;
      if (occurrences !== 1) {
        throw new Error(
          `в workers/bot/cooldown.ts ожидалось РОВНО ОДНО вхождение «${correct}», ` +
            `найдено ${occurrences}. Саботаж наводится на точный текст: если попадание в окно ` +
            'переписали (другое имя переменной, вынесенная функция, скользящее окно), случай ' +
            'обязан упасть здесь, а не молча прогнать неизменённый модуль.',
        );
      }

      rmSync(caseDir, { recursive: true, force: true });
      mkdirSync(caseDir, { recursive: true });
      writeFileSync(path.join(caseDir, 'cooldown.ts'), source.replace(correct, sabotaged), 'utf8');

      savedDir = process.env.BOT_MODULE_DIR;
      dirWasSet = 'BOT_MODULE_DIR' in process.env;
      process.env.BOT_MODULE_DIR = caseDir;
    },
    command,

    expectOutputContains: 'ПОВТОР-НЕ-ОПОЗНАН',

    greenRun: { command },
    teardown() {
      if (dirWasSet && savedDir !== undefined) process.env.BOT_MODULE_DIR = savedDir;
      else delete process.env.BOT_MODULE_DIR;
      savedDir = undefined;
      dirWasSet = false;
      rmSync(caseDir, { recursive: true, force: true });
    },
  };
})();

const ttlLiteral: SabotageCase = (() => {
  const id = 'bot-ttl-literal';
  const scanDir = path.join(tmpDir, `${id}-scan`);

  return {
    id,
    gate: 'check:lead-contract',
    describe:
      'журнал лидов бота передаёт expirationTtl числом (неделя) вместо импорта ' +
      'LEAD_TTL_SECONDS — обещание о сроке хранения расходится с кодом молча',
    setup() {
      rmSync(scanDir, { recursive: true, force: true });
      mkdirSync(path.join(scanDir, 'bot'), { recursive: true });

      writeFileSync(
        path.join(scanDir, 'bot', 'journal.ts'),
        [
          '// Журнал лидов из бота в KV — страховка от потерянного лида (BOT-01).',
          'const BOT_KEY_PREFIX = \'bot:\';',
          '',
          'export async function writeBotLead(kv: KVNamespace, id: string, body: string) {',
          '  // Лиды бота нужны неделю, дольше держать незачем.',
          '  await kv.put(BOT_KEY_PREFIX + id, body, { expirationTtl: 604800 });',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
    },
    get command() {
      return [
        '--experimental-strip-types',
        'scripts/check-lead-contract.ts',
        '--scan',
        argPath(scanDir),
      ];
    },

    expectOutputContains: 'expirationTtl числом вместо LEAD_TTL_SECONDS: «expirationTtl: 604800»',

    greenRun: {
      command: ['--experimental-strip-types', 'scripts/check-lead-contract.ts'],
    } satisfies GreenRun,
    teardown() {
      rmSync(scanDir, { recursive: true, force: true });
    },
  };
})();

export const cases: SabotageCase[] = [alwaysNew, ttlLiteral];
