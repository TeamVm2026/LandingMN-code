
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PAYLOAD_MAX } from '../../src/lib/start-codec.ts';
import { parseUpdate } from '../../workers/bot/update.ts';

globalThis.fetch = (() => {
  throw new Error('СЕТЬ ЗАПРЕЩЕНА: разбор апдейта обратился к fetch');
}) as typeof fetch;

const HUMAN = {
  id: 555_000_111,
  is_bot: false,
  first_name: 'Ганбаатар',
  last_name: 'Дорж',
  username: 'ganbaatar',
  language_code: 'mn',
};

interface UpdateParts {

  chatType?: string | null;

  chatId?: number | null;

  text?: string | null;

  from?: unknown;

  updateId?: number | null;

  replyToBot?: boolean;
}

function makeUpdate(parts: UpdateParts = {}): unknown {
  const chat: Record<string, unknown> = {};
  if (parts.chatId !== null) chat.id = parts.chatId ?? HUMAN.id;
  if (parts.chatType !== null) chat.type = parts.chatType ?? 'private';

  const message: Record<string, unknown> = { message_id: 42, date: 1_787_000_000, chat };
  if (parts.from !== null) message.from = parts.from ?? HUMAN;
  if (parts.text !== null) message.text = parts.text ?? '/start 1_fb_a_m';
  if (parts.replyToBot) {
    message.reply_to_message = {
      message_id: 41,
      from: { id: 8_723_967_988, is_bot: true, username: 'melbet_mn_bot' },
      text: 'Заявка с лендинга',
    };
  }

  const update: Record<string, unknown> = { message };
  if (parts.updateId !== null) update.update_id = parts.updateId ?? 1001;
  return update;
}

test('РАЗБОР: /start с меткой в личном чате разбирается настоящим кодеком', () => {
  const result = parseUpdate(makeUpdate());
  assert.equal(result.kind, 'start');
  if (result.kind !== 'start') return;

  assert.deepEqual(result.payload, {
    source: 'fb',
    direction: 'affiliate',
    locale: 'mn',
    campaign: '',
    click: '',
  });
  assert.equal(result.raw, '1_fb_a_m');
  assert.equal(result.chatType, 'private');
  assert.equal(result.chatId, HUMAN.id);
  assert.equal(result.updateId, 1001);
  assert.equal(result.user.id, HUMAN.id);
  assert.equal(result.user.firstName, 'Ганбаатар');
  assert.equal(result.user.lastName, 'Дорж');
  assert.equal(result.user.username, 'ganbaatar');
  assert.equal(result.user.languageCode, 'mn');
});

test('РАЗБОР: метка сайта без выбранного направления даёт none и пустой источник', () => {
  const result = parseUpdate(makeUpdate({ text: '/start 1__x_m' }));
  assert.equal(result.kind, 'start');
  if (result.kind !== 'start') return;
  assert.equal(result.payload?.direction, 'none');
  assert.equal(result.payload?.source, '');
  assert.equal(result.payload?.locale, 'mn');
});

test('РАЗБОР: полная метка с кампанией и хвостом клика разбирается целиком', () => {
  const result = parseUpdate(makeUpdate({ text: '/start 1_fb_t_r_aug-promo_7f3a91b2e0' }));
  assert.equal(result.kind, 'start');
  if (result.kind !== 'start') return;
  assert.deepEqual(result.payload, {
    source: 'fb',
    direction: 'teamcash',
    locale: 'ru',
    campaign: 'aug-promo',
    click: '7f3a91b2e0',
  });
});

test('РАЗБОР: /start без аргумента — это start с payload null, а не ошибка', () => {
  const result = parseUpdate(makeUpdate({ text: '/start' }));
  assert.equal(result.kind, 'start');
  if (result.kind !== 'start') return;
  assert.equal(result.payload, null);
  assert.equal(result.raw, '');
});

