
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeStart,
  normalizeToken,
  encodeStart,
  PAYLOAD_MAX,
  LIMITS,
  DIRECTIONS,
  LOCALES,
  type Direction,
  type Locale,
} from '../../src/lib/start-codec.ts';
import { buildContactHref } from '../../src/lib/start-link.ts';

const projectRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SCRIPT = path.join(projectRoot, 'scripts', 'make-start-link.ts');

const BOT_URL = 'https://t.me/melbet_mn_bot';

interface Run {
  status: number;
  stdout: string;
  stderr: string;

  href: string | null;
}

function mint(args: string[], env: Record<string, string> = {}): Run {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', SCRIPT, ...args],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, PUBLIC_TG_BOT_URL: BOT_URL, ...env },
    },
  );

  const stdout = result.stdout ?? '';
  const match = stdout.match(/https:\/\/\S+/);
  return { status: result.status ?? -1, stdout, stderr: result.stderr ?? '', href: match?.[0] ?? null };
}

function payloadOf(href: string): string {
  return decodeURIComponent(new URL(href).searchParams.get('start') ?? '');
}

const DIRECTION_KEYS = Object.keys(DIRECTIONS) as Direction[];
const LOCALE_KEYS = Object.keys(LOCALES) as Locale[];

test('перебор 4 направления × 3 локали: метка разбирается обратно в исходные значения', () => {
  const source = 'fb-ads';
  const campaign = 'autumn-promo';

  let checked = 0;

  for (const direction of DIRECTION_KEYS) {
    for (const locale of LOCALE_KEYS) {
      const run = mint([
        '--source', source,
        '--direction', direction,
        '--locale', locale,
        '--campaign', campaign,
      ]);

      assert.equal(run.status, 0, `${direction}/${locale}: минтер отказал\n${run.stderr}`);
      assert.ok(run.href, `${direction}/${locale}: ссылка не напечатана`);
      assert.ok(
        run.href!.startsWith(`${BOT_URL}?start=`),
        `${direction}/${locale}: неожиданный вид ссылки — ${run.href}`,
      );

      const payload = payloadOf(run.href!);

      assert.ok(
        payload.length <= PAYLOAD_MAX,
        `${direction}/${locale}: метка ${payload.length} симв. > ${PAYLOAD_MAX}`,
      );

      const decoded = decodeStart(payload);
      assert.notEqual(decoded, null, `${direction}/${locale}: метка «${payload}» не разбирается`);
      assert.equal(decoded!.direction, direction, `${direction}/${locale}: не то направление`);
      assert.equal(decoded!.locale, locale, `${direction}/${locale}: не та локаль`);
      assert.equal(decoded!.source, source, `${direction}/${locale}: потерян источник`);
      assert.equal(decoded!.campaign, campaign, `${direction}/${locale}: потеряна кампания`);
      assert.equal(decoded!.click, '', `${direction}/${locale}: взялся хвост клика`);

      checked++;
    }
  }

  assert.equal(checked, 12, 'перебор недосчитался комбинаций');
});

test('хвост клика доезжает до метки и разбирается обратно', () => {

  const click = '7f3a91b2e0';
  const run = mint([
    '--source', 'fb',
    '--direction', 'affiliate',
    '--locale', 'mn',
    '--campaign', 'autumn',
    '--click', click,
  ]);

  assert.equal(run.status, 0, run.stderr);
  const decoded = decodeStart(payloadOf(run.href!));
  assert.notEqual(decoded, null);
  assert.equal(decoded!.click, click, 'хвост клика потерян');
  assert.equal(decoded!.source, 'fb');
  assert.equal(decoded!.campaign, 'autumn');
});

test('худший случай — все поля по лимиту — укладывается в потолок Telegram', () => {

  const run = mint([
    '--source', 'a'.repeat(LIMITS.source),
    '--direction', 'affiliate',
    '--locale', 'mn',
    '--campaign', 'b'.repeat(LIMITS.campaign),
    '--click', 'c'.repeat(LIMITS.click),
  ]);

  assert.equal(run.status, 0, run.stderr);
  const payload = payloadOf(run.href!);
  assert.ok(payload.length <= PAYLOAD_MAX, `худший случай ${payload.length} > ${PAYLOAD_MAX}`);
  const decoded = decodeStart(payload);
  assert.notEqual(decoded, null, 'худший случай не разбирается');
  assert.equal(decoded!.source.length, LIMITS.source);
  assert.equal(decoded!.campaign.length, LIMITS.campaign);
  assert.equal(decoded!.click.length, LIMITS.click);
});

test('при пустом хвосте клика минтер даёт БАЙТ В БАЙТ то же, что сборка сайта', () => {

  for (const direction of DIRECTION_KEYS) {
    for (const locale of LOCALE_KEYS) {
      const run = mint(['--source', 'fb', '--direction', direction, '--locale', locale, '--campaign', 'promo']);
      assert.equal(run.status, 0, run.stderr);

      const expected = buildContactHref({
        botUrl: BOT_URL,
        fallbackUrl: BOT_URL,
        direction,
        locale,
        source: 'fb',
        campaign: 'promo',
      });

      assert.equal(run.href, expected, `${direction}/${locale}: минтер разошёлся со сборкой сайта`);
    }
  }
});

