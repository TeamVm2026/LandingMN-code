
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { respondError, respondSuccess, wantsJson } from '../../src/server/lead/respond.ts';
import { escapeHtml } from '../../src/server/lead/message.ts';
import {
  DEFAULT_LOCALE,
  ERROR_CODES,
  LOCALES,
  RATE_LIMIT_WINDOW_MS,
  SUCCESS_ROUTE,
} from '../../src/lib/lead-contract.ts';
import type { ErrorCode } from '../../src/lib/lead-contract.ts';
import { t } from '../../src/i18n/t.ts';

globalThis.fetch = (() => {
  throw new Error('СЕТЬ ЗАПРЕЩЕНА: сборщик ответа обратился к fetch');
}) as typeof fetch;

const MANAGER = 'https://t.me/melbet_mn_manager';

const EXPECTED_STATUS: Record<ErrorCode, number> = {
  [ERROR_CODES.methodNotAllowed]: 405,
  [ERROR_CODES.bodyTooLarge]: 400,
  [ERROR_CODES.badRequest]: 400,
  [ERROR_CODES.rateLimited]: 429,
  [ERROR_CODES.validationFailed]: 422,
  [ERROR_CODES.captchaFailed]: 403,
  [ERROR_CODES.serviceUnconfigured]: 503,
  [ERROR_CODES.internalError]: 500,
};

const ALL_CODES = Object.values(ERROR_CODES);

interface JsonBody {
  ok: boolean;
  error?: string;
  fields?: string[];
}

async function jsonBody(response: Response): Promise<JsonBody> {
  return (await response.json()) as JsonBody;
}

function request(accept?: string): Request {
  return new Request('https://example.pages.dev/api/lead', {
    method: 'POST',
    headers: accept === undefined ? {} : { accept },
  });
}

test('wantsJson: application/json в Accept — истина; text/html и пустой заголовок — ложь', () => {
  assert.equal(wantsJson(request('application/json')), true);
  assert.equal(wantsJson(request('application/json, text/plain, */*')), true);
  assert.equal(wantsJson(request('APPLICATION/JSON')), true);

  assert.equal(
    wantsJson(request('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')),
    false,
  );
  assert.equal(wantsJson(request('*/*')), false);
  assert.equal(wantsJson(request()), false);
});

test('JSON-успех: статус 200 и тело { ok: true }', async () => {
  const response = respondSuccess({ json: true });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  assert.deepEqual(await jsonBody(response), { ok: true });
});

test('JSON-ошибка валидации: статус 422, код и список полей', async () => {
  const response = respondError({
    json: true,
    code: ERROR_CODES.validationFailed,
    fields: ['name'],
    managerUrl: MANAGER,
  });
  assert.equal(response.status, 422);
  assert.deepEqual(await jsonBody(response), {
    ok: false,
    error: 'validation_failed',
    fields: ['name'],
  });
});

test('JSON-ошибка без полей не изобретает пустой список', async () => {
  const response = respondError({
    json: true,
    code: ERROR_CODES.internalError,
    managerUrl: MANAGER,
  });
  assert.deepEqual(await jsonBody(response), { ok: false, error: 'internal_error' });
});

