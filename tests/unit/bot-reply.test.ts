
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locale } from '../../src/lib/start-codec.ts';
import { buildReply } from '../../workers/bot/reply.ts';

globalThis.fetch = (() => {
  throw new Error('СЕТЬ ЗАПРЕЩЕНА: сборка ответа обратилась к fetch');
}) as typeof fetch;

const MANAGER = 'https://t.me/Example_Manager';

const LOCALE_NAMES: Locale[] = ['mn', 'ru', 'en'];

const i18nDir = fileURLToPath(new URL('../../workers/bot/i18n/', import.meta.url));

function dict(locale: Locale): Record<string, string> {
  return JSON.parse(readFileSync(path.join(i18nDir, `${locale}.json`), 'utf8')) as Record<
    string,
    string
  >;
}

function firstButton(replyMarkup: unknown): { text?: unknown; url?: unknown } | null {
  const markup = replyMarkup as { inline_keyboard?: unknown } | null;
  if (!markup || typeof markup !== 'object') return null;
  const rows = markup.inline_keyboard;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0] as unknown;
  if (!Array.isArray(row) || row.length === 0) return null;
  return row[0] as { text?: unknown; url?: unknown };
}

test('ПЕРЕДАЧА: кнопка с адресом менеджера есть во всех шести комбинациях', () => {
  for (const locale of LOCALE_NAMES) {
    for (const repeat of [false, true]) {
      const where = `${locale}/${repeat ? 'повтор' : 'первый'}`;
      const { text, replyMarkup } = buildReply({
        managerUrl: MANAGER,
        payload: { source: 'fb', direction: 'affiliate', locale, campaign: '', click: '' },
        languageCode: '',
        repeat,
      });

      const button = firstButton(replyMarkup);
      assert.ok(button, `ПЕРЕДАЧА-МЕНЕДЖЕРУ-ПОТЕРЯНА: ${where} — кнопки нет вовсе`);
      assert.equal(
        button.url,
        MANAGER,
        `ПЕРЕДАЧА-МЕНЕДЖЕРУ-ПОТЕРЯНА: ${where} — кнопка ведёт не на менеджера`,
      );
      assert.equal(
        button.text,
        dict(locale)['reply.manager_button'],
        `ПЕРЕДАЧА-МЕНЕДЖЕРУ-ПОТЕРЯНА: ${where} — надпись кнопки не из словаря локали`,
      );
      assert.ok(
        text.includes(dict(locale)['reply.handoff'] as string),
        `ПЕРЕДАЧА-МЕНЕДЖЕРУ-ПОТЕРЯНА: ${where} — в тексте нет фразы передачи`,
      );
    }
  }
});

test('ПЕРЕДАЧА: повторное обращение даёт заметку о повторе и ТУ ЖЕ кнопку менеджера', () => {
  const repeated = buildReply({
    managerUrl: MANAGER,
    payload: { source: '', direction: 'none', locale: 'ru', campaign: '', click: '' },
    languageCode: '',
    repeat: true,
  });
  assert.ok(
    repeated.text.includes(dict('ru')['reply.repeat_note'] as string),
    'у повторного обращения нет заметки о повторе',
  );
  assert.equal(
    firstButton(repeated.replyMarkup)?.url,
    MANAGER,
    'ПЕРЕДАЧА-МЕНЕДЖЕРУ-ПОТЕРЯНА: нажавший второй раз получил молчание',
  );

  const first = buildReply({
    managerUrl: MANAGER,
    payload: { source: '', direction: 'none', locale: 'ru', campaign: '', click: '' },
    languageCode: '',
    repeat: false,
  });
  assert.equal(
    first.text.includes(dict('ru')['reply.repeat_note'] as string),
    false,
    'заметка о повторе показана при первом обращении',
  );
});

test('ЛОКАЛЬ: текст собран из словаря локали метки', () => {
  for (const locale of LOCALE_NAMES) {
    const { text } = buildReply({
      managerUrl: MANAGER,
      payload: { source: 'fb', direction: 'bank', locale, campaign: '', click: '' },
      languageCode: 'en',
      repeat: false,
    });
    assert.ok(
      text.includes(dict(locale)['reply.greeting'] as string),
      `текст ${locale} собран не из своего словаря`,
    );
    for (const other of LOCALE_NAMES) {
      if (other === locale) continue;
      assert.equal(
        text.includes(dict(other)['reply.greeting'] as string),
        false,
        `в текст ${locale} попало приветствие из ${other}`,
      );
    }
  }
});

test('ЛОКАЛЬ: без метки берётся language_code Telegram, у неизвестного языка — mn', () => {
  const cases: Array<[string, Locale]> = [
    ['ru', 'ru'],
    ['ru-RU', 'ru'],
    ['en', 'en'],
    ['en-GB', 'en'],
    ['mn', 'mn'],
    ['mn-MN', 'mn'],
    ['zh-CN', 'mn'],
    ['tr', 'mn'],
    ['', 'mn'],
  ];
  for (const [languageCode, expected] of cases) {
    const { text } = buildReply({
      managerUrl: MANAGER,
      payload: null,
      languageCode,
      repeat: false,
    });
    assert.ok(
      text.includes(dict(expected)['reply.greeting'] as string),
      `language_code «${languageCode}» ожидался как ${expected}`,
    );
  }
});

