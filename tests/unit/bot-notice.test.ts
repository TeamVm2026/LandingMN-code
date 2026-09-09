
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { StartPayload } from '../../src/lib/start-codec.ts';
import {
  escapeHtml,
  formatReceivedAt,
  renderedLength,
  TELEGRAM_TEXT_MAX,
} from '../../src/server/lead/message.ts';
import { buildBotLeadNotice, buildRepeatNotice } from '../../workers/bot/notice.ts';

globalThis.fetch = (() => {
  throw new Error('СЕТЬ ЗАПРЕЩЕНА: сборка сообщения менеджеру обратилась к fetch');
}) as typeof fetch;

const low = (value: string): string => value.toLowerCase();

const AT = '2026-08-22T14:57:01.429Z';
const FIRST_AT = '2026-08-22T13:10:00.000Z';

const user = {
  id: 8_123_456_789,
  firstName: 'Ганбаатар',
  lastName: 'Доржийн',
  username: 'ganbaatar',
  languageCode: 'mn',
};

const payload: StartPayload = {
  source: 'fb',
  direction: 'affiliate',
  locale: 'mn',
  campaign: 'august3',
  click: 'zx91',
};

function notice(over: Partial<Parameters<typeof buildBotLeadNotice>[0]> = {}): string {
  return buildBotLeadNotice({
    user,
    payload,
    raw: '1_fb_a_m_august3_zx91',
    at: AT,
    contactDelivered: true,
    ...over,
  });
}

function repeat(over: Partial<Parameters<typeof buildRepeatNotice>[0]> = {}): string {
  return buildRepeatNotice({
    user,
    firstAt: FIRST_AT,
    n: 2,
    payload: null,
    raw: '',
    contactDelivered: true,
    ...over,
  });
}

test('ЛИД: несёт направление, источник, кампанию, клик, язык, имя, username, ссылку и время', () => {
  const text = notice();

  assert.ok(text.includes('Affiliate'), 'нет направления брендовым именем');
  assert.ok(text.includes('fb'), 'нет источника');
  assert.ok(text.includes('august3'), 'нет кампании');
  assert.ok(text.includes('zx91'), 'нет хвоста клика');
  assert.ok(text.includes('mn'), 'нет локали');
  assert.ok(text.includes('Ганбаатар'), 'нет имени');
  assert.ok(text.includes('@ganbaatar'), 'нет username');
  assert.ok(text.includes(`tg://user?id=${user.id}`), 'нет ссылки на переписку');
  assert.ok(text.includes(formatReceivedAt(AT)), 'время не то, что печатает заявка с формы');
});

test('ЛИД: заголовок ОТЛИЧАЕТСЯ от заголовка заявки с формы', () => {
  const text = notice();
  assert.ok(
    !text.includes('Заявка с лендинга'),
    'заголовок совпал с формой — менеджер не отличит лид из бота от заявки с телефоном',
  );
  assert.ok(text.split('\n')[0]?.includes('бот'), 'в заголовке не сказано, что лид из бота');
});

test('ЭКРАНИРОВАНИЕ: имя проходит через общий escapeHtml, а не через вторую реализацию', () => {
  const hostile = 'Ө<&>Ү';
  const text = notice({ user: { ...user, firstName: hostile, lastName: '' } });

  assert.ok(
    text.includes(escapeHtml(hostile)),
    'ЭКРАНИРОВАНИЕ-НЕ-ОБЩЕЕ: имя экранировано не тем же escapeHtml, что у заявки с формы',
  );
  assert.ok(
    !text.includes('&amp;lt;'),
    'ЭКРАНИРОВАНИЕ-НЕ-ОБЩЕЕ: двойное экранирование — & заменён не первым',
  );
});

test('ЭКРАНИРОВАНИЕ: модуль импортирует escapeHtml и formatReceivedAt, а не пишет свои', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../workers/bot/notice.ts', import.meta.url)),
    'utf8',
  );
  assert.match(
    source,
    /from\s+'\.\.\/\.\.\/src\/server\/lead\/message(?:\.ts)?'/,
    'ЭКРАНИРОВАНИЕ-НЕ-ОБЩЕЕ: нет импорта из src/server/lead/message.ts',
  );
  assert.ok(
    !/replace\(\/&\/g/.test(source),
    'ЭКРАНИРОВАНИЕ-НЕ-ОБЩЕЕ: в модуле есть собственная замена «&» — это вторая реализация',
  );
  assert.ok(
    !/Intl\.DateTimeFormat/.test(source),
    'ЭКРАНИРОВАНИЕ-НЕ-ОБЩЕЕ: модуль форматирует время сам — это вторая реализация',
  );
});