test('РАЗБОР: мусор и 200-символьный хвост дают payload null и raw в пределах PAYLOAD_MAX', () => {
  const garbage = parseUpdate(makeUpdate({ text: '/start мусор' }));
  assert.equal(garbage.kind, 'start');
  if (garbage.kind !== 'start') return;
  assert.equal(garbage.payload, null);

  assert.equal(garbage.raw, 'мусор');

  const long = 'a'.repeat(200);
  const huge = parseUpdate(makeUpdate({ text: `/start ${long}` }));
  assert.equal(huge.kind, 'start');
  if (huge.kind !== 'start') return;
  assert.equal(huge.payload, null);
  assert.equal(huge.raw.length, PAYLOAD_MAX);
  assert.equal(huge.raw, long.slice(0, PAYLOAD_MAX));
});

test('РАЗБОР: /start@melbet_mn_bot в ЛИЧНОМ чате разбирается штатно', () => {
  const result = parseUpdate(makeUpdate({ text: '/start@melbet_mn_bot 1_fb_a_m' }));
  assert.equal(result.kind, 'start');
  if (result.kind !== 'start') return;
  assert.equal(result.payload?.source, 'fb');
  assert.equal(result.raw, '1_fb_a_m');
});

test('РАЗБОР: текст не с /start даёт other, и /started командой не считается', () => {
  for (const text of ['привет', '/help', '/started 1_fb_a_m', 'start 1_fb_a_m']) {
    const result = parseUpdate(makeUpdate({ text }));
    assert.equal(result.kind, 'other', `«${text}» ожидался как other, получено ${result.kind}`);
    assert.equal(result.chatType, 'private');
    assert.equal(result.chatId, HUMAN.id);
  }
});

test('ГРУППА: метка из group, supergroup и channel даёт ignore/group с ЗАПОЛНЕННЫМИ полями чата', () => {
  for (const chatType of ['group', 'supergroup', 'channel']) {
    const result = parseUpdate(makeUpdate({ chatType, chatId: -100_123_456 }));
    assert.equal(
      result.kind,
      'ignore',
      `ФИЛЬТР-ЧАТА-ПРОБИТ: ${chatType} разобран как ${result.kind}`,
    );
    if (result.kind !== 'ignore') continue;
    assert.equal(result.reason, 'group');
    assert.equal(result.chatId, -100_123_456, 'ЧАТ-ПОТЕРЯН: chatId пуст в ветке ignore');
    assert.equal(result.chatType, chatType, 'ЧАТ-ПОТЕРЯН: chatType пуст в ветке ignore');
    assert.equal(result.updateId, 1001);
  }
});

test('ГРУППА: /start@melbet_mn_bot из группы отсекается', () => {
  const result = parseUpdate(
    makeUpdate({ chatType: 'supergroup', chatId: -100_777, text: '/start@melbet_mn_bot 1_fb_a_m' }),
  );
  assert.equal(result.kind, 'ignore', 'ФИЛЬТР-ЧАТА-ПРОБИТ: лид ПРО МЕНЕДЖЕРА завёлся бы из группы');
  if (result.kind !== 'ignore') return;
  assert.equal(result.reason, 'group');
  assert.equal(result.chatId, -100_777);
  assert.equal(result.chatType, 'supergroup');
});

test('ГРУППА: ответ менеджера на сообщение бота даёт ignore/group, а НЕ other', () => {
  const result = parseUpdate(
    makeUpdate({
      chatType: 'supergroup',
      chatId: -100_777,
      text: 'этот лид уже вели, беру себе',
      replyToBot: true,
    }),
  );
  assert.equal(
    result.kind,
    'ignore',
    'ФИЛЬТР-ЧАТА-ПРОБИТ: бот ответил бы менеджеру в его же рабочем чате',
  );
  if (result.kind !== 'ignore') return;
  assert.equal(result.reason, 'group');
  assert.equal(result.chatType, 'supergroup');
  assert.equal(result.chatId, -100_777);
});

