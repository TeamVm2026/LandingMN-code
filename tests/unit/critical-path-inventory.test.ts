
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const SPEC_PATH = process.env.CRITICAL_PATH_SPEC
  ? path.resolve(process.env.CRITICAL_PATH_SPEC)
  : path.resolve(import.meta.dirname, '..', 'critical-path.spec.ts');

function source(): string {
  if (!existsSync(SPEC_PATH)) return '';
  return readFileSync(SPEC_PATH, 'utf8');
}

const SILENT_MARKS = [
  'test.skip(',
  'test.fixme(',
  'test.describe.skip(',
  'test.describe.fixme(',
  '.only(',
] as const;

const STAGES: ReadonlyArray<{ stage: string; hook: string }> = [
  { stage: 'смена языка', hook: 'hreflang="ru"' },

  { stage: 'открытие карточки направления', hook: 'data-track-direction="bank"' },
  { stage: 'мок-сабмит формы', hook: 'api/lead' },
  { stage: 'страница подтверждения', hook: '/thanks/' },
];

test('ПРИСУТСТВИЕ: сквозной тест критического пути лежит в дереве и непуст', () => {
  assert.ok(
    existsSync(SPEC_PATH),
    `КРИТИЧЕСКИЙ-ПУТЬ-ОТСУТСТВУЕТ: файла ${SPEC_PATH} нет. ` +
      'Сквозной тест критерия 1 Фазы 8 удалён или переименован — путь ' +
      '«смена языка → карточка → мок-сабмит → подтверждение» больше не проверяется никем.',
  );
  const text = source();
  assert.ok(
    text.trim().length > 0,
    `КРИТИЧЕСКИЙ-ПУТЬ-ОТСУТСТВУЕТ: файл ${SPEC_PATH} пуст.`,
  );

  assert.ok(
    SPEC_PATH.endsWith('.spec.ts'),
    `КРИТИЧЕСКИЙ-ПУТЬ-ОТСУТСТВУЕТ: ${SPEC_PATH} не оканчивается на .spec.ts, ` +
      'то есть в набор Playwright (testMatch: *.spec.ts) он не попадает.',
  );
});

test('ПРОПУСК: критический путь не выключен пометкой и не сужен до одного теста', () => {
  const text = source();
  assert.ok(text.length > 0, 'КРИТИЧЕСКИЙ-ПУТЬ-ОТСУТСТВУЕТ: читать нечего');

  const found = SILENT_MARKS.filter((mark) => text.includes(mark));
  assert.deepEqual(
    found,
    [],
    `КРИТИЧЕСКИЙ-ПУТЬ-ВЫКЛЮЧЕН: в ${SPEC_PATH} найдены пометки ${JSON.stringify(found)}. ` +
      'Помеченный так тест исчезает из отчёта Playwright, НЕ окрашивая его в красный, — ' +
      'то есть остаётся запись об успехе там, где путь до заявки никто не прошёл. ' +
      'Убрать пометку или чинить сам путь; выключать критический тест нельзя.',
  );
});

test('СТАДИИ: все четыре стадии критерия 1 присутствуют настоящими зацепками', () => {
  const text = source();
  assert.ok(text.length > 0, 'КРИТИЧЕСКИЙ-ПУТЬ-ОТСУТСТВУЕТ: читать нечего');

  const missing = STAGES.filter(({ hook }) => !text.includes(hook));
  assert.deepEqual(
    missing.map((m) => m.stage),
    [],
    `КРИТИЧЕСКИЙ-ПУТЬ-НЕПОЛОН: в ${SPEC_PATH} не осталось зацепок для стадий ` +
      `${JSON.stringify(missing.map((m) => `${m.stage} (${m.hook})`))}. ` +
      'Критерий 1 Фазы 8 называет путь целиком; спека без одной стадии — ' +
      'это снова набор узловых тестов, а не сквозной.',
  );
});

test('ВЕТВИ: путь БЕЗ JS объявлен отдельной ветвью, а не подразумевается', () => {
  const text = source();
  assert.ok(text.length > 0, 'КРИТИЧЕСКИЙ-ПУТЬ-ОТСУТСТВУЕТ: читать нечего');

  assert.ok(
    text.includes('javaScriptEnabled: false'),
    `КРИТИЧЕСКИЙ-ПУТЬ-ОДНОВЕТВЕВОЙ: в ${SPEC_PATH} нет ветви с javaScriptEnabled: false. ` +
      'Путь без JS — не теоретический: сервер отдаёт на него 303 на /thanks/, и ' +
      'именно эта ветвь ловит 404 у человека, чья заявка уже принята и доставлена менеджеру.',
  );
});