test('ПУСТЫЕ: посетитель без username не даёт строки с одиноким «@»', () => {
  const text = notice({ user: { ...user, username: '' } });
  assert.ok(!/@\s*$/m.test(text), 'осталась строка с пустым username');
  assert.ok(!text.includes('@'), 'символ @ в сообщении есть, хотя username пуст');
});

test('ПУСТЫЕ: пустая кампания и пустой клик строк не порождают вовсе', () => {
  const text = notice({ payload: { ...payload, campaign: '', click: '' } });
  assert.ok(!text.includes('Кампания'), 'подпись кампании осталась при пустом значении');
  assert.ok(!text.includes('Клик'), 'подпись клика осталась при пустом значении');
});

test('ПУСТЫЕ: пустой source печатается словом «прямой заход», а не пустотой и не «direct»', () => {
  const text = notice({ payload: { ...payload, source: '' } });
  assert.ok(text.includes('прямой заход'), 'пустой источник напечатан не словом');
  assert.ok(!/Источник:<\/b>\s*\n/.test(text), 'подпись «Источник» осталась без значения');
  assert.ok(!text.includes('direct'), 'напечатано «direct» — менеджер прочитает это как рекламную сеть');
});

test('ПУСТЫЕ: направление none печатается как «не выбрано»', () => {
  const text = notice({ payload: { ...payload, direction: 'none' } });
  assert.ok(text.includes('не выбрано'), 'направление none напечатано не словом');
  assert.ok(!text.includes('undefined'), 'в сообщении есть undefined');
  assert.ok(!/Направление:<\/b>\s*\n/.test(text), 'подпись направления осталась без значения');
});

test('МЕТКА: неразобранная метка печатается как есть и источник НЕ выдумывается', () => {
  const text = buildBotLeadNotice({ user, payload: null, raw: '9_zzz_q', at: AT, contactDelivered: true });
  assert.ok(low(text).includes('метка не разобрана'), 'нет пометки о неразобранной метке');
  assert.ok(text.includes('9_zzz_q'), 'сама метка не напечатана — искать нечего');
  assert.ok(!text.includes('прямой заход'), 'выдуман источник «прямой заход» вместо честного «неизвестно»');
  assert.ok(!text.includes('fb'), 'выдуман источник');
});

test('МЕТКА: пустая метка — это «пришёл сам», а не «не разобрана»', () => {
  const text = buildBotLeadNotice({ user, payload: null, raw: '', at: AT, contactDelivered: true });
  assert.ok(!low(text).includes('метка не разобрана'), 'пустая метка объявлена неразобранной');
  assert.ok(text.includes('прямой заход'), 'вход без метки не назван прямым заходом');
});

test('МЕТКА: враждебная метка экранируется общим escapeHtml', () => {
  const hostile = '<b>x</b>&';
  const text = buildBotLeadNotice({ user, payload: null, raw: hostile, at: AT, contactDelivered: true });
  assert.ok(
    text.includes(escapeHtml(hostile)),
    'ЭКРАНИРОВАНИЕ-НЕ-ОБЩЕЕ: метка не экранирована общим escapeHtml',
  );
});

test('ССЫЛКА: непригодный id не печатается ссылкой вовсе', () => {
  for (const id of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    const text = notice({ user: { ...user, id } });
    assert.ok(
      !text.includes('tg://user?id='),
      `ССЫЛКА-БИТАЯ: id ${String(id)} напечатан ссылкой, хотя переписку по нему не открыть`,
    );
    assert.ok(!text.includes('undefined'), `в сообщении есть undefined при id ${String(id)}`);
  }
});

test('ССЫЛКА: в href уходит только число — кавычки в значении атрибута невозможны', () => {
  const text = notice();
  const href = /href="tg:\/\/user\?id=([^"]*)"/.exec(text);
  assert.ok(href, 'ссылки нет вовсе');
  assert.match(href[1] ?? '', /^[0-9]+$/, 'в значении атрибута оказалось не число');
});

test('ПЕРЕПОЛНЕНИЕ: гигантские имя и метка укладываются в потолок Telegram', () => {
  const text = buildBotLeadNotice({
    user: { ...user, firstName: 'Ө'.repeat(9000), lastName: '<&>'.repeat(3000), username: 'u'.repeat(4000) },
    payload: null,
    raw: 'z'.repeat(9000),
    at: AT,
    contactDelivered: false,
  });

  assert.ok(
    renderedLength(text) <= TELEGRAM_TEXT_MAX,
    `ЛИД-ПЕРЕПОЛНЕН: ${renderedLength(text)} > ${TELEGRAM_TEXT_MAX} — Telegram ответит 400 и лид пропадёт`,
  );
  assert.ok(text.includes(`tg://user?id=${user.id}`), 'ЛИД-ПЕРЕПОЛНЕН: пожертвована ссылка на посетителя');
  assert.ok(text.includes(formatReceivedAt(AT)), 'ЛИД-ПЕРЕПОЛНЕН: пожертвовано время');
  assert.ok(text.includes('неизвестно'), 'ЛИД-ПЕРЕПОЛНЕН: пожертвовано направление');
});

