
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isInternalHost, siteHost } from '../../src/scripts/analytics/environment.ts';

test('адрес сайта — не внутренний трафик', () => {
  assert.equal(isInternalHost('landingmn.pages.dev', 'https://landingmn.pages.dev'), false);
  assert.equal(isInternalHost('partner-melbet.com', 'https://partner-melbet.com'), false);
  assert.equal(isInternalHost('Partner-Melbet.com', 'https://partner-melbet.com/'), false, 'регистр хоста не важен');
});

test('тесты, локальный предпросмотр и превью-ветки — внутренний трафик', () => {
  for (const host of ['localhost', '127.0.0.1', '192.168.0.2', 'probe-messenger.landingmn.pages.dev', 'www.partner-melbet.com']) {
    assert.equal(isInternalHost(host, 'https://partner-melbet.com'), true, host);
  }
  assert.equal(isInternalHost('localhost', 'https://landingmn.pages.dev'), true);
});

test('адрес сайта не задан или битый — всё внутреннее', () => {
  assert.equal(siteHost(''), '');
  assert.equal(siteHost('не адрес'), '');
  assert.equal(isInternalHost('partner-melbet.com', ''), true);
  assert.equal(isInternalHost('partner-melbet.com', 'не адрес'), true);
});