test('ГРУППА: отсутствующий и неизвестный chat.type трактуются как НЕ личный', () => {
  const missing = parseUpdate(makeUpdate({ chatType: null }));
  assert.equal(missing.kind, 'ignore', 'ФИЛЬТР-ЧАТА-ПРОБИТ: чат без типа принят за личный');
  if (missing.kind === 'ignore') {
    assert.equal(missing.reason, 'group');
    assert.equal(missing.chatId, HUMAN.id, 'ЧАТ-ПОТЕРЯН: chatId пуст, хотя чат в апдейте есть');
  }

  const unknown = parseUpdate(makeUpdate({ chatType: 'sender' }));
  assert.equal(unknown.kind, 'ignore', 'ФИЛЬТР-ЧАТА-ПРОБИТ: неизвестный тип принят за личный');
  if (unknown.kind === 'ignore') {
    assert.equal(unknown.reason, 'group');
    assert.equal(unknown.chatType, 'sender');
  }
});

test('ГРУППА: отсечение идёт ДО разбора текста — никакой payload из группы не возвращается', () => {
  const result = parseUpdate(makeUpdate({ chatType: 'group', chatId: -1 }));
  assert.equal(result.kind, 'ignore');
  assert.equal('payload' in result, false, 'ФИЛЬТР-ЧАТА-ПРОБИТ: метка из группы всё же разобрана');
});

test('ИСХОДЫ: апдейт без message даёт no-message — ЕДИНСТВЕННЫЙ случай пустых полей чата', () => {
  const result = parseUpdate({ update_id: 77 });
  assert.equal(result.kind, 'ignore');
  if (result.kind !== 'ignore') return;
  assert.equal(result.reason, 'no-message');
  assert.equal(result.chatId, null);
  assert.equal(result.chatType, '');
  assert.equal(result.updateId, 77);
});

test('ИСХОДЫ: без text, без from и от бота — свои reason с ЗАПОЛНЕННЫМИ полями чата', () => {
  const noText = parseUpdate(makeUpdate({ text: null }));
  assert.equal(noText.kind, 'ignore');
  if (noText.kind === 'ignore') {
    assert.equal(noText.reason, 'no-text');
    assert.equal(noText.chatId, HUMAN.id, 'ЧАТ-ПОТЕРЯН: no-text без chatId');
    assert.equal(noText.chatType, 'private', 'ЧАТ-ПОТЕРЯН: no-text без chatType');
  }

  const noFrom = parseUpdate(makeUpdate({ from: null }));
  assert.equal(noFrom.kind, 'ignore');
  if (noFrom.kind === 'ignore') {
    assert.equal(noFrom.reason, 'no-from');
    assert.equal(noFrom.chatId, HUMAN.id, 'ЧАТ-ПОТЕРЯН: no-from без chatId');
    assert.equal(noFrom.chatType, 'private', 'ЧАТ-ПОТЕРЯН: no-from без chatType');
  }

  const fromBot = parseUpdate(makeUpdate({ from: { ...HUMAN, is_bot: true } }));
  assert.equal(fromBot.kind, 'ignore');
  if (fromBot.kind === 'ignore') {
    assert.equal(fromBot.reason, 'bot-author');
    assert.equal(fromBot.chatId, HUMAN.id, 'ЧАТ-ПОТЕРЯН: bot-author без chatId');
    assert.equal(fromBot.chatType, 'private', 'ЧАТ-ПОТЕРЯН: bot-author без chatType');
  }
});

test('ИСХОДЫ: личный чат без пригодного id даёт unparsable — отвечать физически некуда', () => {
  const result = parseUpdate(makeUpdate({ chatId: null }));
  assert.equal(result.kind, 'ignore');
  if (result.kind !== 'ignore') return;
  assert.equal(result.reason, 'unparsable');
  assert.equal(result.chatId, null);

  assert.equal(result.chatType, 'private', 'ЧАТ-ПОТЕРЯН: unparsable без chatType');
});

test('ДЕДУПЛИКАЦИЯ: update_id возвращается отдельным полем — числом либо null', () => {
  const withId = parseUpdate(makeUpdate({ updateId: 987_654 }));
  assert.equal(withId.updateId, 987_654);

  const withoutId = parseUpdate(makeUpdate({ updateId: null }));
  assert.equal(withoutId.updateId, null);

  const bogusId = parseUpdate({
    update_id: 'не число',
    message: { chat: { id: 1, type: 'private' } },
  });
  assert.equal(bogusId.updateId, null);
});

