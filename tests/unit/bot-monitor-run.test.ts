
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultDir = fileURLToPath(new URL('../../workers/bot/', import.meta.url));
const botDir = process.env.BOT_MODULE_DIR ?? defaultDir;
const modulePath = path.join(botDir, 'monitor-run.ts');

const { runUptimeCycle, runNoLeadsCycle, PROBE_TARGETS, UPTIME_CRON, NO_LEADS_CRON } =
  (await import(pathToFileURL(modulePath).href)) as typeof import('../../workers/bot/monitor-run.ts');

const { UPTIME_STATE_KEY, NO_LEADS_STATE_KEY, UPTIME_CONSECUTIVE_FAILURES, NO_LEADS_MIN_ATTEMPTS } =
  (await import(pathToFileURL(path.join(botDir, 'monitor.ts')).href)) as typeof import('../../workers/bot/monitor.ts');

const TARGET = 'https://landingmn.pages.dev';
const TECH = '-1003333333333';
const TOKEN = '8100200300:TESTTESTTESTTESTTESTTESTTESTTESTTES';

const API = 'http://127.0.0.1:9099';
const T0 = Date.parse('2026-09-09T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

interface KvState {
  store: Map<string, unknown>;
  puts: { key: string; value: unknown }[];
}

function fakeKv(
  seed: Record<string, unknown> = {},
  options: { clock?: () => number } = {},
): {
  kv: Parameters<typeof runUptimeCycle>[0]['LEADS'];
  state: KvState;
} {
  const store = new Map<string, unknown>(Object.entries(seed));
  const puts: { key: string; value: unknown }[] = [];
  const lastWrite = new Map<string, number>();
  const kv = {
    get: (key: string, _type: 'json'): Promise<unknown> =>
      Promise.resolve(store.has(key) ? store.get(key) : null),
    put: (key: string, value: string): Promise<void> => {
      if (options.clock) {
        const at = options.clock();
        const last = lastWrite.get(key);
        if (last !== undefined && at - last < 1000) {
          return Promise.reject(new Error('KV 429: одна запись в ключ в секунду'));
        }
        lastWrite.set(key, at);
      }
      const parsed: unknown = JSON.parse(value);
      puts.push({ key, value: parsed });
      store.set(key, parsed);
      return Promise.resolve();
    },
    list: (options: { prefix: string }): Promise<{ keys: { name: string }[]; list_complete: boolean }> =>
      Promise.resolve({
        keys: [...store.keys()].filter((k) => k.startsWith(options.prefix)).map((name) => ({ name })),
        list_complete: true,
      }),
  };
  return { kv: kv as Parameters<typeof runUptimeCycle>[0]['LEADS'], state: { store, puts } };
}

interface NetOptions {

  siteUp: boolean;

  deliver: boolean;
}

function fakeNet(options: NetOptions) {
  const sent: string[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    if (url.includes('/sendMessage')) {
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      sent.push(String(body.text ?? ''));
      if (!options.deliver) {
        return new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: 'Too Many Requests: retry after 30',
            parameters: { retry_after: 30 },
          }),
          { status: 429 },
        );
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { status: 200 });
    }

    const target = PROBE_TARGETS.find((t) => url === `${TARGET}${t.path}`);
    assert.ok(target, `проба построена неверно: неизвестный адрес ${url}`);
    return new Response(null, { status: options.siteUp ? target.expected : 503 });
  };
  return { fetchImpl, sent };
}

function envOf(kv: ReturnType<typeof fakeKv>['kv'], over: Record<string, unknown> = {}) {
  return {
    LEADS: kv,
    MONITOR_TARGET_URL: TARGET,
    TG_TECH_CHAT_ID: TECH,
    TG_BOT_TOKEN: TOKEN,
    TG_API_BASE: API,
    ...over,
  } as Parameters<typeof runUptimeCycle>[0];
}

function depsOf(net: ReturnType<typeof fakeNet>, now: number) {
  return { fetchImpl: net.fetchImpl, now: () => now, sleep: async (): Promise<void> => undefined };
}