test('минтер не объявляет формат заново: метка совпадает с encodeStart', () => {
  const run = mint(['--source', 'fb', '--direction', 'bank', '--locale', 'ru', '--campaign', 'x-1']);
  assert.equal(run.status, 0, run.stderr);

  const expected = encodeStart({
    source: 'fb',
    direction: 'bank',
    locale: 'ru',
    campaign: 'x-1',
    click: '',
  });
  assert.equal(payloadOf(run.href!), expected);
});

test('кириллица нормализуется ВИДИМО: исходник и результат напечатаны рядом', () => {
  const raw = 'Осенняя кампания №3';
  const run = mint(['--source', 'fb', '--direction', 'affiliate', '--locale', 'mn', '--campaign', raw]);

  assert.equal(run.status, 0, run.stderr);

  assert.ok(run.stdout.includes(raw), 'исходное значение не показано человеку');

  const normalizedValue = normalizeToken(raw, LIMITS.campaign);
  assert.ok(
    run.stdout.includes(`«${normalizedValue}»`),
    `нормализованное значение «${normalizedValue}» не показано человеку`,
  );

  assert.equal(normalizedValue, '3', 'поведение нормализации кириллицы изменилось');

  assert.equal(decodeStart(payloadOf(run.href!))!.campaign, normalizedValue);

  assert.ok(
    run.stdout.includes('НЕ транслитерируется'),
    'предупреждение про не-латиницу не напечатано',
  );
});

test('ввод, съеденный нормализацией ЦЕЛИКОМ, роняет минтер, а не уезжает пустым полем', () => {

  for (const [flag, value] of [
    ['--source', '№№№'],
    ['--campaign', '!!! ???'],
  ] as const) {
    const run = mint(['--source', 'fb', '--direction', 'bank', '--locale', 'en', flag, value]);

    assert.equal(run.status, 1, `${flag} «${value}»: минтер не отказал`);
    assert.equal(run.href, null, `${flag} «${value}»: ссылка всё-таки напечатана`);
    assert.match(run.stderr, /ОТКАЗ/, `${flag}: отказ без внятного сообщения`);
  }
});

test('верхний регистр и пробелы нормализуются видимо и попадают в метку', () => {
  const run = mint(['--source', 'FB Ads', '--direction', 'bank', '--locale', 'en']);

  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes('FB Ads'), 'исходник не показан');
  assert.ok(run.stdout.includes('«fb-ads»'), 'нормализованное значение не показано');
  assert.equal(decodeStart(payloadOf(run.href!))!.source, 'fb-ads');
});

test('слишком длинное значение обрезается ВИДИМО и не выходит за лимит поля', () => {
  const long = 'a'.repeat(LIMITS.source + 10);
  const run = mint(['--source', long, '--direction', 'bank', '--locale', 'en']);

  assert.equal(run.status, 0, run.stderr);
  const decoded = decodeStart(payloadOf(run.href!));
  assert.equal(decoded!.source.length, LIMITS.source, 'обрезка до лимита не сработала');
  assert.ok(run.stdout.includes(long), 'исходник не показан человеку');
  assert.ok(run.stdout.includes(`«${decoded!.source}»`), 'результат обрезки не показан человеку');
});

test('пустой PUBLIC_TG_BOT_URL — внятный отказ, а не ссылка на пустоту', () => {
  const run = mint(['--source', 'fb', '--direction', 'bank', '--locale', 'en'], {
    PUBLIC_TG_BOT_URL: '',
  });

  assert.equal(run.status, 1);
  assert.equal(run.href, null, 'собралась ссылка при отсутствующем адресе бота');
  assert.match(run.stderr, /PUBLIC_TG_BOT_URL пуст/);

  assert.match(run.stderr, /\.env\.local/);
});

test('адрес не на t.me роняет минтер — правило сборки действует и здесь', () => {

  for (const bad of ['https://example.com/bot', 'не адрес', 'http://t.me/bot']) {
    const run = mint(['--source', 'fb', '--direction', 'bank', '--locale', 'en'], {
      PUBLIC_TG_BOT_URL: bad,
    });
    assert.equal(run.status, 1, `«${bad}» принят как адрес бота`);
    assert.equal(run.href, null, `«${bad}»: ссылка напечатана`);
  }
});

test('неизвестный флаг — отказ, а не молчаливое игнорирование', () => {

  const run = mint(['--source', 'fb', '--direction', 'bank', '--locale', 'en', '--campain', 'autumn']);

  assert.equal(run.status, 1);
  assert.equal(run.href, null);
  assert.match(run.stderr, /неизвестный флаг --campain/);
});

test('направление и локаль вне домена отвергаются с перечислением допустимых', () => {
  const badDirection = mint(['--source', 'fb', '--direction', 'AFFILIATE', '--locale', 'en']);
  assert.equal(badDirection.status, 1);
  assert.match(badDirection.stderr, /вне домена/);
  assert.match(badDirection.stderr, /affiliate/);

  const badLocale = mint(['--source', 'fb', '--direction', 'bank', '--locale', 'kz']);
  assert.equal(badLocale.status, 1);
  assert.match(badLocale.stderr, /вне домена/);

  const missing = mint(['--source', 'fb']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /обязательны/);
});

test('пустой источник разрешён, но проговаривается вслух', () => {

  const run = mint(['--direction', 'bank', '--locale', 'en']);

  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.href, 'ссылка не собралась');
  assert.equal(decodeStart(payloadOf(run.href!))!.source, '');
  assert.match(run.stdout, /ИСТОЧНИК ПУСТ/);
});