test('JSON-ошибка лимита: статус 429 и Retry-After числом секунд', async () => {
  const response = respondError({
    json: true,
    code: ERROR_CODES.rateLimited,
    retryAfterSec: 420,
    managerUrl: MANAGER,
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '420');
  assert.equal((await jsonBody(response)).error, 'rate_limited');
});

test('429 несёт Retry-After ДАЖЕ без переданных секунд — иначе заголовок бесполезен', () => {

  const jsonResponse = respondError({
    json: true,
    code: ERROR_CODES.rateLimited,
    managerUrl: MANAGER,
  });
  const htmlResponse = respondError({
    json: false,
    code: ERROR_CODES.rateLimited,
    managerUrl: MANAGER,
  });
  const fullWindow = String(RATE_LIMIT_WINDOW_MS / 1000);
  assert.equal(jsonResponse.headers.get('retry-after'), fullWindow);
  assert.equal(htmlResponse.headers.get('retry-after'), fullWindow);
});

test('Retry-After стоит только у 429 и только целым числом секунд', () => {
  for (const code of ALL_CODES) {
    for (const json of [true, false]) {
      const response = respondError({ json, code, retryAfterSec: 61.7, managerUrl: MANAGER });
      const header = response.headers.get('retry-after');
      if (code === ERROR_CODES.rateLimited) {
        assert.ok(header !== null, `${code}: Retry-After обязан быть`);
        assert.match(header, /^\d+$/, `${code}: Retry-After обязан быть целым числом секунд`);
      } else {
        assert.equal(header, null, `${code}: Retry-After здесь не к месту`);
      }
    }
  }
});

test('405 несёт Allow: POST — этого требует HTTP, и по нему клиент понимает, что делать', () => {
  for (const json of [true, false]) {
    const response = respondError({
      json,
      code: ERROR_CODES.methodNotAllowed,
      managerUrl: MANAGER,
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
  }

  assert.equal(
    respondError({ json: true, code: ERROR_CODES.internalError, managerUrl: MANAGER }).headers.get(
      'allow',
    ),
    null,
  );
});

test('ни один ответ эндпоинта не кэшируется', () => {
  const responses = [
    respondSuccess({ json: true }),
    respondSuccess({ json: false }),
    respondError({ json: true, code: ERROR_CODES.internalError, managerUrl: MANAGER }),
    respondError({ json: false, code: ERROR_CODES.internalError, managerUrl: MANAGER }),
  ];
  for (const response of responses) {
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('HTML-успех: 303 и Location, равный SUCCESS_ROUTE локали', () => {
  for (const locale of LOCALES) {
    const response = respondSuccess({ json: false, locale });
    assert.equal(response.status, 303, `${locale}: 303 See Other, а не 200`);
    assert.equal(response.headers.get('location'), SUCCESS_ROUTE[locale]);
  }
});

test('HTML-ошибка: статус тот же, что у JSON-варианта, для каждого кода контракта', () => {
  for (const code of ALL_CODES) {
    const asJson = respondError({ json: true, code, managerUrl: MANAGER });
    const asHtml = respondError({ json: false, code, managerUrl: MANAGER });
    assert.equal(asJson.status, EXPECTED_STATUS[code], `${code}: статус JSON-варианта`);
    assert.equal(asHtml.status, asJson.status, `${code}: две формы разошлись по статусу`);
  }
});

test('HTML-ошибка: lang локали, текст из словаря и ссылка на менеджера — все три локали', async () => {
  const byCode: Record<string, string> = {
    [ERROR_CODES.rateLimited]: 'api.err_rate_limited',
    [ERROR_CODES.captchaFailed]: 'api.err_captcha',
    [ERROR_CODES.validationFailed]: 'api.err_validation',
    [ERROR_CODES.internalError]: 'api.err_generic',
  };

  for (const locale of LOCALES) {
    for (const [code, key] of Object.entries(byCode)) {
      const response = respondError({
        json: false,
        locale,
        code: code as ErrorCode,
        managerUrl: MANAGER,
      });
      assert.match(response.headers.get('content-type') ?? '', /text\/html/);
      assert.match(response.headers.get('content-type') ?? '', /charset=utf-8/);

      const html = await response.text();
      assert.match(html, /^<!doctype html>/i, `${locale}/${code}: не похоже на HTML-документ`);
      assert.match(html, new RegExp(`<html[^>]*\\slang="${locale}"`), `${locale}: не тот lang`);
      assert.ok(html.includes('charset="utf-8"'), `${locale}: без charset монгольский Ө/Ү поедет`);
      assert.ok(
        html.includes(escapeHtml(t(locale, 'api.err_title'))),
        `${locale}/${code}: нет заголовка из словаря`,
      );
      assert.ok(
        html.includes(escapeHtml(t(locale, key as 'api.err_generic'))),
        `${locale}/${code}: нет текста ${key} из словаря`,
      );
      assert.ok(
        html.includes(escapeHtml(t(locale, 'api.fallback_cta'))),
        `${locale}/${code}: нет подписи запасного пути`,
      );
      assert.ok(html.includes(`href="${MANAGER}"`), `${locale}/${code}: нет ссылки на менеджера`);
    }
  }
});

test('HTML-ошибка помечена noindex — страница-ответ на POST не место в выдаче', async () => {
  for (const code of ALL_CODES) {
    const html = await respondError({ json: false, code, managerUrl: MANAGER }).text();
    assert.ok(
      html.includes('<meta name="robots" content="noindex">'),
      `${code}: страница без noindex`,
    );
  }
});

test('HTML-страница самодостаточна: ни одного внешнего ресурса и ни одного скрипта', async () => {
  const html = await respondError({
    json: false,
    code: ERROR_CODES.captchaFailed,
    managerUrl: MANAGER,
  }).text();
  assert.ok(!/<script/i.test(html), 'скрипт на странице, которую видит человек БЕЗ JS');
  assert.ok(!/<link\b/i.test(html), 'внешняя таблица стилей или шрифт');
  assert.ok(!/\ssrc=/i.test(html), 'подгружаемый ресурс');
  assert.ok(!/<img/i.test(html), 'картинка');
});

test('локаль по умолчанию — mn, когда аргумента нет', async () => {
  assert.equal(respondSuccess({ json: false }).headers.get('location'), SUCCESS_ROUTE[DEFAULT_LOCALE]);

  const html = await respondError({
    json: false,
    code: ERROR_CODES.internalError,
    managerUrl: MANAGER,
  }).text();
  assert.match(html, new RegExp(`<html[^>]*\\slang="${DEFAULT_LOCALE}"`));
  assert.ok(html.includes(escapeHtml(t(DEFAULT_LOCALE, 'api.err_title'))));
});

test('ни один ответ не несёт текста исключения и кодов Turnstile', async () => {

  const forbidden = [
    'Error:',
    'TypeError',
    'at Object.',
    'ENOENT',
    'Missing i18n key',
    'invalid-input-secret',
    'invalid-input-response',
    'configError',
    'TELEGRAM_BOT_TOKEN',
  ];

  for (const code of ALL_CODES) {
    for (const json of [true, false]) {
      const body = await respondError({
        json,
        code,
        fields: ['name', 'contact'],
        retryAfterSec: 60,
        managerUrl: MANAGER,
      }).text();
      for (const needle of forbidden) {
        assert.ok(!body.includes(needle), `${code}/json=${json}: наружу утёк «${needle}»`);
      }
    }
  }
});

test('в HTML не подставляется НИ ОДНО пользовательское значение', async () => {

  const evil = '"><script>alert(1)</script>';
  const html = await respondError({
    json: false,
    code: ERROR_CODES.validationFailed,
    fields: [evil],
    managerUrl: MANAGER,
  }).text();
  assert.ok(!html.includes(evil), 'значение поля подставлено в страницу как есть');
  assert.ok(!html.includes('alert(1)'), 'полезная нагрузка доехала до страницы');
  assert.ok(!/<script/i.test(html));
});

test('запасной путь есть всегда: пустой и небезопасный адрес менеджера не оставляют страницу без выхода', async () => {
  for (const managerUrl of ['', '   ', 'javascript:alert(1)', 'data:text/html,<script>x</script>', 'не ссылка']) {
    const html = await respondError({
      json: false,
      code: ERROR_CODES.captchaFailed,
      managerUrl,
    }).text();
    assert.ok(
      !/href="javascript:/i.test(html) && !/href="data:/i.test(html),
      `${managerUrl}: небезопасная схема доехала до href`,
    );
    assert.match(
      html,
      /<a[^>]+href="https:\/\/t\.me\//,
      `${managerUrl}: страница осталась без ссылки в Telegram`,
    );
  }
});

test('адрес менеджера попадает в href только сериализованным — кавычку из атрибута не вырваться', async () => {
  const html = await respondError({
    json: false,
    code: ERROR_CODES.internalError,
    managerUrl: 'https://t.me/manager" onclick="alert(1)',
  }).text();

  assert.ok(!/\sonclick=/i.test(html), 'значение вырвалось из атрибута href');
  assert.ok(!/<a[^>]*>[^<]*"/.test(html), 'сырая кавычка внутри открывающего тега ссылки');
  assert.match(html, /<a[^>]+href="https:\/\/t\.me\/[^"]*"/);
});
