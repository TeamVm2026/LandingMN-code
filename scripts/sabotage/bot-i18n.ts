
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const botI18nDir = path.join(projectRoot, 'workers', 'bot', 'i18n');
const caseDir = path.join(projectRoot, '.sabotage-tmp', 'bot-i18n');

const LOCALE_NAMES = ['mn', 'ru', 'en'] as const;

const LOST_KEY = 'reply.manager_button';

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).split(path.sep).join('/');
}

const GREEN: GreenRun = {
  command: [
    '--experimental-strip-types',
    'scripts/check-i18n-completeness.ts',
    '--dir',
    'workers/bot/i18n',
    '--set',
    'bot',
  ],
};

const requiredKeyLost: SabotageCase = {
  id: 'bot-i18n-required-key-lost',
  gate: 'check:i18n:bot',
  describe:
    'надпись кнопки передачи менеджеру (reply.manager_button) удалена из mn, ru и en ' +
    'одновременно — словари бота симметричны, проверка полноты слепа, а бот перестал ' +
    'отдавать человеку живого менеджера',
  setup() {
    rmSync(caseDir, { recursive: true, force: true });
    mkdirSync(caseDir, { recursive: true });
    for (const locale of LOCALE_NAMES) {
      const source = readFileSync(path.join(botI18nDir, `${locale}.json`), 'utf8');
      const dict = JSON.parse(source) as Record<string, unknown>;

      if (!(LOST_KEY in dict)) {
        throw new Error(
          `в workers/bot/i18n/${locale}.json нет ключа ${LOST_KEY} — удалять нечего. ` +
            'Ключ переименовали или потеряли: почините саботаж вместе с гейтом, ' +
            'а не вычёркивайте случай.',
        );
      }
      delete dict[LOST_KEY];
      writeFileSync(
        path.join(caseDir, `${locale}.json`),
        `${JSON.stringify(dict, null, 2)}\n`,
        'utf8',
      );
    }
  },
  command: [
    '--experimental-strip-types',
    'scripts/check-i18n-completeness.ts',
    '--dir',
    argPath(caseDir),
    '--set',
    'bot',
  ],

  expectOutputContains: `ОБЯЗАТЕЛЬНЫЙ КЛЮЧ ОТСУТСТВУЕТ — "${LOST_KEY}"`,
  greenRun: GREEN,
  teardown() {
    rmSync(caseDir, { recursive: true, force: true });
  },
};

export const cases: SabotageCase[] = [requiredKeyLost];
