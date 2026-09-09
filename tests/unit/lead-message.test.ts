
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

globalThis.fetch = (() => {
  throw new Error('СЕТЬ ЗАПРЕЩЕНА: сборка сообщения обратилась к fetch');
}) as typeof fetch;

const defaultDir = fileURLToPath(new URL('../../src/server/lead/', import.meta.url));
const serverDir = process.env.LEAD_SERVER_DIR ?? defaultDir;
const modulePath = path.join(serverDir, 'message.ts');

const { escapeHtml, buildLeadMessage, renderedLength, TELEGRAM_TEXT_MAX } = (await import(
  pathToFileURL(modulePath).href
)) as typeof import('../../src/server/lead/message.ts');

const lead = {
  name: 'Ганбаатар',
  contact: '+976 9911 2233',
  channel: 'phone',
  direction: 'affiliate',
  lang: 'mn',
} as const;

const attr = {
  source: 'facebook',
  campaign: 'august-3',
  medium: 'cpc',
  lastSource: '',
  touches: 2,
};

function build(overrides: Record<string, unknown> = {}): string {
  return buildLeadMessage({
    lead,
    attr,
    host: 'landingmn.pages.dev',
    at: '2026-08-20T11:46:50.000Z',
    ...overrides,
  });
}

test('ЭКРАНИРОВАНИЕ: & заменяется ПЕРВЫМ — иначе менеджер читает &amp;lt; вместо имени', () => {
  const raw = 'Ө<&>Ү"\'';
  const escaped = escapeHtml(raw);

  assert.equal(
    escaped,
    'Ө&lt;&amp;&gt;Ү"\'',
    'ЭКРАНИРОВАНИЕ-НЕ-ПЕРВЫМ: & заменён не первым, менеджер прочитает &amp;lt; вместо имени',
  );
  assert.equal(escaped.includes('&amp;lt;'), false, 'двойное экранирование: & заменён не первым');
  assert.equal(escaped.includes('&amp;gt;'), false, 'двойное экранирование: & заменён не первым');
  assert.equal(escaped.split('&amp;').length - 1, 1, 'амперсанд обязан быть экранирован ровно один раз');
});

test('ЭКРАНИРОВАНИЕ: одиночный проход по уже экранированному тексту — ровно один уровень', () => {
  assert.equal(escapeHtml('&lt;b&gt;'), '&amp;lt;b&amp;gt;');
  assert.equal(escapeHtml('&'), '&amp;');
  assert.equal(escapeHtml('<b>жирный</b>'), '&lt;b&gt;жирный&lt;/b&gt;');
});

test('ЭКРАНИРОВАНИЕ: кавычки в ТЕКСТЕ не трогаем — Telegram их не разбирает', () => {

  assert.equal(escapeHtml('О\'Брайен "Ганбаатар"'), 'О\'Брайен "Ганбаатар"');
});

test('монгольская кириллица и знак тугрика проходят экранирование без изменений', () => {
  for (const value of ['Ө', 'ө', 'Ү', 'ү', '₮', 'Өнөөдөр 50000₮ Үнэгүй']) {
    assert.equal(escapeHtml(value), value, `символ ${value} испорчен экранированием`);
  }
});

test('пустая строка и строка без спецсимволов возвращаются как есть', () => {
  assert.equal(escapeHtml(''), '');
  assert.equal(escapeHtml('Ганбаатар'), 'Ганбаатар');
});

test('сообщение несёт имя, контакт с каналом, направление, локаль, источник, домен и время', () => {
  const message = build();
  for (const fragment of [
    'Ганбаатар',
    '+976 9911 2233',
    'Affiliate',
    'mn',
    'facebook',
    'august-3',
    'landingmn.pages.dev',

    '20.08.2026, 19:46 (Улан-Батор, GMT+8)',
  ]) {
    assert.equal(message.includes(fragment), true, `в сообщении нет «${fragment}»`);
  }

  assert.match(message, /Телефон/);
});

test('монгольское имя со спецсимволами доезжает символами, а не разметкой', () => {
  const message = build({ lead: { ...lead, name: 'Ө<&>Ү"\'' } });
  assert.equal(message.includes('Ө&lt;&amp;&gt;Ү"\''), true, 'имя экранировано неправильно');
  assert.equal(message.includes('&amp;lt;'), false, 'имя экранировано дважды');
});

test('контакт экранируется тоже — ссылка на профиль приезжает свободным текстом', () => {
  const message = build({
    lead: { ...lead, channel: 'messenger', contact: 'fb.com/a?x=1&y=2<script>' },
  });
  assert.equal(message.includes('x=1&amp;y=2&lt;script&gt;'), true);
  assert.equal(message.includes('<script>'), false, 'разметка отправителя уехала в чат неэкранированной');
});

const AT_UTC = '2026-08-20T14:57:01.429Z';

