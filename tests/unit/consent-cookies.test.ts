
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyticsCookieDomains } from '../../src/scripts/analytics/consent.ts';

test('ДОМЕН: боевая форма Cloudflare Pages попадает в кандидаты', () => {
  const got = analyticsCookieDomains('landingmn.pages.dev');

  assert.equal(got[0], null);

  assert.ok(
    got.includes('.landingmn.pages.dev'),
    `нет боевой формы домена, получено: ${JSON.stringify(got)}`,
  );

  assert.ok(!got.includes('.dev'), `TLD попал в кандидаты: ${JSON.stringify(got)}`);
});

test('ДОМЕН: будущий боевой домен проекта тоже покрыт', () => {
  const got = analyticsCookieDomains('partner-melbet.com');
  assert.ok(got.includes('.partner-melbet.com'), JSON.stringify(got));
  assert.ok(!got.includes('.com'), `TLD попал в кандидаты: ${JSON.stringify(got)}`);
});

test('ДОМЕН: у односегментного имени кандидатов домена нет вовсе', () => {

  assert.deepEqual(analyticsCookieDomains('localhost'), [null]);
});

test('ДОМЕН: IP-литерал регистрируемого имени не имеет', () => {
  assert.deepEqual(analyticsCookieDomains('127.0.0.1'), [null]);
  assert.deepEqual(analyticsCookieDomains('::1'), [null]);
  assert.deepEqual(analyticsCookieDomains('[::1]'), [null]);
});

test('ДОМЕН: регистр, хвостовая точка и пустое имя не ломают список', () => {

  assert.deepEqual(analyticsCookieDomains('LandingMN.Pages.Dev.'), [
    null,
    '.landingmn.pages.dev',
    '.pages.dev',
  ]);
  assert.deepEqual(analyticsCookieDomains(''), [null]);
  assert.deepEqual(analyticsCookieDomains('   '), [null]);
});

test('ДОМЕН: поддомен даёт и себя, и родителя, от длинного к короткому', () => {

  assert.deepEqual(analyticsCookieDomains('preview.landingmn.pages.dev'), [
    null,
    '.preview.landingmn.pages.dev',
    '.landingmn.pages.dev',
    '.pages.dev',
  ]);
});
