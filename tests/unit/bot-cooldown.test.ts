
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LEAD_TTL_SECONDS } from '../../src/lib/lead-contract.ts';

globalThis.fetch = (() => {
  throw new Error('СЕТЬ ЗАПРЕЩЕНА: окно охлаждения обратилось к fetch');
}) as typeof fetch;

const defaultDir = fileURLToPath(new URL('../../workers/bot/', import.meta.url));
const botDir = process.env.BOT_MODULE_DIR ?? defaultDir;
const modulePath = path.join(botDir, 'cooldown.ts');

const {
  hitCooldown,
  hitUpdateOnce,
  BOT_COOLDOWN_SECONDS,
  BOT_OTHER_COOLDOWN_SECONDS,
  BOT_UPDATE_DEDUP_SECONDS,
} = (await import(pathToFileURL(modulePath).href)) as typeof import('../../workers/bot/cooldown.ts');

const USER = 8_123_456_789;
const T0 = Date.parse('2026-08-22T10:00:00.000Z');
const SEC = 1000;

interface RecordedPut {
  key: string;
  value: string;
  options?: { expirationTtl?: number };
}

function fakeKv(seed: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(seed));
  const puts: RecordedPut[] = [];
  const flags = { failGet: false, failPut: false };
  const kv = {
    async get(key: string, _type: 'json'): Promise<unknown> {
      if (flags.failGet) throw new Error('KV лёг на чтении');
      return store.has(key) ? store.get(key) : null;
    },
    async put(
      key: string,
      value: string,
      options?: { expirationTtl?: number },
    ): Promise<void> {
      if (flags.failPut) throw new Error('KV лёг на записи');
      puts.push({ key, value, options });
      store.set(key, JSON.parse(value));
    },
  };
  return { kv, puts, store, flags };
}

test('ОКНО: первый /start даёт new и заводит запись окна', async () => {
  const { kv, puts } = fakeKv();
  const verdict = await hitCooldown(kv, 'start', USER, T0);

  assert.equal(verdict.kind, 'new', 'первое обращение не признано новым');
  assert.equal(verdict.n, 1, 'счётчик первого обращения не равен единице');
  assert.equal(puts.length, 1, 'запись окна не сделана');
  assert.equal(puts[0]?.key, `botcd:start:${USER}`, 'ключ окна не той формы');
});

test('ОКНО: второй /start внутри окна даёт repeat ровно один раз', async () => {
  const { kv, puts } = fakeKv();
  await hitCooldown(kv, 'start', USER, T0);
  const second = await hitCooldown(kv, 'start', USER, T0 + 5 * SEC);

  assert.equal(
    second.kind,
    'repeat',
    'ПОВТОР-НЕ-ОПОЗНАН: второе обращение внутри окна не помечено повтором — ' +
      'в чат менеджеров уйдёт полный дубль, ровно то, что запрещает BOT-03',
  );
  assert.equal(second.n, 2, 'ПОВТОР-НЕ-ОПОЗНАН: номер второго обращения не равен двум');
  assert.equal(second.firstAt, T0, 'ПОВТОР-НЕ-ОПОЗНАН: потеряно время первого обращения');
  assert.equal(puts.length, 2, 'ПОВТОР-НЕ-ОПОЗНАН: второе обращение не записано в окно');
});

test('ОКНО: третий и далее внутри окна молчат и запись НЕ переписывается', async () => {
  const { kv, puts } = fakeKv();
  await hitCooldown(kv, 'start', USER, T0);
  await hitCooldown(kv, 'start', USER, T0 + SEC);

  const third = await hitCooldown(kv, 'start', USER, T0 + 2 * SEC);
  const fourth = await hitCooldown(kv, 'start', USER, T0 + 3 * SEC);

  assert.equal(
    third.kind,
    'silent',
    'ПОВТОР-НЕ-ОПОЗНАН: третье обращение внутри окна не молчит — чат менеджеров зарастёт дублями',
  );
  assert.equal(
    fourth.kind,
    'silent',
    'ПОВТОР-НЕ-ОПОЗНАН: четвёртое обращение внутри окна не молчит',
  );
  assert.equal(
    puts.length,
    2,
    'ПОВТОР-НЕ-ОПОЗНАН: молчаливое обращение переписало запись окна — ' +
      'это лишняя запись в суточный бюджет KV на пустом месте',
  );

  assert.equal(third.n, 3, 'ПОВТОР-НЕ-ОПОЗНАН: номер третьего обращения не равен трём');
  assert.equal(fourth.n, 3, 'ПОВТОР-НЕ-ОПОЗНАН: счётчик двинулся без записи в KV');
});

