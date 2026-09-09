
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateLead } from '../../src/server/lead/validate.ts';
import {
  CONTACT_CHANNELS,
  DIRECTIONS,
  ERROR_CODES,
  FIELDS,
  LOCALES,
  NAME_MAX_LEN,
} from '../../src/lib/lead-contract.ts';

globalThis.fetch = (() => {
  throw new Error('СЕТЬ ЗАПРЕЩЕНА: валидация обратилась к fetch');
}) as typeof fetch;

function body(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    [FIELDS.name]: 'Ганбаатар',
    [FIELDS.contact]: '+976 9911 2233',
    [FIELDS.contactChannel]: 'phone',
    [FIELDS.direction]: 'affiliate',
    [FIELDS.consent]: 'on',
    [FIELDS.lang]: 'mn',
    ...overrides,
  };
}

function assertRejected(input: Record<string, string>, expectedFields: string[]): void {
  const result = validateLead(input);
  assert.equal(result.ok, false, `ожидался отказ, а заявка принята: ${JSON.stringify(input)}`);
  if (result.ok) return;
  assert.equal(result.code, ERROR_CODES.validationFailed);
  assert.deepEqual([...result.fields].sort(), [...expectedFields].sort());
}

test('монгольское имя проходит — регулярка по латинице сломала бы гео целиком', () => {
  const result = validateLead(body({ [FIELDS.name]: 'Ганбаатар' }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.lead.name, 'Ганбаатар');
});

test('имя из монгольских Ө и Ү проходит и доезжает до заявки посимвольно', () => {
  const result = validateLead(body({ [FIELDS.name]: 'Ө Ү' }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.lead.name, 'Ө Ү');
});

test('пустое имя отвергается с полем name', () => {
  assertRejected(body({ [FIELDS.name]: '' }), [FIELDS.name]);
});

test('имя из одних пробелов отвергается — трим делает его пустым', () => {
  assertRejected(body({ [FIELDS.name]: '   \t  ' }), [FIELDS.name]);
});

test('имя длиннее потолка отвергается, ровно на потолке — принимается', () => {
  assertRejected(body({ [FIELDS.name]: 'Ө'.repeat(NAME_MAX_LEN + 1) }), [FIELDS.name]);
  const edge = validateLead(body({ [FIELDS.name]: 'Ө'.repeat(NAME_MAX_LEN) }));
  assert.equal(edge.ok, true);
});

test('пробелы вокруг имени срезаются, а не считаются длиной', () => {
  const result = validateLead(body({ [FIELDS.name]: `  ${'Ө'.repeat(NAME_MAX_LEN)}  ` }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.lead.name.length, NAME_MAX_LEN);
});

test('contact_channel вне перечисления отвергается', () => {
  assertRejected(body({ [FIELDS.contactChannel]: 'whatsapp' }), [FIELDS.contactChannel]);
});

test('перечисление каналов берётся из контракта, а не из копии', () => {
  const sample: Record<string, string> = {
    phone: '+976 9911 2233',
    telegram: '@user_name',
    messenger: 'm.me/ganbaatar',
  };
  for (const channel of CONTACT_CHANNELS) {
    const result = validateLead(
      body({ [FIELDS.contactChannel]: channel, [FIELDS.contact]: sample[channel] ?? '' }),
    );
    assert.equal(result.ok, true, `канал ${channel} обязан приниматься`);
  }
});

test('phone: монгольский номер с пробелами проходит', () => {
  const result = validateLead(
    body({ [FIELDS.contactChannel]: 'phone', [FIELDS.contact]: '+976 9911 2233' }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.lead.contact, '+976 9911 2233');
});

test('phone: буквы отвергаются с полем contact', () => {
  assertRejected(body({ [FIELDS.contactChannel]: 'phone', [FIELDS.contact]: 'abc' }), [
    FIELDS.contact,
  ]);
});

test('phone: цифр меньше восьми и больше пятнадцати — отказ', () => {
  assertRejected(body({ [FIELDS.contactChannel]: 'phone', [FIELDS.contact]: '9911223' }), [
    FIELDS.contact,
  ]);
  assertRejected(
    body({ [FIELDS.contactChannel]: 'phone', [FIELDS.contact]: '+9761234567890123' }),
    [FIELDS.contact],
  );
});

test('telegram: и @user_name, и user_name проходят', () => {
  for (const value of ['@user_name', 'user_name']) {
    const result = validateLead(
      body({ [FIELDS.contactChannel]: 'telegram', [FIELDS.contact]: value }),
    );
    assert.equal(result.ok, true, `ник ${value} обязан приниматься`);
  }
});

test('telegram: ник короче пяти знаков отвергается', () => {
  assertRejected(body({ [FIELDS.contactChannel]: 'telegram', [FIELDS.contact]: 'usr' }), [
    FIELDS.contact,
  ]);
});

test('messenger: любая непустая строка проходит — ссылку не валидируем, пережать значит потерять лид', () => {
  const values = ['https://m.me/ganbaatar', 'Ганбаатар Facebook-ээр', 'facebook.com/profile.php?id=100'];
  for (const value of values) {
    const result = validateLead(
      body({ [FIELDS.contactChannel]: 'messenger', [FIELDS.contact]: value }),
    );
    assert.equal(result.ok, true, `значение «${value}» обязано приниматься`);
  }
});

test('контакт: пустой отвергается при любом канале', () => {
  for (const channel of CONTACT_CHANNELS) {
    assertRejected(body({ [FIELDS.contactChannel]: channel, [FIELDS.contact]: '  ' }), [
      FIELDS.contact,
    ]);
  }
});

test('direction вне перечисления отвергается', () => {
  assertRejected(body({ [FIELDS.direction]: 'crypto' }), [FIELDS.direction]);
});

test('все направления контракта принимаются', () => {
  for (const direction of DIRECTIONS) {
    assert.equal(validateLead(body({ [FIELDS.direction]: direction })).ok, true);
  }
});

test('отсутствующее согласие отвергается — без него заявку принимать нельзя', () => {
  const withoutConsent = body();
  delete withoutConsent[FIELDS.consent];
  assertRejected(withoutConsent, [FIELDS.consent]);
});

test('пустое согласие равно отсутствующему', () => {
  assertRejected(body({ [FIELDS.consent]: '' }), [FIELDS.consent]);
});

test('язык вне перечисления молча приводится к mn, а не отклоняет заявку', () => {
  const result = validateLead(body({ [FIELDS.lang]: 'kk' }));
  assert.equal(result.ok, true, 'чужой язык не повод потерять лид');
  if (!result.ok) return;
  assert.equal(result.lead.lang, 'mn');
});

test('отсутствующий язык тоже даёт mn', () => {
  const withoutLang = body();
  delete withoutLang[FIELDS.lang];
  const result = validateLead(withoutLang);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.lead.lang, 'mn');
});

test('все локали контракта проходят как есть', () => {
  for (const locale of LOCALES) {
    const result = validateLead(body({ [FIELDS.lang]: locale }));
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.lead.lang, locale);
  }
});

test('в отказе только имена полей — ни одного текста исключения наружу', () => {
  const result = validateLead({
    [FIELDS.name]: '',
    [FIELDS.contact]: '',
    [FIELDS.contactChannel]: 'нет',
    [FIELDS.direction]: 'нет',
  });
  assert.equal(result.ok, false);
  if (result.ok) return;

  assert.deepEqual(Object.keys(result).sort(), ['code', 'fields', 'ok']);
  const known = new Set<string>(Object.values(FIELDS));
  for (const field of result.fields) {
    assert.equal(known.has(field), true, `поле «${field}» не объявлено в контракте`);
  }
  const serialized = JSON.stringify(result);
  for (const leak of ['Error', 'stack', 'TypeError', 'undefined']) {
    assert.equal(serialized.includes(leak), false, `наружу утёк текст исключения: ${leak}`);
  }
});

test('невалидные поля перечисляются все сразу, а не по одному за запрос', () => {
  assertRejected(
    {
      [FIELDS.name]: '',
      [FIELDS.contact]: '',
      [FIELDS.contactChannel]: 'sms',
      [FIELDS.direction]: 'crypto',
    },
    [FIELDS.name, FIELDS.contact, FIELDS.contactChannel, FIELDS.direction, FIELDS.consent],
  );
});

test('тело не объект и тело без единого поля отвергаются, а не роняют функцию', () => {
  for (const hostile of [null, undefined, 'строка', 42, []]) {
    const result = validateLead(hostile as never);
    assert.equal(result.ok, false, `враждебное тело ${JSON.stringify(hostile)} обязано быть отвергнуто`);
  }
});

test('нестроковые значения полей отвергаются без исключения', () => {
  const hostile = { ...body(), [FIELDS.name]: { toString: () => 'Ганбаатар' } };
  const result = validateLead(hostile as never);
  assert.equal(result.ok, false);
});

test('прототипные ключи в теле не доезжают до нормализованной заявки', () => {
  const hostile: unknown = JSON.parse(
    '{"name":"Ганбаатар","contact":"+976 9911 2233","contact_channel":"phone","direction":"affiliate","consent":"on","__proto__":{"polluted":true}}',
  );
  const result = validateLead(hostile);
  assert.equal(result.ok, true);
  assert.equal(
    ({} as Record<string, unknown>).polluted,
    undefined,
    'прототип объекта загрязнён',
  );
});