const AT_UB = '20.08.2026, 22:57 (Улан-Батор, GMT+8)';

function timeLine(message: string): string {
  const match = message.match(/<b>Время:<\/b> ([^\n]*)/);
  assert.ok(match, 'в сообщении нет строки «Время»');
  return match[1];
}

test('ВРЕМЯ: ISO-строка печатается местным временем Улан-Батора, а не UTC', () => {

  assert.equal(
    timeLine(build({ at: AT_UTC })),
    AT_UB,
    'ВРЕМЯ-НЕ-МЕСТНОЕ: поле печатает не местное время Улан-Батора',
  );
});

test('ВРЕМЯ: объект Date и та же ISO-строка сходятся в одну строку', () => {
  assert.equal(timeLine(build({ at: new Date(AT_UTC) })), AT_UB);
  assert.equal(timeLine(build({ at: new Date(AT_UTC) })), timeLine(build({ at: AT_UTC })));
});

test('ВРЕМЯ: ни миллисекунд, ни ISO-разделителя T, ни хвоста Z — это чат, а не журнал', () => {
  const line = timeLine(build({ at: AT_UTC }));
  assert.equal(line.includes(AT_UTC), false, 'сырой ISO уехал в чат целиком');
  assert.equal(line.includes('.429'), false, 'миллисекунды доехали до чата');

  assert.doesNotMatch(line, /\d{2}T\d{2}/, 'ISO-разделитель T остался в строке времени');
  assert.doesNotMatch(line, /\d{2}Z/, 'хвост Z остался в строке времени');
  assert.equal(line.includes('14:57'), false, 'напечатано UTC вместо местного времени');
});

test('ВРЕМЯ: пояс назван в самой строке — без него значение не отличить от UTC', () => {
  const line = timeLine(build({ at: AT_UTC }));
  assert.match(line, /Улан-Батор/);
  assert.match(line, /(GMT|UTC)[+\u2212-]\d/, 'рядом со временем нет смещения');
});

test('ВРЕМЯ: смещение в подписи взято ИЗ ТОГО ЖЕ преобразования, что и часы', () => {

  assert.equal(timeLine(build({ at: '2016-08-20T14:57:00.000Z' })), '20.08.2016, 23:57 (Улан-Батор, GMT+9)');
});

test('ВРЕМЯ: полночь по Улан-Батору переваливает дату, а не печатает 24:00', () => {
  assert.equal(timeLine(build({ at: '2026-08-20T16:00:00.000Z' })), '21.08.2026, 00:00 (Улан-Батор, GMT+8)');
  assert.equal(timeLine(build({ at: '2026-08-20T15:59:00.000Z' })), '20.08.2026, 23:59 (Улан-Батор, GMT+8)');
});

test('ВРЕМЯ: негодный вход не роняет сборку — поле печатает исходное, остальные поля целы', () => {
  const message = build({ at: 'не дата' });
  assert.equal(timeLine(message), 'не дата');
  for (const anchor of ['Ганбаатар', '+976 9911 2233', 'Affiliate', 'landingmn.pages.dev']) {
    assert.equal(message.includes(anchor), true, `негодное время съело поле «${anchor}»`);
  }

  assert.doesNotThrow(() => build({ at: new Date('не дата') }));
  assert.match(build({ at: new Date('не дата') }), /Ганбаатар/);
});

test('ВРЕМЯ переживает усечение: режутся свободные поля, а не отметка времени', () => {
  const message = build({
    at: AT_UTC,
    lead: { ...lead, name: 'Ө'.repeat(5000) },
    attr: { source: 'S'.repeat(5000), campaign: '', medium: '', lastSource: '', touches: 1 },
  });
  assert.equal(timeLine(message), AT_UB, 'усечение обрезало время');
  assert.equal(renderedLength(message) <= TELEGRAM_TEXT_MAX, true);
});

test('значения сводки атрибуции экранируются безусловно — клиентская санитизация работает в браузере', () => {
  const message = build({
    attr: {
      source: '</b><img src=x onerror=alert(1)>',
      campaign: 'лето & осень',
      medium: '',
      lastSource: '<b>ldr</b>',
      touches: 3,
    },
  });
  assert.equal(message.includes('<img'), false, 'разметка из localStorage уехала в чат');
  assert.equal(message.includes('&lt;img src=x onerror=alert(1)&gt;'), true);
  assert.equal(message.includes('лето &amp; осень'), true);
  assert.equal(message.includes('&amp;lt;'), false);
});

test('сводка читается ПО ИМЕНАМ полей — лишние ключи в чат не попадают', () => {
  const hostile: unknown = JSON.parse(
    '{"source":"fb","campaign":"","medium":"","lastSource":"","touches":1,"secret":"НЕ-ДОЛЖНО-БЫТЬ","__proto__":{"polluted":true}}',
  );
  const message = build({ attr: hostile });
  assert.equal(message.includes('НЕ-ДОЛЖНО-БЫТЬ'), false, 'в сообщение попал ключ, которого нет в сводке');
  assert.equal(({} as Record<string, unknown>).polluted, undefined, 'прототип объекта загрязнён');
});