test('ПЕРЕПОЛНЕНИЕ: гигантские значения метки укладываются в потолок и направление цело', () => {
  const text = buildBotLeadNotice({
    user: { ...user, firstName: 'и'.repeat(5000) },
    payload: { source: 's'.repeat(5000), direction: 'teamcash', locale: 'ru', campaign: 'c'.repeat(5000), click: 'k'.repeat(5000) },
    raw: 'r'.repeat(5000),
    at: AT,
    contactDelivered: true,
  });

  assert.ok(
    renderedLength(text) <= TELEGRAM_TEXT_MAX,
    `ЛИД-ПЕРЕПОЛНЕН: ${renderedLength(text)} > ${TELEGRAM_TEXT_MAX}`,
  );

  assert.ok(text.includes('Team Cash'), 'ЛИД-ПЕРЕПОЛНЕН: пожертвовано направление');
  assert.ok(text.includes(formatReceivedAt(AT)), 'ЛИД-ПЕРЕПОЛНЕН: пожертвовано время');
});

test('ПОВТОР: короче полного лида, несёт пометку, опознание, ссылку, время первого обращения и номер', () => {
  const text = repeat();

  assert.ok(
    text.length < notice().length,
    'ПОВТОР-НЕ-КОРОТКИЙ: пометка повтора не короче полного лида — это дубль, а не пометка',
  );
  assert.ok(low(text).includes('повторный лид'), 'нет слов «повторный лид»');
  assert.ok(text.includes('@ganbaatar'), 'нет опознания посетителя');
  assert.ok(text.includes(`tg://user?id=${user.id}`), 'нет ссылки на переписку');
  assert.ok(text.includes(formatReceivedAt(FIRST_AT)), 'нет времени ПЕРВОГО обращения');
  assert.ok(text.includes('2'), 'нет номера обращения');
});

test('ПОВТОР: без username опознаёт по имени и экранирует его общим escapeHtml', () => {
  const hostile = 'Ө<&>Ү';
  const text = repeat({ user: { ...user, username: '', firstName: hostile, lastName: '' }, n: 3 });
  assert.ok(text.includes(escapeHtml(hostile)), 'ЭКРАНИРОВАНИЕ-НЕ-ОБЩЕЕ: имя в пометке повтора');
  assert.ok(!text.includes('@'), 'осталась строка с пустым username');
});

test('ПОВТОР: укладывается в потолок Telegram при гигантском имени', () => {
  const text = repeat({ user: { ...user, username: 'u'.repeat(9000), firstName: 'и'.repeat(9000) } });
  assert.ok(
    renderedLength(text) <= TELEGRAM_TEXT_MAX,
    `ПОВТОР-ПЕРЕПОЛНЕН: ${renderedLength(text)} > ${TELEGRAM_TEXT_MAX}`,
  );
  assert.ok(text.includes(`tg://user?id=${user.id}`), 'ПОВТОР-ПЕРЕПОЛНЕН: пожертвована ссылка');
});

test('ПЕРЕДАЧА: недоставленный контакт объявлен в САМОМ сообщении менеджерам', () => {
  const text = notice({ contactDelivered: false });
  assert.ok(
    low(text).includes('не доставлен'),
    'ПЕРЕДАЧА-НЕ-ОБЪЯВЛЕНА: лид не говорит, что контакт до человека не доехал — ' +
      'менеджер будет ждать сообщения, которого не будет',
  );
  assert.ok(
    low(text).includes('напишите первым'),
    'ПЕРЕДАЧА-НЕ-ОБЪЯВЛЕНА: сказано о поломке, но не сказано, что делать',
  );
});

test('ПЕРЕДАЧА: доставленный контакт не добавляет НИ ОДНОЙ строки', () => {
  const text = notice({ contactDelivered: true });
  assert.ok(
    !low(text).includes('не доставлен'),
    'ПЕРЕДАЧА-ЛОЖНАЯ-ТРЕВОГА: пометка о недоставке напечатана при УСПЕШНОЙ передаче. ' +
      'Пометка под каждым лидом перестаёт читаться через день, и настоящая недоставка ' +
      'потеряется среди ложных',
  );
  assert.ok(
    !low(text).includes('напишите первым'),
    'ПЕРЕДАЧА-ЛОЖНАЯ-ТРЕВОГА: указание «напишите первым» при успешной передаче',
  );
});