test('ЛОКАЛЬ: метка сильнее language_code — она точнее знает, откуда пришёл человек', () => {
  const { text } = buildReply({
    managerUrl: MANAGER,
    payload: { source: 'fb', direction: 'affiliate', locale: 'en', campaign: '', click: '' },
    languageCode: 'ru-RU',
    repeat: false,
  });
  assert.ok(text.includes(dict('en')['reply.greeting'] as string));
  assert.equal(text.includes(dict('ru')['reply.greeting'] as string), false);
});

test('НАПРАВЛЕНИЕ: известное печатается брендовым именем, none не печатается вовсе', () => {
  const brands: Array<[string, string]> = [
    ['affiliate', 'Affiliate'],
    ['bank', 'Bank Transfer'],

    ['teamcash', 'Team Cash'],
  ];
  for (const [direction, brand] of brands) {
    const { text } = buildReply({
      managerUrl: MANAGER,
      payload: {
        source: 'fb',
        direction: direction as 'affiliate',
        locale: 'ru',
        campaign: '',
        click: '',
      },
      languageCode: '',
      repeat: false,
    });
    const line = (dict('ru')['reply.direction_line'] as string).replace('{direction}', brand);
    assert.ok(text.includes(line), `строки направления «${line}» нет в тексте`);

    assert.equal(text.includes('MobCash'), false, 'в текст попало устаревшее имя MobCash');
  }

  const none = buildReply({
    managerUrl: MANAGER,
    payload: { source: '', direction: 'none', locale: 'ru', campaign: '', click: '' },
    languageCode: '',
    repeat: false,
  });
  const prefix = (dict('ru')['reply.direction_line'] as string).split('{direction}')[0] as string;
  assert.equal(
    none.text.includes(prefix.trim()),
    false,
    'при «направление не выбрано» строка направления всё же напечатана',
  );
  assert.equal(none.text.includes('{direction}'), false, 'плейсхолдер уехал к человеку как есть');

  const noPayload = buildReply({
    managerUrl: MANAGER,
    payload: null,
    languageCode: 'ru',
    repeat: false,
  });
  assert.equal(
    noPayload.text.includes('{direction}'),
    false,
    'без метки плейсхолдер уехал к человеку как есть',
  );
});

test('АДРЕС: непригодный адрес менеджера бросает, а не отдаёт сообщение без кнопки', () => {
  const bad = [
    '',
    '   ',
    'http://t.me/manager',
    'javascript:alert(1)',
    'https://example.com/manager',
    'https://evil.t.me.attacker.tld/x',
    'не адрес вовсе',
  ];
  for (const managerUrl of bad) {
    assert.throws(
      () =>
        buildReply({
          managerUrl,
          payload: null,
          languageCode: 'ru',
          repeat: false,
        }),
      `непригодный адрес ${JSON.stringify(managerUrl)} не уронил сборку ответа`,
    );
  }
});

test('АДРЕС: t.me, telegram.me и m.me принимаются', () => {
  for (const managerUrl of [
    'https://t.me/Example_Manager',
    'https://telegram.me/Example_Manager',
    'https://m.me/melbet.mongolia',
  ]) {
    const { replyMarkup } = buildReply({
      managerUrl,
      payload: null,
      languageCode: 'mn',
      repeat: false,
    });
    assert.equal(firstButton(replyMarkup)?.url, managerUrl);
  }
});

test('РАЗМЕТКА: ни одно значение словарей бота не содержит <, > или &', () => {
  for (const locale of LOCALE_NAMES) {
    for (const [key, value] of Object.entries(dict(locale))) {
      assert.equal(
        /[<>&]/.test(value),
        false,
        `в ${locale}.json ключ «${key}» содержит спецсимвол HTML: сообщение уходит с ` +
          'parse_mode HTML, и экранирование пришлось бы различать «наш» текст и «чужой»',
      );
    }
  }
});

test('РАЗМЕТКА: имя человека в ответ ПОСЕТИТЕЛЮ не попадает вовсе', () => {
  const { text } = buildReply({
    managerUrl: MANAGER,
    payload: null,
    languageCode: 'ru',
    repeat: false,

  });
  assert.equal(text.includes('{'), false, 'в тексте остался неподставленный плейсхолдер');
  assert.equal(text.includes('undefined'), false, 'в текст просочилось undefined');
  assert.ok(text.trim().length > 0, 'ответ пуст');
});

test('ИМЕНА: модуль не объявляет констант из списка GUARDED контракта заявки', () => {
  const modulePath = fileURLToPath(new URL('../../workers/bot/reply.ts', import.meta.url));
  const source = readFileSync(modulePath, 'utf8');

  const guarded = /^\s*(?:export\s+)?(?:const|let|var)\s+(FIELDS|DIRECTIONS|LOCALES|ERROR_CODES|LEAD_KEY_PREFIX|LEAD_TTL_SECONDS|CONTACT_CHANNELS|HONEYPOT|HONEYPOT_FIELD|TURNSTILE_TOKEN_FIELD|BODY_MAX_BYTES|RATE_LIMIT_MAX|RATE_LIMIT_WINDOW_MS|NAME_MAX_LEN|CONTACT_MAX_LEN|SUCCESS_ROUTE)\s*[:=]/gm;
  const found = source.match(guarded) ?? [];
  assert.deepEqual(
    found,
    [],
    `ИМЯ-ИЗ-КОНТРАКТА: модуль объявляет ${found.join(', ')} — гейт check:lead-contract ` +
      'упадёт, как только план 06-02 расширит его на workers/. Таблица направлений ' +
      'обязана называться DIRECTION_LABELS.',
  );
  assert.match(
    source,
    /DIRECTION_LABELS/,
    'таблица брендовых имён направлений обязана называться DIRECTION_LABELS',
  );
});
