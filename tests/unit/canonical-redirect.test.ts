
import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalRedirectTarget } from '../../src/server/canonical-redirect.ts';

const CANONICAL = 'https://partner-melbet.com';

test('production-поддомен проекта уходит на боевой домен с путём и параметрами', () => {
  assert.equal(
    canonicalRedirectTarget('https://landingmn.pages.dev/ru/?utm_source=fb&x=1', 'GET', CANONICAL),
    'https://partner-melbet.com/ru/?utm_source=fb&x=1',
  );
  assert.equal(
    canonicalRedirectTarget('https://landingmn.pages.dev/', 'HEAD', CANONICAL),
    'https://partner-melbet.com/',
  );
  assert.equal(
    canonicalRedirectTarget('https://landingmn.pages.dev/sitemap-index.xml', 'GET', CANONICAL),
    'https://partner-melbet.com/sitemap-index.xml',
  );
});

test('www боевого домена уходит на голый домен', () => {
  assert.equal(
    canonicalRedirectTarget('https://www.partner-melbet.com/en/privacy/', 'GET', CANONICAL),
    'https://partner-melbet.com/en/privacy/',
  );
});

test('боевой домен обслуживается на месте', () => {
  assert.equal(canonicalRedirectTarget('https://partner-melbet.com/', 'GET', CANONICAL), null);
  assert.equal(canonicalRedirectTarget('https://partner-melbet.com/ru/', 'GET', CANONICAL), null);
});

test('⛔ API не переадресуется: POST заявки со старой страницы не теряется', () => {
  for (const method of ['POST', 'GET']) {
    assert.equal(canonicalRedirectTarget('https://landingmn.pages.dev/api/lead', method, CANONICAL), null);
  }
  assert.equal(canonicalRedirectTarget('https://landingmn.pages.dev/api/health', 'GET', CANONICAL), null);
  assert.equal(canonicalRedirectTarget('https://www.partner-melbet.com/api/lead', 'POST', CANONICAL), null);
});

test('⛔ служебные пути Cloudflare не переадресуются', () => {
  assert.equal(canonicalRedirectTarget('https://landingmn.pages.dev/cdn-cgi/trace', 'GET', CANONICAL), null);
});

test('⛔ превью-выкладки и прочие хосты не переадресуются', () => {
  for (const url of [
    'https://16a4622d.landingmn.pages.dev/',
    'https://feature-x.landingmn.pages.dev/ru/',
    'http://localhost:4321/',
    'http://127.0.0.1:8788/',
    'https://example.com/',
    'https://shop.partner-melbet.com/',
  ]) {
    assert.equal(canonicalRedirectTarget(url, 'GET', CANONICAL), null, url);
  }
});

test('⛔ кроме GET и HEAD — ничего', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    assert.equal(canonicalRedirectTarget('https://landingmn.pages.dev/', method, CANONICAL), null, method);
  }
});

test('без боевого адреса переадресации нет, мусор в адресе её не включает', () => {
  assert.equal(canonicalRedirectTarget('https://landingmn.pages.dev/', 'GET', undefined), null);
  assert.equal(canonicalRedirectTarget('https://landingmn.pages.dev/', 'GET', ''), null);
  assert.equal(canonicalRedirectTarget('https://landingmn.pages.dev/', 'GET', 'не адрес'), null);
});