test('ОКНО: фиксированное, а не скользящее — обращения внутри не двигают срок', async () => {
  const { kv } = fakeKv();
  const window = BOT_COOLDOWN_SECONDS * SEC;

  await hitCooldown(kv, 'start', USER, T0);
  await hitCooldown(kv, 'start', USER, T0 + window - 2 * SEC);

  const stillInside = await hitCooldown(kv, 'start', USER, T0 + window - SEC);
  assert.equal(
    stillInside.kind,
    'silent',
    'ПОВТОР-НЕ-ОПОЗНАН: обращение внутри окна не молчит',
  );

  const afterWindow = await hitCooldown(kv, 'start', USER, T0 + window);
  assert.equal(afterWindow.kind, 'new', 'после истечения окна обращение не признано новым');
  assert.equal(afterWindow.n, 1, 'счётчик не начался заново');
  assert.equal(afterWindow.firstAt, T0 + window, 'окно не началось заново — оно скользящее');
});

test('ОКНО: у ведра other вердикта repeat нет вовсе', async () => {
  const { kv, puts } = fakeKv();
  const first = await hitCooldown(kv, 'other', USER, T0);
  const second = await hitCooldown(kv, 'other', USER, T0 + SEC);
  const third = await hitCooldown(kv, 'other', USER, T0 + 2 * SEC);

  assert.equal(first.kind, 'new', 'первое свободное сообщение не признано новым');
  assert.equal(
    second.kind,
    'silent',
    'ПОВТОР-НЕ-ОПОЗНАН: второе свободное сообщение получило вердикт ' +
      `«${second.kind}» — повторять менеджерам про «привет» нечего`,
  );
  assert.equal(third.kind, 'silent', 'ПОВТОР-НЕ-ОПОЗНАН: третье свободное сообщение не молчит');
  assert.equal(puts.length, 1, 'ведро other пишет в KV больше одного раза за окно');
});

test('ОКНО: вёдра start и other не мешают друг другу', async () => {
  const { kv, puts } = fakeKv();

  const hello = await hitCooldown(kv, 'other', USER, T0);
  const lead = await hitCooldown(kv, 'start', USER, T0 + SEC);

  assert.equal(hello.kind, 'new', 'свободное сообщение не признано новым');
  assert.equal(lead.kind, 'new', 'лид после свободного сообщения потерян в общем ведре');
  assert.deepEqual(
    puts.map((p) => p.key).sort(),
    [`botcd:other:${USER}`, `botcd:start:${USER}`],
    'вёдра пишут в один ключ',
  );
});

test('ОКНО: длина у вёдер РАЗНАЯ и ни одна не равна сроку хранения лида', () => {
  assert.equal(BOT_COOLDOWN_SECONDS, 24 * 60 * 60, 'окно лида не равно суткам');
  assert.equal(BOT_OTHER_COOLDOWN_SECONDS, 10 * 60, 'окно свободных сообщений не равно 10 минутам');
  assert.notEqual(
    BOT_COOLDOWN_SECONDS,
    BOT_OTHER_COOLDOWN_SECONDS,
    'вёдра свели к одному окну: сутки молчания от бота, к которому привела главная кнопка',
  );
  assert.notEqual(
    BOT_COOLDOWN_SECONDS,
    LEAD_TTL_SECONDS,
    'окно охлаждения приравнено к сроку хранения — это два числа с разными причинами',
  );
});

test('СРОК: запись окна живёт ровно своё окно, а не срок хранения лида', async () => {
  const { kv, puts } = fakeKv();
  await hitCooldown(kv, 'start', USER, T0);
  await hitCooldown(kv, 'other', USER, T0);

  const byKey = new Map(puts.map((p) => [p.key, p.options?.expirationTtl]));
  assert.equal(byKey.get(`botcd:start:${USER}`), BOT_COOLDOWN_SECONDS, 'срок записи ведра start не тот');
  assert.equal(byKey.get(`botcd:other:${USER}`), BOT_OTHER_COOLDOWN_SECONDS, 'срок записи ведра other не тот');
  for (const ttl of byKey.values()) {
    assert.notEqual(ttl, LEAD_TTL_SECONDS, 'срок записи окна равен сроку хранения заявки');
  }
});