test('отсутствующая и мусорная сводка не роняют сборку — источник становится direct', () => {
  for (const hostile of [undefined, null, 'строка', 42, []]) {
    const message = build({ attr: hostile });
    assert.match(message, /direct/, `сводка ${JSON.stringify(hostile)} обязана давать direct`);
  }
});

test('пустые поля сводки не порождают пустых строк в сообщении', () => {
  const message = build({ attr: { source: 'fb', campaign: '', medium: '', lastSource: '', touches: 0 } });
  assert.equal(message.includes('Кампания'), false, 'пустая кампания напечатана строкой-пустышкой');
  assert.match(message, /fb/);
});

test('длина считается ПОСЛЕ разбора сущностей: теги не считаются, &amp; равен одному символу', () => {
  assert.equal(renderedLength('<b>abc</b>'), 3);
  assert.equal(renderedLength('&amp;'), 1);
  assert.equal(renderedLength('&lt;&gt;&quot;'), 3);

  assert.equal(renderedLength('&amp;lt;'), 4);
});

test('сообщение длиннее 4096 после разбора сущностей не возвращается никогда', () => {
  const message = build({
    lead: { ...lead, name: 'Ө'.repeat(3000), contact: '9'.repeat(3000) },
    attr: { source: 'S'.repeat(3000), campaign: 'C'.repeat(3000), medium: 'M'.repeat(3000), lastSource: 'L'.repeat(3000), touches: 9 },
    host: 'h'.repeat(3000),
  });
  assert.equal(
    renderedLength(message) <= TELEGRAM_TEXT_MAX,
    true,
    `сообщение ${renderedLength(message)} символов при потолке ${TELEGRAM_TEXT_MAX}`,
  );
});

test('усечение режет свободные поля, а СТРУКТУРА остаётся целой', () => {
  const message = build({
    lead: { ...lead, name: 'Ө'.repeat(5000) },
    attr: { source: 'S'.repeat(5000), campaign: '', medium: '', lastSource: '', touches: 1 },
  });

  for (const anchor of ['Имя', 'Контакт', 'Направление', 'Домен', 'Время', '+976 9911 2233', '20.08.2026, 19:46 (Улан-Батор, GMT+8)']) {
    assert.equal(message.includes(anchor), true, `усечение съело структуру: нет «${anchor}»`);
  }
  assert.equal(renderedLength(message) <= TELEGRAM_TEXT_MAX, true);
});

test('первыми урезаются метки атрибуции, а имя и контакт — последними', () => {
  const message = build({
    lead: { ...lead, name: 'Ганбаатар' },
    attr: { source: 'S'.repeat(6000), campaign: 'C'.repeat(6000), medium: '', lastSource: '', touches: 1 },
  });
  assert.equal(message.includes('Ганбаатар'), true, 'имя урезано раньше меток');
  assert.equal(message.includes('+976 9911 2233'), true, 'контакт урезан раньше меток');
  assert.equal(renderedLength(message) <= TELEGRAM_TEXT_MAX, true);
});

test('нормальная заявка в потолок укладывается с огромным запасом', () => {
  assert.equal(renderedLength(build()) < 600, true);
});

test('признак «антиспам не проверен» добавляет видимую строку-пометку', () => {
  const marked = build({ captchaUnverified: true });
  assert.match(marked, /антиспам/i);
});

test('без признака пометки нет — иначе она перестанет читаться как исключение', () => {
  assert.equal(/антиспам/i.test(build()), false);
  assert.equal(/антиспам/i.test(build({ captchaUnverified: false })), false);
});

test('пометка переживает усечение — иначе однажды все лиды пойдут непроверенными молча', () => {
  const message = build({
    captchaUnverified: true,
    lead: { ...lead, name: 'Ө'.repeat(5000) },
    attr: { source: 'S'.repeat(5000), campaign: '', medium: '', lastSource: '', touches: 1 },
  });
  assert.match(message, /антиспам/i);
  assert.equal(renderedLength(message) <= TELEGRAM_TEXT_MAX, true);
});

test('модуль не обращается ни к сети, ни к среде — проверяется по исходнику', () => {
  const source = readFileSync(modulePath, 'utf8');

  const code = source.replace(/^\s*(\/\/.*|\*.*|\/\*.*)$/gm, '');

  for (const forbidden of ['fetch(', 'process.env', 'document.', 'localStorage', 'globalThis.', 'Date.now(', 'new Date()']) {
    assert.equal(code.includes(forbidden), false, `модуль обращается к среде: ${forbidden}`);
  }
});
