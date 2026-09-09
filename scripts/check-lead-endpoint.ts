
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { rmSync } from 'node:fs';
import path from 'node:path';
import {
  checkBuildFreshness,
  freshnessGuardMessage,
  occupiedPorts,
  portFree,
  portGuardMessage,
} from './lib/preflight.ts';
import {
  ATTRIBUTION_FIELD,
  ERROR_CODES,
  FIELDS,
  HONEYPOT_FIELD,
  LEAD_KEY_PREFIX,
  LEAD_TTL_SECONDS,
  RATE_LIMIT_MAX,
  SUCCESS_ROUTE,
  TURNSTILE_TOKEN_FIELD,
} from '../src/lib/lead-contract.ts';

const projectRoot = path.resolve(import.meta.dirname, '..');

const RUNTIME_PORT = 8788;

const SECRET_ALWAYS_PASS = '1x0000000000000000000000000000000AA';
const SECRET_ALWAYS_FAIL = '2x0000000000000000000000000000000AA';

const FAKE_BOT_TOKEN = '000000:GATE-FAKE-BOT-TOKEN-NOT-A-REAL-ONE';
const FAKE_CHAT_ID = '-1009999999999';
const FAKE_TECH_CHAT_ID = '-1008888888888';
const FAKE_CONTACT_URL = 'https://t.me/gate_fake_manager';

const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

const LEAD_NAME = 'Батбаяр Ө<&>Ү';

const LEAD_NAME_ESCAPED = 'Батбаяр Ө&lt;&amp;&gt;Ү';

const REQUEST_TIMEOUT_MS = 30_000;

const M_200 = 'ОЖИДАЛСЯ 200';
const M_303 = 'ОЖИДАЛСЯ 303';
const M_400 = 'ОЖИДАЛСЯ 400';
const M_403 = 'ОЖИДАЛСЯ 403';
const M_405 = 'ОЖИДАЛСЯ 405';
const M_422 = 'ОЖИДАЛСЯ 422';
const M_429 = 'ОЖИДАЛСЯ 429';
const M_JOURNAL_SHORT = 'ЖУРНАЛ НЕ ПОПОЛНИЛСЯ';
const M_JOURNAL_EXTRA = 'ЖУРНАЛ ПОПОЛНИЛСЯ ЛИШНИМ';
const M_METADATA = 'МЕТАДАННЫЕ НЕ СОШЛИСЬ';
const M_TTL = 'ОЖИДАЛСЯ TTL';
const M_STUB = 'ЗАГЛУШКА НЕ ПОЛУЧИЛА';
const M_LEAK = 'БОЕВЫЕ ЗНАЧЕНИЯ ПРОСОЧИЛИСЬ';
const M_ORPHAN = 'ОСИРОТЕВШИЙ СЕРВЕР';

const IP = {
  case1: '203.0.113.11',
  honeypot: '203.0.113.12',
  burst: '203.0.113.13',
  freshBurst: '203.0.113.14',
  noToken: '203.0.113.15',
  noConsent: '203.0.113.16',
  badDirection: '203.0.113.17',
  hugeBody: '203.0.113.18',
  getMethod: '203.0.113.19',
  bareForm: '203.0.113.20',
  alwaysFail: '203.0.113.21',
} as const;

function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`FAIL: у аргумента --${name} нет значения.`);
    process.exit(1);
  }
  return value;
}

const externalBase = argValue('base');

interface CaseResult {
  n: number;
  title: string;
  problems: string[];
  skipped?: string;
}

const results: CaseResult[] = [];

function openCase(n: number, title: string): CaseResult {
  const result: CaseResult = { n, title, problems: [] };
  results.push(result);
  return result;
}

interface StubHit {
  url: string;
  body: string;
}

interface TelegramStub {
  readonly port: number;
  readonly hits: StubHit[];
  close(): Promise<void>;
}