function uptimeState(state: KvState): { fails?: number; alerted?: boolean; since?: number | null } {
  return (state.store.get(UPTIME_STATE_KEY) ?? {}) as { fails?: number; alerted?: boolean };
}

test('АЛЕРТ: недоставленное сообщение НЕ помечает аварию объявленной', async () => {
  const { kv, state } = fakeKv();
  const net = fakeNet({ siteUp: false, deliver: false });

  await runUptimeCycle(envOf(kv), depsOf(net, T0));

  const second = await runUptimeCycle(envOf(kv), depsOf(net, T0 + 5 * 60 * 1000));

  assert.equal(second.decision, 'alert', 'проба построена неверно: порог не набран');
  assert.equal(net.sent.length, 1, 'проба построена неверно: сообщение не отправлялось');
  assert.equal(second.delivery?.ok, false, 'проба построена неверно: заглушка отдала успех');

  assert.equal(
    uptimeState(state).alerted,
    false,
    'АЛЕРТ-ПОТЕРЯН: в KV записано «отказ объявлен», хотя сообщение НЕ ДОЕХАЛО. Следующий цикл ' +
      'увидит этот признак и промолчит по построению — об аварии не узнает никто и никогда, ' +
      'а /admin/monitor будет утверждать обратное',
  );
  assert.equal(
    uptimeState(state).fails,
    UPTIME_CONSECUTIVE_FAILURES,
    'УЛИКА-ПОТЕРЯНА: счётчик неудачных циклов обязан расти независимо от доставки — ' +
      'иначе порог не наберётся никогда',
  );
  assert.equal(
    second.state.alerted,
    false,
    'АЛЕРТ-ПОТЕРЯН: цикл вернул состояние, которого нет в KV — по нему судит отчёт',
  );
});

test('АЛЕРТ: следующий цикл ПОВТОРЯЕТ попытку, пока сообщение не доехало', async () => {
  const { kv, state } = fakeKv();
  const failing = fakeNet({ siteUp: false, deliver: false });
  await runUptimeCycle(envOf(kv), depsOf(failing, T0));
  await runUptimeCycle(envOf(kv), depsOf(failing, T0 + 5 * 60 * 1000));

  const working = fakeNet({ siteUp: false, deliver: true });
  const third = await runUptimeCycle(envOf(kv), depsOf(working, T0 + 10 * 60 * 1000));

  assert.equal(
    third.decision,
    'alert',
    'АЛЕРТ-ПОТЕРЯН: цикл после НЕДОСТАВЛЕННОГО алерта промолчал. Условия отказа доставки и ' +
      'отказа сайта коррелированы (общий инцидент Cloudflare), то есть 429 приходит именно ' +
      'в ту минуту, когда алерт нужен',
  );
  assert.equal(working.sent.length, 1, 'АЛЕРТ-ПОТЕРЯН: повторной отправки не было');
  assert.equal(
    uptimeState(state).alerted,
    true,
    'ДВОЙНОЙ-АЛЕРТ: доехавшее сообщение обязано пометить аварию объявленной, иначе техчат ' +
      'получит её копию каждые пять минут',
  );
  assert.equal(
    uptimeState(state).since,
    T0,
    'УЛИКА-ПОТЕРЯНА: время начала отказа сдвинулось на цикл доставки, а не осталось настоящим',
  );
});

test('АЛЕРТ: при лимите KV «одна запись в ключ в секунду» пять циклов аварии дают ОДНУ тревогу', async () => {
  let modelNow = T0;
  const { kv } = fakeKv({}, { clock: () => modelNow });
  const net = fakeNet({ siteUp: false, deliver: true });
  for (let i = 0; i < 5; i++) {
    modelNow = T0 + i * 5 * 60 * 1000;
    await runUptimeCycle(envOf(kv), depsOf(net, modelNow));
  }
  assert.equal(
    net.sent.length,
    1,
    `ПОВТОР-ТРЕВОГИ: при настоящем лимите KV авария объявлена ${String(net.sent.length)} раз(а) вместо одного`,
  );
});