test('УСТОЙЧИВОСТЬ: сбой чтения, мусор и отсутствие записи деградируют до new', async () => {
  const broken = fakeKv();
  broken.flags.failGet = true;
  const onBrokenRead = await hitCooldown(broken.kv, 'start', USER, T0);
  assert.equal(onBrokenRead.kind, 'new', 'сломанное хранилище проглотило настоящего человека');

  for (const junk of [42, 'строка', [], { n: 'два' }, { start: 'вчера', n: 1 }, null]) {
    const { kv } = fakeKv({ [`botcd:start:${USER}`]: junk });
    const verdict = await hitCooldown(kv, 'start', USER, T0);
    assert.equal(verdict.kind, 'new', `мусор ${JSON.stringify(junk)} не деградировал до new`);
  }
});

test('УСТОЙЧИВОСТЬ: сбой записи не отменяет уже вынесенного вердикта', async () => {
  const { kv, flags } = fakeKv();
  flags.failPut = true;
  const verdict = await hitCooldown(kv, 'start', USER, T0);
  assert.equal(verdict.kind, 'new', 'сбой записи отменил вердикт');
});

test('ИЗОЛЯЦИЯ: модуль не импортирует значений и не трогает глобального хранилища', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../workers/bot/cooldown.ts', import.meta.url)),
    'utf8',
  );
  const valueImports = [...source.matchAll(/^import\s+(?!type\b)[^\n]*$/gm)];
  assert.deepEqual(
    valueImports.map((m) => m[0]),
    [],
    'в cooldown.ts появился импорт значений — копия в .sabotage-tmp/ перестанет резолвиться, ' +
      'и случай саботажа упадёт по постороннему поводу вместо покраснения',
  );
  assert.ok(!/\bcaches\b/.test(source), 'модуль обратился к глобальному caches');
});

test('ДЕДУП: первый update_id проходит, повторный отсекается', async () => {
  const { kv, puts } = fakeKv();
  const first = await hitUpdateOnce(kv, 777);
  const again = await hitUpdateOnce(kv, 777);

  assert.equal(first, true, 'РЕТРАЙ-НЕ-ОТСЕЧЁН: первый апдейт не пропущен');
  assert.equal(
    again,
    false,
    'РЕТРАЙ-НЕ-ОТСЕЧЁН: повтор той же доставки прошёл конвейер второй раз — ' +
      'окно охлаждения опубликует ложную пометку «повторный лид»',
  );
  assert.equal(puts.length, 1, 'метка апдейта записана дважды');
  assert.equal(puts[0]?.key, 'botupd:777', 'ключ метки апдейта не той формы');
});

test('ДЕДУП: апдейт без идентификатора проходит и НЕ пишет в KV', async () => {
  const { kv, puts } = fakeKv();
  assert.equal(await hitUpdateOnce(kv, null), true, 'апдейт без update_id потерян');
  assert.equal(puts.length, 0, 'запись сделана по ключу без идентификатора');
});

test('ДЕДУП: окно измеряется минутами, а не сутками', async () => {
  const { kv, puts } = fakeKv();
  await hitUpdateOnce(kv, 42);

  assert.ok(BOT_UPDATE_DEDUP_SECONDS >= 60, 'меньше минуты KV не принимает вовсе');
  assert.ok(
    BOT_UPDATE_DEDUP_SECONDS < BOT_COOLDOWN_SECONDS,
    'окно дедупликации доросло до окна охлаждения: оно закрывает ретраи Telegram, а не поведение человека',
  );
  assert.equal(puts[0]?.options?.expirationTtl, BOT_UPDATE_DEDUP_SECONDS, 'срок метки апдейта не тот');
});

test('ДЕДУП: сбой хранилища не теряет апдейт', async () => {
  const onRead = fakeKv();
  onRead.flags.failGet = true;
  assert.equal(await hitUpdateOnce(onRead.kv, 5), true, 'сбой чтения потерял апдейт');

  const onWrite = fakeKv();
  onWrite.flags.failPut = true;
  assert.equal(await hitUpdateOnce(onWrite.kv, 5), true, 'сбой записи потерял апдейт');
});