async function startTelegramStub(): Promise<TelegramStub> {
  const hits: StubHit[] = [];
  let messageId = 0;

  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      hits.push({ url: req.url ?? '', body });
      messageId += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: messageId } }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('заглушка Telegram не отдала номер порта');
  }

  return {
    port: address.port,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

interface Runtime {
  readonly base: string;
  readonly startedInMs: number;
  stop(): Promise<void>;
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {

    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

async function waitPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await portFree(port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function startRuntime(turnstileSecret: string, stubPort: number): Promise<Runtime> {
  const wrangler = path.join(projectRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const args = [
    wrangler,
    'pages',
    'dev',
    'dist',
    '--kv',
    'LEADS',
    '--port',
    String(RUNTIME_PORT),
    ...bindingFlags(turnstileSecret, stubPort),
  ];

  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  let log = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    log += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    log += chunk;
  });

  const base = `http://127.0.0.1:${RUNTIME_PORT}`;
  const startedAt = Date.now();
  const deadline = startedAt + 90_000;

  const stop = async (): Promise<void> => {
    killTree(child);
    if (!(await waitPortFree(RUNTIME_PORT, 20_000))) {
      throw new Error(
        `FAIL: ${M_ORPHAN} — порт ${RUNTIME_PORT} отвечает после гашения дерева процессов.\n` +
          '      Осиротевший `wrangler pages dev` обслужит следующий прогон по СТАРОЙ сборке\n' +
          '      и отчитается зелёным. Убить вручную и повторить.',
      );
    }
  };

  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(
        `FAIL: рантайм завершился с кодом ${child.exitCode} до готовности.\n${tail(log)}`,
      );
    }
    try {
      const probe = await fetch(`${base}/api/lead`, {
        method: 'GET',
        signal: AbortSignal.timeout(5_000),
      });
      if (probe.status === 405) break;
    } catch {
      /* */
    }
    if (Date.now() > deadline) {
      killTree(child);
      await waitPortFree(RUNTIME_PORT, 10_000);
      throw new Error(`FAIL: рантайм не ответил 405 на GET /api/lead за 90 с.\n${tail(log)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return { base, startedInMs: Date.now() - startedAt, stop };
}

function bindingFlags(turnstileSecret: string, stubPort: number): string[] {
  const bindings: Record<string, string> = {
    TG_BOT_TOKEN: FAKE_BOT_TOKEN,
    TG_CHAT_ID: FAKE_CHAT_ID,
    TG_TECH_CHAT_ID: FAKE_TECH_CHAT_ID,
    TG_API_BASE: `http://127.0.0.1:${stubPort}`,
    TURNSTILE_SECRET_KEY: turnstileSecret,
    PUBLIC_TG_CONTACT_URL: FAKE_CONTACT_URL,
  };
  return Object.entries(bindings).flatMap(([key, value]) => ['--binding', `${key}=${value}`]);
}

function tail(text: string, lines = 20): string {
  return text.split('\n').slice(-lines).join('\n');
}

interface Answer {
  status: number;
  text: string;
  location: string | null;
  retryAfter: string | null;
  allow: string | null;
  ms: number;
}

interface Ask {
  base: string;
  method?: 'GET' | 'POST';
  ip?: string;
  accept?: string | null;
  contentType?: string;
  body?: string;
}

async function ask({ base, method = 'POST', ip, accept = 'application/json', contentType = 'application/json', body }: Ask): Promise<Answer> {
  const headers: Record<string, string> = {};
  if (ip !== undefined) headers['CF-Connecting-IP'] = ip;
  if (accept !== null) headers.accept = accept;
  if (method === 'POST') headers['content-type'] = contentType;

  const startedAt = Date.now();
  const response = await fetch(`${base}/api/lead`, {
    method,
    headers,
    body: method === 'POST' ? body : undefined,

    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    location: response.headers.get('location'),
    retryAfter: response.headers.get('retry-after'),
    allow: response.headers.get('allow'),
    ms: Date.now() - startedAt,
  };
}

function leadBody(marker: string, over: Record<string, string | null> = {}): string {
  const values: Record<string, string> = {
    [FIELDS.name]: LEAD_NAME,
    [FIELDS.contact]: '99112233',
    [FIELDS.contactChannel]: 'phone',
    [FIELDS.direction]: 'teamcash',
    [FIELDS.consent]: 'on',
    [FIELDS.lang]: 'ru',
    [TURNSTILE_TOKEN_FIELD]: DUMMY_TOKEN,
    [ATTRIBUTION_FIELD]: JSON.stringify({
      source: marker,
      campaign: 'gate',
      medium: 'cli',
      lastSource: '',
      touches: 1,
    }),
  };
  for (const [key, value] of Object.entries(over)) {
    if (value === null) delete values[key];
    else values[key] = value;
  }
  return JSON.stringify(values);
}

function asJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function expectStatus(c: CaseResult, answer: Answer, expected: number, marker: string, what: string): boolean {
  if (answer.status === expected) return true;
  c.problems.push(`${marker}: ${what} вернул ${answer.status}`);
  return false;
}

function expectErrorCode(c: CaseResult, answer: Answer, code: string): void {
  const body = asJson(answer.text);
  if (body === null || body.error !== code) {
    c.problems.push(`код ответа не «${code}»: ${answer.text.slice(0, 120)}`);
  }
}

interface JournalEntry {
  name: string;
  expiration?: number;
  metadata?: {
    direction?: string;
    source?: string;
    lang?: string;
    channel?: string;
    host?: string;
    delivered?: boolean;
  };
}

function listJournal(): JournalEntry[] {
  const wrangler = path.join(projectRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const res = spawnSync(
    process.execPath,
    [wrangler, 'kv', 'key', 'list', '--namespace-id', 'LEADS', '--local', '--prefix', LEAD_KEY_PREFIX],
    { cwd: projectRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (res.error) throw new Error(`не удалось прочитать журнал KV: ${res.error.message}`);
  const text = res.stdout ?? '';
  const at = text.indexOf('[');
  if (at === -1) throw new Error(`ответ \`kv key list\` не похож на JSON:\n${tail(text)}`);
  const parsed: unknown = JSON.parse(text.slice(at));
  if (!Array.isArray(parsed)) throw new Error('`kv key list` вернул не массив');
  return parsed as JournalEntry[];
}

function entriesWith(entries: JournalEntry[], marker: string): JournalEntry[] {
  return entries.filter((entry) => entry.metadata?.source === marker);
}

function expectJournal(c: CaseResult, entries: JournalEntry[], marker: string, expected: number): JournalEntry[] {
  const mine = entriesWith(entries, marker);
  if (mine.length < expected) {
    c.problems.push(`${M_JOURNAL_SHORT}: записей с меткой «${marker}» ${mine.length}, ожидалось ${expected}`);
  } else if (mine.length > expected) {
    c.problems.push(`${M_JOURNAL_EXTRA}: записей с меткой «${marker}» ${mine.length}, ожидалось ${expected}`);
  }
  return mine;
}

function resetCacheState(): void {
  rmSync(path.join(projectRoot, '.wrangler', 'state', 'v3', 'cache'), {
    recursive: true,
    force: true,
  });
}

interface PassContext {
  base: string;
  stub: TelegramStub | null;
  runId: string;
}

async function passA(ctx: PassContext): Promise<Answer | null> {
  const { base, runId } = ctx;
  const mark = (name: string): string => `${runId}-${name}`;
  const hitsBefore = (): number => ctx.stub?.hits.length ?? 0;

  const c1 = openCase(1, 'валидный POST (клиент с fetch): 200, запись в журнале, доставка ушла в заглушку');
  const before1 = hitsBefore();
  const a1 = await ask({ base, ip: IP.case1, body: leadBody(mark('c1')) });
  if (expectStatus(c1, a1, 200, M_200, 'валидный POST')) {
    const body = asJson(a1.text);
    if (body?.ok !== true) c1.problems.push(`тело успеха не «{"ok":true}»: ${a1.text.slice(0, 120)}`);
  }
  if (ctx.stub !== null) {
    const fresh = ctx.stub.hits.slice(before1);
    if (fresh.length !== 1) {
      c1.problems.push(
        `${M_STUB}: попыток доставки ${fresh.length}, ожидалась 1. ` +
          'Ноль означает, что `TG_API_BASE` не доехал до рантайма — то есть запрос ушёл в НАСТОЯЩИЙ Telegram.',
      );
    } else {
      const hit = fresh[0] as StubHit;

      if (hit.url !== `/bot${FAKE_BOT_TOKEN}/sendMessage`) {
        c1.problems.push(
          `${M_LEAK}: путь запроса к заглушке не совпал с подставленным токеном. ` +
            'Значение не печатается намеренно — при утечке это боевой токен бота.',
        );
      }
      const payload = asJson(hit.body);
      if (payload === null) {
        c1.problems.push('заглушка получила не-JSON вместо payload `sendMessage`');
      } else {
        if (payload.chat_id !== FAKE_CHAT_ID) {
          c1.problems.push(
            `${M_LEAK}: chat_id доставки не равен подставленному. ` +
              'Значение не печатается намеренно — при утечке это боевой чат менеджеров.',
          );
        }
        if (payload.parse_mode !== 'HTML') c1.problems.push(`parse_mode доставки: ${String(payload.parse_mode)}`);
        const text = typeof payload.text === 'string' ? payload.text : '';
        if (!text.includes(LEAD_NAME_ESCAPED)) {
          c1.problems.push(`в тексте нет экранированного имени «${LEAD_NAME_ESCAPED}»`);
        }
      }
    }
  } else {
    c1.skipped = 'проверки заглушки пропущены (--base)';
  }

  const c2 = openCase(2, 'приманка заполнена: ответ неотличим от успеха, в журнале пусто, доставки нет');
  const before2 = hitsBefore();
  const a2 = await ask({
    base,
    ip: IP.honeypot,
    body: leadBody(mark('c2'), { [HONEYPOT_FIELD]: 'https://spam.example' }),
  });
  if (expectStatus(c2, a2, 200, M_200, 'POST с заполненной приманкой')) {
    const body = asJson(a2.text);
    if (body?.ok !== true) c2.problems.push('тело ответа на приманку отличается от тела успеха');
  }
  if (ctx.stub !== null && ctx.stub.hits.length !== before2) {
    c2.problems.push(`приманка вызвала ${ctx.stub.hits.length - before2} попыт(ку/ки) доставки — ожидалось 0`);
  }

  const c3 = openCase(3, `${RATE_LIMIT_MAX + 1} быстрых POST с одного адреса: последний получает 429 с Retry-After`);
  const burst: Answer[] = [];
  for (let i = 0; i < RATE_LIMIT_MAX + 1; i++) {
    burst.push(await ask({ base, ip: IP.burst, body: leadBody(mark('c3')) }));
  }
  burst.slice(0, RATE_LIMIT_MAX).forEach((answer, i) => {
    expectStatus(c3, answer, 200, M_200, `запрос ${i + 1} из ${RATE_LIMIT_MAX + 1}`);
  });
  const last = burst[RATE_LIMIT_MAX] as Answer;
  if (expectStatus(c3, last, 429, M_429, `запрос ${RATE_LIMIT_MAX + 1} с того же адреса`)) {
    expectErrorCode(c3, last, ERROR_CODES.rateLimited);
    const seconds = Number(last.retryAfter);
    if (!Number.isFinite(seconds) || seconds < 1) {
      c3.problems.push(`Retry-After отсутствует или не число: ${String(last.retryAfter)}`);
    }
  }

  const c4 = openCase(4, `${RATE_LIMIT_MAX} POST с ДРУГОГО адреса проходят, а исчерпанный адрес всё ещё отбивается`);
  for (let i = 0; i < RATE_LIMIT_MAX; i++) {
    const answer = await ask({ base, ip: IP.freshBurst, body: leadBody(mark('c4')) });
    expectStatus(c4, answer, 200, M_200, `запрос ${i + 1} с нового адреса`);
  }
  const control = await ask({ base, ip: IP.burst, body: leadBody(mark('c4ctl')) });
  if (expectStatus(c4, control, 429, M_429, 'контрольный запрос с исчерпанного адреса')) {
    expectErrorCode(c4, control, ERROR_CODES.rateLimited);
  }

  const c6 = openCase(6, 'поле токена не отправлено вовсе: siteverify отвечает missing-input-response, эндпоинт — 403');
  const a6 = await ask({ base, ip: IP.noToken, body: leadBody(mark('c6'), { [TURNSTILE_TOKEN_FIELD]: null }) });
  if (expectStatus(c6, a6, 403, M_403, 'POST без поля токена')) {
    expectErrorCode(c6, a6, ERROR_CODES.captchaFailed);
  }

  const c7 = openCase(7, 'согласие не отправлено: 422 со списком полей');
  const a7 = await ask({ base, ip: IP.noConsent, body: leadBody(mark('c7'), { [FIELDS.consent]: null }) });
  if (expectStatus(c7, a7, 422, M_422, 'POST без согласия')) {
    expectErrorCode(c7, a7, ERROR_CODES.validationFailed);
    const fields = asJson(a7.text)?.fields;
    if (!Array.isArray(fields) || !fields.includes(FIELDS.consent)) {
      c7.problems.push(`в списке полей нет «${FIELDS.consent}»: ${a7.text.slice(0, 120)}`);
    }
  }

  const c8 = openCase(8, 'направление вне перечисления: 422 со списком полей');
  const a8 = await ask({ base, ip: IP.badDirection, body: leadBody(mark('c8'), { [FIELDS.direction]: 'nonsense' }) });
  if (expectStatus(c8, a8, 422, M_422, 'POST с неизвестным направлением')) {
    expectErrorCode(c8, a8, ERROR_CODES.validationFailed);
    const fields = asJson(a8.text)?.fields;
    if (!Array.isArray(fields) || !fields.includes(FIELDS.direction)) {
      c8.problems.push(`в списке полей нет «${FIELDS.direction}»: ${a8.text.slice(0, 120)}`);
    }
  }

  const c9 = openCase(9, 'тело в мегабайт: 400 до разбора');
  const huge = JSON.stringify({ [FIELDS.name]: 'x'.repeat(1024 * 1024) });
  const a9 = await ask({ base, ip: IP.hugeBody, body: huge });
  if (expectStatus(c9, a9, 400, M_400, 'POST с телом в мегабайт')) {
    expectErrorCode(c9, a9, ERROR_CODES.bodyTooLarge);
  }

  const c10 = openCase(10, 'GET на /api/lead: 405 и заголовок Allow');
  const a10 = await ask({ base, method: 'GET', ip: IP.getMethod });
  if (expectStatus(c10, a10, 405, M_405, 'GET')) {
    expectErrorCode(c10, a10, ERROR_CODES.methodNotAllowed);
    if (a10.allow !== 'POST') c10.problems.push(`Allow: ${String(a10.allow)}`);
  }

  const c11 = openCase(11, 'клиент без Accept: application/json получает 303 на локализованный путь, а не JSON');
  const a11 = await ask({ base, ip: IP.bareForm, accept: null, body: leadBody(mark('c11')) });
  if (expectStatus(c11, a11, 303, M_303, 'POST без Accept: application/json')) {
    if (a11.location !== SUCCESS_ROUTE.ru) {
      c11.problems.push(`Location: ${String(a11.location)}, ожидался ${SUCCESS_ROUTE.ru}`);
    }
    if (a11.text.trim() !== '') c11.problems.push('у 303 непустое тело');
  }

  return a6;
}

async function passB(ctx: PassContext): Promise<void> {
  const c5 = openCase(5, 'секрет 2x…AA (всегда отказ): 403 captcha_failed, в журнале ничего');
  const before = ctx.stub?.hits.length ?? 0;
  const a5 = await ask({ base: ctx.base, ip: IP.alwaysFail, body: leadBody(`${ctx.runId}-c5`) });
  if (expectStatus(c5, a5, 403, M_403, 'POST при always-fail секрете')) {
    expectErrorCode(c5, a5, ERROR_CODES.captchaFailed);
  }

  if (/invalid-input|missing-input|secret/i.test(a5.text)) {
    c5.problems.push('в ответе посетителю видны внутренности siteverify');
  }
  if (ctx.stub !== null && ctx.stub.hits.length !== before) {
    c5.problems.push('отклонённая по Turnstile заявка вызвала попытку доставки');
  }
}

interface Measurements {
  runtimeStartA?: number;
  runtimeStartB?: number;
  siteverifyMs?: number;
  case1Metadata?: JournalEntry;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const runId = `gate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const measured: Measurements = {};

  if (externalBase !== undefined) {
    console.log('--- Драйвер /api/lead: режим --base ---\n');
    console.log(`Матрица идёт против ${externalBase}; рантайм и заглушка не поднимаются.`);
    console.log('Проверки журнала KV и попыток доставки в этом режиме ПРОПУСКАЮТСЯ:');
    console.log('проверять нечего и некому. Режим существует ради случая саботажа.\n');

    const ctx: PassContext = { base: externalBase, stub: null, runId };
    await passA(ctx);
    await passB(ctx);
    report(startedAt, measured);
    return;
  }

  const freshness = checkBuildFreshness(projectRoot);
  if (!freshness.fresh) {
    console.error(freshnessGuardMessage(freshness));
    process.exit(1);
  }

  const occupied = await occupiedPorts([RUNTIME_PORT]);
  if (occupied.length > 0) {
    console.error(portGuardMessage(occupied));
    process.exit(1);
  }

  resetCacheState();
  const journalBefore = listJournal();

  console.log('--- Драйвер /api/lead: 12 случаев против настоящего рантайма ---\n');
  console.log(`Метка прогона: ${runId}`);
  console.log(`Журнал до прогона: ${journalBefore.length} запис(ь/и) с префиксом «${LEAD_KEY_PREFIX}»\n`);

  const stub = await startTelegramStub();
  let runtime: Runtime | null = null;

  try {

    runtime = await startRuntime(SECRET_ALWAYS_PASS, stub.port);
    measured.runtimeStartA = runtime.startedInMs;
    const ctxA: PassContext = { base: runtime.base, stub, runId };
    const siteverifyProbe = await passA(ctxA);
    measured.siteverifyMs = siteverifyProbe?.ms;
    await runtime.stop();
    runtime = null;

    runtime = await startRuntime(SECRET_ALWAYS_FAIL, stub.port);
    measured.runtimeStartB = runtime.startedInMs;
    await passB({ base: runtime.base, stub, runId });
    await runtime.stop();
    runtime = null;
  } finally {

    if (runtime !== null) {
      try {
        await runtime.stop();
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
      }
    }
    await stub.close();
  }

  const journalAfter = listJournal();
  const mark = (name: string): string => `${runId}-${name}`;

  const byCase: Record<number, [string, number][]> = {
    1: [[mark('c1'), 1]],
    2: [[mark('c2'), 0]],
    3: [[mark('c3'), RATE_LIMIT_MAX]],
    4: [
      [mark('c4'), RATE_LIMIT_MAX],
      [mark('c4ctl'), 0],
    ],
    5: [[mark('c5'), 0]],
    6: [[mark('c6'), 0]],
    7: [[mark('c7'), 0]],
    8: [[mark('c8'), 0]],
    9: [[mark('c9'), 0]],
    10: [[mark('c10'), 0]],
    11: [[mark('c11'), 1]],
  };

  let expectedTotal = 0;
  for (const result of results) {
    for (const [marker, expected] of byCase[result.n] ?? []) {
      expectedTotal += expected;
      const mine = expectJournal(result, journalAfter, marker, expected);
      if (result.n === 1 && mine.length === 1) {
        const entry = mine[0] as JournalEntry;
        measured.case1Metadata = entry;
        const meta = entry.metadata ?? {};
        const expectedMeta: Record<string, string> = {
          direction: 'teamcash',
          lang: 'ru',
          channel: 'phone',
          host: `127.0.0.1:${RUNTIME_PORT}`,
        };
        for (const [key, value] of Object.entries(expectedMeta)) {
          const actual = (meta as Record<string, unknown>)[key];
          if (actual !== value) {
            result.problems.push(`${M_METADATA}: metadata.${key} = ${String(actual)}, ожидалось ${value}`);
          }
        }
        if (!entry.name.startsWith(LEAD_KEY_PREFIX)) {
          result.problems.push(`${M_METADATA}: ключ «${entry.name}» не по форме контракта`);
        }
      }
    }
  }

  const c12 = openCase(12, `срок хранения записи равен LEAD_TTL_SECONDS (${LEAD_TTL_SECONDS} с)`);
  const entry = measured.case1Metadata;
  if (entry === undefined) {
    c12.problems.push(`${M_TTL}: записи случая 1 нет, проверять нечего`);
  } else {
    const iso = entry.name.slice(LEAD_KEY_PREFIX.length, entry.name.lastIndexOf(':'));
    const writtenSec = Math.floor(Date.parse(iso) / 1000);
    const expiration = entry.expiration ?? 0;
    const delta = expiration - writtenSec;
    if (!Number.isFinite(delta) || delta < LEAD_TTL_SECONDS || delta > LEAD_TTL_SECONDS + 120) {
      c12.problems.push(`${M_TTL}: срок жизни записи ${delta} с, ожидалось ${LEAD_TTL_SECONDS} с (+ до 120 с на пометку доставки)`);
    }
  }

  const grew = journalAfter.length - journalBefore.length;
  if (grew !== expectedTotal) {
    const c = openCase(0, 'баланс журнала: прирост равен сумме ожиданий по случаям');
    c.problems.push(
      `${grew > expectedTotal ? M_JOURNAL_EXTRA : M_JOURNAL_SHORT}: журнал вырос на ${grew}, ожидалось ${expectedTotal}`,
    );
  }

  if (stub.hits.some((hit) => hit.url !== `/bot${FAKE_BOT_TOKEN}/sendMessage`)) {
    const c = openCase(0, 'все попытки доставки ушли на подставленный токен');
    c.problems.push(`${M_LEAK}: часть запросов к заглушке пришла не на подставленный путь (значение не печатается).`);
  }

  console.log(`Журнал после прогона: ${journalAfter.length} (+${grew}), попыток доставки в заглушку: ${stub.hits.length}\n`);
  report(startedAt, measured);
}

function report(startedAt: number, measured: Measurements): void {
  const ordered = [...results].sort((a, b) => a.n - b.n);
  for (const result of ordered) {
    const label = result.n === 0 ? '  ' : String(result.n).padStart(2, ' ');
    console.log(`${result.problems.length === 0 ? 'OK  ' : 'FAIL'}  ${label}  ${result.title}`);
    if (result.skipped !== undefined) console.log(`          ~ ${result.skipped}`);
    for (const problem of result.problems) console.log(`          ${problem}`);
  }

  const failed = ordered.filter((r) => r.problems.length > 0);
  const numbered = ordered.filter((r) => r.n > 0);
  console.log('');
  if (measured.runtimeStartA !== undefined) {
    console.log(`Старт рантайма: проход А ${measured.runtimeStartA} мс, проход Б ${measured.runtimeStartB ?? 0} мс`);
  }
  if (measured.siteverifyMs !== undefined) {
    console.log(`Ответ с отказом от живого siteverify (случай 6): ${measured.siteverifyMs} мс`);
  }
  if (measured.case1Metadata !== undefined) {
    console.log(`Запись случая 1: ${JSON.stringify(measured.case1Metadata)}`);
  }
  console.log(`Полный прогон: ${((Date.now() - startedAt) / 1000).toFixed(1)} с`);
  console.log(`Итог: ${numbered.length - failed.filter((r) => r.n > 0).length}/${numbered.length} случаев пройдено.`);

  if (failed.length > 0) {
    console.error(
      `\nFAIL: не пройдено случаев — ${failed.length}: ${failed.map((r) => (r.n === 0 ? 'баланс' : `№${r.n}`)).join(', ')}.`,
    );
    process.exit(1);
  }
  console.log('PASS: эндпоинт ведёт себя по контракту против настоящего рантайма.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