test('АЛЕРТ: доехавшее сообщение объявляет аварию РОВНО ОДИН раз', async () => {
  const { kv } = fakeKv();
  const net = fakeNet({ siteUp: false, deliver: true });
  await runUptimeCycle(envOf(kv), depsOf(net, T0));
  await runUptimeCycle(envOf(kv), depsOf(net, T0 + 5 * 60 * 1000));
  const third = await runUptimeCycle(envOf(kv), depsOf(net, T0 + 10 * 60 * 1000));

  assert.equal(third.decision, 'silent', 'ДВОЙНОЙ-АЛЕРТ: объявленная авария объявлена снова');
  assert.equal(net.sent.length, 1, `ДВОЙНОЙ-АЛЕРТ: отправлено ${String(net.sent.length)} сообщений вместо одного`);
});

test('АЛЕРТ: недоставленное «сайт снова отвечает» не стирает память об аварии', async () => {
  const { kv, state } = fakeKv();
  const down = fakeNet({ siteUp: false, deliver: true });
  await runUptimeCycle(envOf(kv), depsOf(down, T0));
  await runUptimeCycle(envOf(kv), depsOf(down, T0 + 5 * 60 * 1000));
  assert.equal(uptimeState(state).alerted, true, 'проба построена неверно: авария не объявлена');

  const upBroken = fakeNet({ siteUp: true, deliver: false });
  const recovered = await runUptimeCycle(envOf(kv), depsOf(upBroken, T0 + 10 * 60 * 1000));
  assert.equal(recovered.decision, 'recovered', 'проба построена неверно');
  assert.equal(
    uptimeState(state).alerted,
    true,
    'ВОЗВРАТ-ПОТЕРЯН: признак снят по НЕДОСТАВЛЕННОМУ сообщению — техчат остался с открытой ' +
      'аварией, о закрытии которой никто не узнает',
  );

  const upWorking = fakeNet({ siteUp: true, deliver: true });
  const again = await runUptimeCycle(envOf(kv), depsOf(upWorking, T0 + 15 * 60 * 1000));
  assert.equal(again.decision, 'recovered', 'ВОЗВРАТ-ПОТЕРЯН: повторной попытки не было');
  assert.equal(upWorking.sent.length, 1, 'ВОЗВРАТ-ПОТЕРЯН: сообщение о восстановлении не ушло');
  assert.equal(uptimeState(state).alerted, false, 'ДВОЙНОЙ-АЛЕРТ: после доставки признак не снят');
});

test('АЛЕРТ: «ноль лидов» не помечается объявленным по недоставленному сообщению', async () => {
  const bucket = new Date(T0).toISOString().slice(0, 13);
  const { kv, state } = fakeKv({ [`mon:attempt:${bucket}`]: NO_LEADS_MIN_ATTEMPTS });
  const net = fakeNet({ siteUp: true, deliver: false });

  const first = await runNoLeadsCycle(envOf(kv), depsOf(net, T0));
  assert.equal(first.decision, 'alert', 'проба построена неверно: порог попыток не набран');
  assert.equal(
    (state.store.get(NO_LEADS_STATE_KEY) as { alerted?: boolean } | undefined)?.alerted ?? false,
    false,
    'АЛЕРТ-ПОТЕРЯН: «ноль лидов» помечен объявленным по НЕдоехавшему сообщению. Здесь цена ' +
      'выше, чем у аптайма: признак снимает ТОЛЬКО доехавший лид, то есть ровно то событие, ' +
      'отсутствие которого мы и пытаемся сообщить — молчание стало бы вечным',
  );

  const working = fakeNet({ siteUp: true, deliver: true });
  const second = await runNoLeadsCycle(envOf(kv), depsOf(working, T0 + HOUR));
  assert.equal(second.decision, 'alert', 'АЛЕРТ-ПОТЕРЯН: следующий час не повторил попытку');
  assert.equal(
    (state.store.get(NO_LEADS_STATE_KEY) as { alerted?: boolean } | undefined)?.alerted,
    true,
    'ДВОЙНОЙ-АЛЕРТ: доехавшее сообщение не пометило тревогу объявленной',
  );
});