test('ПЕРЕДАЧА: пометка стоит ПОД ЗАГОЛОВКОМ, а не в середине полей', () => {
  const lines = notice({ contactDelivered: false }).split('\n');
  assert.ok(
    low(lines[1] ?? '').includes('не доставлен'),
    'ПЕРЕДАЧА-НЕ-ОБЪЯВЛЕНА: пометка не второй строкой — менеджер прочитает её после ' +
      'того, как решит, что делать',
  );
});

test('ПЕРЕДАЧА: пометка переживает усечение гигантскими значениями', () => {
  const text = buildBotLeadNotice({
    user: { ...user, firstName: 'Ө'.repeat(9000), username: 'u'.repeat(4000) },
    payload: { source: 's'.repeat(5000), direction: 'bank', locale: 'ru', campaign: 'c'.repeat(5000), click: 'k'.repeat(5000) },
    raw: 'r'.repeat(9000),
    at: AT,
    contactDelivered: false,
  });
  assert.ok(renderedLength(text) <= TELEGRAM_TEXT_MAX, 'ЛИД-ПЕРЕПОЛНЕН: потолок Telegram пробит');
  assert.ok(
    low(text).includes('не доставлен'),
    'ПЕРЕДАЧА-НЕ-ОБЪЯВЛЕНА: бюджет усечения срезал пометку о недоставке — она обязана ' +
      'быть частью заголовка, а не свободным полем',
  );
});

test('ПЕРЕДАЧА: пометка повтора несёт тот же исход обеими сторонами', () => {
  assert.ok(
    low(repeat({ contactDelivered: false })).includes('не доставлен'),
    'ПЕРЕДАЧА-НЕ-ОБЪЯВЛЕНА: пометка повтора молчит о недоставленном контакте',
  );
  assert.ok(
    !low(repeat({ contactDelivered: true })).includes('не доставлен'),
    'ПЕРЕДАЧА-ЛОЖНАЯ-ТРЕВОГА: пометка повтора тревожит при успешной передаче',
  );
});

test('ПОВТОР: несёт направление ЭТОГО обращения — уточнение интереса видно менеджеру', () => {
  const text = repeat({ payload: { ...payload, direction: 'bank' }, raw: '1__b_m' });
  assert.ok(
    text.includes('Bank Transfer'),
    'ПОВТОР-БЕЗ-НАПРАВЛЕНИЯ: человек тапнул кнопку первого экрана без направления, потом ' +
      'карточку Bank Transfer — и менеджер об этом не узнал',
  );
});

test('ПОВТОР: три состояния метки называются ТАК ЖЕ, как в полном лиде', () => {
  const cases = [

    { over: { payload: { ...payload, direction: 'teamcash' as const }, raw: '1__t_m' }, expect: 'Team Cash' },
    { over: { payload: null, raw: '' }, expect: 'не выбрано' },
    { over: { payload: null, raw: '9_zzz_q' }, expect: 'неизвестно' },
  ];
  for (const c of cases) {
    const inRepeat = repeat(c.over);
    const inLead = notice(c.over);
    assert.ok(
      inRepeat.includes(c.expect),
      `ПОВТОР-БЕЗ-НАПРАВЛЕНИЯ: пометка не назвала направление «${c.expect}»`,
    );
    assert.ok(
      inLead.includes(c.expect),
      `НАПРАВЛЕНИЕ-РАЗОШЛОСЬ: полный лид назвал направление иначе, чем пометка повтора — ` + 'две таблицы соответствия разойдутся в день правки одной из них',
    );
  }
});

test('ПОВТОР: направление добавлено, но атрибуция НЕ продублирована (BOT-03)', () => {
  const text = repeat({ payload, raw: '1_fb_a_m_august3_zx91' });
  assert.ok(text.includes('Affiliate'), 'ПОВТОР-БЕЗ-НАПРАВЛЕНИЯ: направления нет');
  for (const dup of ['fb', 'august3', 'zx91', '1_fb_a_m_august3_zx91']) {
    assert.ok(
      !text.includes(dup),
      `ПОВТОР-СТАЛ-ДУБЛЕМ: в пометку уехало «${dup}» — источник, кампания, клик и сама ` +
        'метка уже напечатаны в первом сообщении окна и внутри сессии не меняются. ' +
        'Направление — единственное, что меняется по построению страницы',
    );
  }
  assert.ok(
    text.length < notice().length,
    `ПОВТОР-НЕ-КОРОТКИЙ: ${text.length} симв. против ${notice().length} у полного лида`,
  );
});