test('УСТОЙЧИВОСТЬ: parseUpdate не бросает НИ НА ОДНОМ входе', () => {
  const hostile: unknown[] = [
    null,
    undefined,
    42,
    'строка',
    [],
    [1, 2, 3],
    {},
    { message: 'не объект' },
    { message: [] },
    { message: { chat: 'не объект', text: '/start 1_fb_a_m' } },
    { message: { chat: { id: 1, type: 'private' }, from: 'не объект', text: '/start' } },
    JSON.parse(
      '{"__proto__":{"polluted":true},"message":{"chat":{"id":1,"type":"private"},"text":"/start 1_fb_a_m"}}',
    ),
    JSON.parse(
      '{"message":{"chat":{"id":1,"type":"private"},"from":{"id":1,"first_name":{"__proto__":{"x":1}}},"text":"/start"}}',
    ),
  ];
  for (const input of hostile) {
    assert.doesNotThrow(() => parseUpdate(input), `parseUpdate бросил на входе ${String(input)}`);
    const result = parseUpdate(input);
    assert.ok(
      result.kind === 'start' || result.kind === 'other' || result.kind === 'ignore',
      `неизвестный kind на входе ${String(input)}`,
    );
  }

  assert.equal(({} as Record<string, unknown>).polluted, undefined, 'ПРОТОТИП-ОТРАВЛЕН');
});

test('УСТОЙЧИВОСТЬ: строковые поля человека усечены ЗДЕСЬ, а не в сообщении менеджеру', () => {
  const result = parseUpdate(
    makeUpdate({
      from: {
        id: 7,
        is_bot: false,
        first_name: 'и'.repeat(300),
        last_name: 'ф'.repeat(300),
        username: 'u'.repeat(300),
        language_code: 'x'.repeat(300),
      },
    }),
  );
  assert.equal(result.kind, 'start');
  if (result.kind !== 'start') return;
  assert.equal(result.user.firstName.length, 64);
  assert.equal(result.user.lastName.length, 64);
  assert.equal(result.user.username.length, 32);
  assert.equal(result.user.languageCode.length, 8);
});

test('УСТОЙЧИВОСТЬ: нестроковые поля человека дают пустые строки, а не «undefined» в чате', () => {
  const result = parseUpdate(
    makeUpdate({ from: { id: 9, is_bot: false, first_name: 12345, username: null } }),
  );
  assert.equal(result.kind, 'start');
  if (result.kind !== 'start') return;
  assert.equal(result.user.firstName, '');
  assert.equal(result.user.lastName, '');
  assert.equal(result.user.username, '');
  assert.equal(result.user.languageCode, '');
  assert.equal(result.user.id, 9);
});

test('КОДЕК: модуль импортирует start-codec и не содержит ни разделителя, ни таблицы направлений', () => {
  const modulePath = fileURLToPath(new URL('../../workers/bot/update.ts', import.meta.url));
  const source = readFileSync(modulePath, 'utf8');

  assert.match(
    source,
    /\.\.\/\.\.\/src\/lib\/start-codec/,
    'КОДЕК-НЕ-ИМПОРТИРОВАН: разбор метки обязан идти через замороженный src/lib/start-codec.ts',
  );

  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const literals = code.match(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g) ?? [];
  const withSeparator = literals.filter((literal) => literal.includes('_'));
  assert.deepEqual(
    withSeparator,
    [],
    `РАЗБОР-МЕТКИ-СВОЙ: в модуле есть строковый литерал с разделителем метки: ${withSeparator.join(', ')}. ` +
      'Собственный разбор гейт check:start-codec не поймает — он ищет второе объявление PAYLOAD_VERSION.',
  );

  for (const forbidden of ['affiliate', 'teamcash', 'DIRECTIONS', 'LOCALES']) {
    assert.equal(
      code.includes(forbidden),
      false,
      `РАЗБОР-МЕТКИ-СВОЙ: модуль называет «${forbidden}» — значит завёл собственную таблицу ` +
        'направлений или локалей вместо того, чтобы получить их от decodeStart.',
    );
  }
});