test('ПРИБОР: цикл без единой пробы НЕ засчитывается за исправный', async () => {
  assert.ok(
    PROBE_TARGETS.length > 0,
    'ПРИБОР-БЕЗ-ПРЕДМЕТА: таблица адресов проб пуста — монитор докладывал бы «ok», ' +
      'не проверив ничего',
  );

  const { kv, state } = fakeKv({
    [UPTIME_STATE_KEY]: { fails: 3, alerted: true, since: T0 - HOUR },
  });
  const net = fakeNet({ siteUp: true, deliver: true });

  const healthy = await runUptimeCycle(envOf(kv), depsOf(net, T0));
  if (healthy.ran) {
    assert.ok(
      healthy.probes.length > 0,
      'ПРИБОР-БЕЗ-ПРЕДМЕТА: цикл доложил о состоявшемся замере, не сделав НИ ОДНОЙ пробы. ' +
        '`cycleFailed([])` возвращает false, значит такой цикл прошёл бы как УСПЕШНЫЙ: обнулил ' +
        'бы счётчик неудач, снял бы признак объявленного отказа и записал бы пустой снимок',
    );
  }

  const blind = await runUptimeCycle(envOf(kv, { MONITOR_TARGET_URL: '' }), depsOf(net, T0 + HOUR));
  assert.equal(blind.ran, false, 'ПРИБОР-БЕЗ-ПРЕДМЕТА: цикл без предмета измерения объявлен состоявшимся');
  assert.equal(blind.decision, 'silent', 'ПРИБОР-БЕЗ-ПРЕДМЕТА: цикл без проб принял решение');
  assert.equal(
    (state.store.get(UPTIME_STATE_KEY) as { alerted?: boolean } | undefined)?.alerted,
    false,
    'проба построена неверно: исправный цикл выше обязан был снять признак',
  );
});

test('ОКНО-ТЕКСТА: сообщение «ноль лидов» называет ИЗМЕРЕННУЮ границу, а не круглое число часов', async () => {
  const bucket = new Date(T0).toISOString().slice(0, 13);
  const { kv } = fakeKv({ [`mon:attempt:${bucket}`]: NO_LEADS_MIN_ATTEMPTS });
  const net = fakeNet({ siteUp: true, deliver: true });
  await runNoLeadsCycle(envOf(kv), depsOf(net, T0));

  const text = net.sent[0] ?? '';
  assert.ok(text.includes('часовых ведра'), `ОКНО-ТЕКСТА-ВРЁТ: в сообщении нет границы окна:\n${text}`);
  assert.ok(
    text.includes(bucket),
    `ОКНО-ТЕКСТА-ВРЁТ: в сообщении нет самого свежего ведра ${bucket}. Оператор пойдёт искать ` +
      `событие «за последние часы» и не найдёт его на границе:\n${text}`,
  );
  assert.ok(
    text.includes('неполно'),
    'ОКНО-ТЕКСТА-ВРЁТ: сообщение не говорит, что самое свежее ведро на момент проверки ' +
      'только началось — а часовой крон запускается ровно в начале часа',
  );
  console.log(` [замер] строка окна: ${(text.split('\n')[1] ?? '').slice(0, 160)}`);
});

test('РАСПИСАНИЕ: выражения двух кронов различны — иначе часовой цикл не запустился бы никогда', () => {
  assert.notEqual(
    UPTIME_CRON,
    NO_LEADS_CRON,
    'РАСПИСАНИЕ-СЛИЛОСЬ: разветвление в index.ts идёт по строке `event.cron`, и одинаковые ' +
      'выражения означали бы, что часовая проба навсегда уходит в ветку пятиминутной',
  );
});
