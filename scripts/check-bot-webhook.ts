
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { occupiedPorts, portFree, portGuardMessage } from './lib/preflight.ts';
import { DIRECTIONS, LOCALES, encodeStart } from '../src/lib/start-codec.ts';
import type { Direction, Locale } from '../src/lib/start-codec.ts';
import {
  WEBHOOK_BODY_MAX_BYTES,
  WEBHOOK_PATH,
  WEBHOOK_SECRET_HEADER,
} from '../workers/bot/webhook.ts';
import { ADMIN_TOKEN_HEADER } from '../workers/bot/admin.ts';

const projectRoot = path.resolve(import.meta.dirname, '..');

const RUNTIME_PORT = 8789;

const FAKE = {
  botToken: '000000:GATE-FAKE-BOT-TOKEN-FOR-WORKER-DRIVER',
  chatId: '-1009999999901',
  techChatId: '-1008888888802',
  webhookSecret: 'gate-fake-webhook-secret-0123456789ab',
  adminToken: 'gate-fake-admin-token-0123456789ab',
  managerUrl: 'https://t.me/gate_fake_manager',
} as const;

const DECOY = {
  TG_BOT_TOKEN: '111111:GATE-DECOY-TOKEN-FROM-DEV-VARS-FILE',
  TG_CHAT_ID: '-1007777777703',
  TG_TECH_CHAT_ID: '-1006666666604',
  TG_WEBHOOK_SECRET: 'gate-decoy-webhook-secret-from-file01',
  BOT_ADMIN_TOKEN: 'gate-decoy-admin-token-from-file01',
  MANAGER_CONTACT_URL: 'https://t.me/gate_decoy_manager',
  TG_API_BASE: 'http://127.0.0.1:9',
} as const;

const GROUP_CHAT_ID = -1002000000013;

const REQUEST_TIMEOUT_MS = 30_000;

const ROUND_TRIP_MAX_MS = 4_000;

const WAIT_UNTIL_TIMEOUT_MS = 25_000;

const M_ENV = 'ПОДСТАНОВКА ОКРУЖЕНИЯ НЕ ДОЕХАЛА';
const M_FOREIGN_SECRET = 'ВЕБХУК ПРИНЯЛ ЧУЖОЙ СЕКРЕТ';
const M_TAG_LOST = 'МЕТКА ПОТЕРЯНА';
const M_REPEAT_DUP = 'ПОВТОР ОПУБЛИКОВАН ДУБЛЕМ';
const M_SILENCE = 'ТРЕТЬЕ ОБРАЩЕНИЕ НЕ ПРОМОЛЧАЛО';
const M_GROUP = 'ГРУППОВОЙ АПДЕЙТ ОБСЛУЖЕН';
const M_REDELIVERY = 'ПОВТОРНАЯ ДОСТАВКА ПРОШЛА КОНВЕЙЕР';
const M_WINDOW_MOVED = 'ОКНО ОХЛАЖДЕНИЯ СДВИНУТО РЕТРАЕМ';
const M_NOT_INERT = 'ВОРКЕР НЕ ИНЕРТЕН БЕЗ ОБЯЗАТЕЛЬНОГО ВХОДА';
const M_ADMIN_OPEN = 'АДМИНКА ОТКРЫТА БЕЗ ТОКЕНА';
const M_ALERT = 'АЛЕРТ В ТЕХЧАТ НЕ УШЁЛ';

const M_REPLY_OUTCOME = 'ИСХОД ОТВЕТА ПОСЕТИТЕЛЮ НЕ ПРОВЕРЕН';
const M_STUB_SHORT = 'ЗАГЛУШКА НЕ ПОЛУЧИЛА';
const M_STUB_EXTRA = 'ЗАГЛУШКА ПОЛУЧИЛА ЛИШНЕЕ';
const M_OUTBOUND = 'ЗАПРОС УШЁЛ НЕ К ЗАГЛУШКЕ';
const M_ORPHAN = 'ОСИРОТЕВШИЙ СЕРВЕР';
const M_STATUS = 'ОЖИДАЛСЯ КОД';

const EXPECTED_DIRECTION_TEXT = {
  affiliate: 'Affiliate',
  bank: 'Bank Transfer',
  teamcash: 'Team Cash',
  none: 'не выбрано',
} satisfies Record<Direction, string>;

const EXPECTED_DIRECT_SOURCE = 'прямой заход';

const EXPECTED_LEAD_HEAD = 'Лид из бота';
const EXPECTED_REPEAT_HEAD = 'Повторный лид';
const EXPECTED_ALERT_HEAD = 'Лид не доставлен';

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

const configArg = argValue('config') ?? path.join('workers', 'bot', 'wrangler.jsonc');
const configPath = path.resolve(projectRoot, configArg);
const configDir = path.dirname(configPath);
const configLabel = path.relative(projectRoot, configPath).replace(/\\/g, '/');

interface CaseResult {
  n: number;
  title: string;
  problems: string[];
  notes: string[];
}

const results: CaseResult[] = [];

function openCase(n: number, title: string): CaseResult {
  const result: CaseResult = { n, title, problems: [], notes: [] };
  results.push(result);
  return result;
}

function witness(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

interface StubHit {
  method: string;
  chatId: string;
  text: string;
  parseMode: string;
  hasMarkup: boolean;
  at: number;
}

interface TelegramStub {
  readonly port: number;
  readonly hits: StubHit[];

  readonly breaches: string[];

  allow(chatId: string): void;

  refuse: { chatId: string; code: 403 | 429 } | null;
  close(): Promise<void>;
}

async function startTelegramStub(): Promise<TelegramStub> {
  const hits: StubHit[] = [];
  const breaches: string[] = [];
  const allowed = new Set<string>([FAKE.chatId, FAKE.techChatId]);
  let messageId = 0;
  let refuse: { chatId: string; code: 403 | 429 } | null = null;

  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      const url = req.url ?? '';
      const match = /^\/bot(.*)\/([A-Za-z]+)$/.exec(url);
      const token = match?.[1] ?? '';
      const method = match?.[2] ?? `(путь не разобран: ${url.length} симв.)`;

      if (token !== FAKE.botToken) {
        breaches.push(
          `${M_ENV}: токен в пути к заглушке не равен подставленному ` +
            `(ожидался длиной ${FAKE.botToken.length}, sha256:${witness(FAKE.botToken)}; ` +
            `пришёл длиной ${token.length}, sha256:${witness(token)}). ` +
            'Само значение не печатается намеренно.',
        );
      }

      let parsed: Record<string, unknown> = {};
      try {
        const raw: unknown = JSON.parse(body);
        if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
          parsed = raw as Record<string, unknown>;
        }
      } catch {
        /* */
      }

      const chatId = typeof parsed.chat_id === 'string' ? parsed.chat_id : '';
      if (chatId !== '' && !allowed.has(chatId)) {
        breaches.push(
          `${M_ENV}: chat_id доставки не принадлежит подставленному множеству ` +
            `(пришёл длиной ${chatId.length}, sha256:${witness(chatId)}). ` +
            'Само значение не печатается намеренно — при утечке это боевой чат менеджеров.',
        );
      }

      hits.push({
        method,
        chatId,
        text: typeof parsed.text === 'string' ? parsed.text : '',
        parseMode: typeof parsed.parse_mode === 'string' ? parsed.parse_mode : '',
        hasMarkup: parsed.reply_markup !== undefined && parsed.reply_markup !== null,
        at: Date.now(),
      });

      messageId += 1;

      if (refuse !== null && method === 'sendMessage' && chatId === refuse.chatId) {
        const body =
          refuse.code === 403
            ? {
                ok: false,
                error_code: 403,
                description:
                  chatId === FAKE.chatId
                    ? 'Forbidden: bot was kicked from the supergroup chat'
                    : 'Forbidden: bot was blocked by the user',
              }
            : {
                ok: false,
                error_code: 429,
                description: 'Too Many Requests: retry after 1',
                parameters: { retry_after: 1 },
              };
        res.writeHead(refuse.code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: resultFor(method, messageId) }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('заглушка Bot API не отдала номер порта');
  }

  return {
    port: address.port,
    hits,
    breaches,
    allow(chatId: string) {
      allowed.add(chatId);
    },
    get refuse() {
      return refuse;
    },
    set refuse(value: { chatId: string; code: 403 | 429 } | null) {
      refuse = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function resultFor(method: string, messageId: number): unknown {
  if (method === 'getMe') {
    return {
      id: 1,
      is_bot: true,
      username: 'gate_fake_bot',
      first_name: 'Gate Fake Bot',
      can_join_groups: true,
    };
  }
  if (method === 'getWebhookInfo') {
    return {
      url: '',
      has_custom_certificate: false,
      pending_update_count: 0,
      max_connections: 5,
      allowed_updates: ['message'],
    };
  }
  return { message_id: messageId };
}

const globalProblems: string[] = [];

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

function tail(text: string, lines = 20): string {
  return text.split('\n').slice(-lines).join('\n');
}

function runtimeEnv(stubPort: number, omit: readonly string[] = []): Record<string, string> {
  if (omit.includes('TG_API_BASE')) {
    throw new Error('TG_API_BASE опускать нельзя — это страховка от выхода на api.telegram.org');
  }
  const env: Record<string, string> = {
    TG_BOT_TOKEN: FAKE.botToken,
    TG_CHAT_ID: FAKE.chatId,
    TG_TECH_CHAT_ID: FAKE.techChatId,
    TG_WEBHOOK_SECRET: FAKE.webhookSecret,
    BOT_ADMIN_TOKEN: FAKE.adminToken,
    TG_API_BASE: `http://127.0.0.1:${stubPort}`,
    MANAGER_CONTACT_URL: FAKE.managerUrl,
  };
  for (const key of omit) delete env[key];
  return env;
}

function varFlags(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([key, value]) => ['--var', `${key}:${value}`]);
}

let warmUpPending = true;
let maxRoundTripMs = 0;
let warmUpMaxMs = 0;
const runtimeStarts: number[] = [];

async function startRuntime(env: Record<string, string>): Promise<Runtime> {
  const wrangler = path.join(projectRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const args = [
    wrangler,
    'dev',
    '-c',
    configPath,
    '--port',
    String(RUNTIME_PORT),
    '--local',
    ...varFlags(env),
  ];

  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',

    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
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
  const deadline = startedAt + 120_000;

  const stop = async (): Promise<void> => {
    killTree(child);
    if (!(await waitPortFree(RUNTIME_PORT, 20_000))) {
      globalProblems.push(
        `${M_ORPHAN}: порт ${RUNTIME_PORT} отвечает после гашения дерева процессов. ` +
          'Осиротевший `wrangler dev` обслужит следующий прогон СВОИМ, прежним кодом ' +
          'и отчитается зелёным. Убить вручную по PID из `netstat -ano` и повторить.',
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
      const probe = await fetch(`${base}${WEBHOOK_PATH}`, {
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
      throw new Error(
        `FAIL: рантайм не ответил 405 на GET ${WEBHOOK_PATH} за 120 с.\n${tail(log)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const startedInMs = Date.now() - startedAt;
  runtimeStarts.push(startedInMs);
  warmUpPending = true;
  return { base, startedInMs, stop };
}

interface Answer {
  status: number;
  text: string;
  ms: number;
}

interface Ask {
  base: string;
  path: string;
  method?: 'GET' | 'POST';
  secret?: string;
  adminToken?: string;
  body?: string;
}

async function ask(options: Ask): Promise<Answer> {
  const method = options.method ?? 'POST';
  const headers: Record<string, string> = {};
  if (options.secret !== undefined) headers[WEBHOOK_SECRET_HEADER] = options.secret;
  if (options.adminToken !== undefined) headers[ADMIN_TOKEN_HEADER] = options.adminToken;
  if (method === 'POST') headers['content-type'] = 'application/json';

  const startedAt = Date.now();
  const response = await fetch(`${options.base}${options.path}`, {
    method,
    headers,
    body: method === 'POST' ? (options.body ?? '{}') : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  return { status: response.status, text, ms: Date.now() - startedAt };
}

function guardRoundTrip(c: CaseResult, answer: Answer, what: string): void {
  if (warmUpPending) {
    warmUpPending = false;
    if (answer.ms > warmUpMaxMs) warmUpMaxMs = answer.ms;
    return;
  }
  if (answer.ms > maxRoundTripMs) maxRoundTripMs = answer.ms;
  if (answer.ms > ROUND_TRIP_MAX_MS) {
    c.problems.push(
      `${M_OUTBOUND}: ${what} занял ${answer.ms} мс при потолке ${ROUND_TRIP_MAX_MS} мс. ` +
        'Столько стоит попытка достучаться до НАСТОЯЩЕГО api.telegram.org, а не до заглушки.',
    );
  }
}

function expectStatus(
  c: CaseResult,
  answer: Answer,
  expected: number,
  what: string,
): boolean {
  if (answer.status === expected) return true;
  c.problems.push(`${M_STATUS} ${expected}: ${what} вернул ${answer.status}`);
  return false;
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

const ID_BASE = Date.now();
let userCounter = 0;
let updateCounter = 0;

let stubRef: TelegramStub | null = null;

function nextUserId(): number {
  userCounter += 1;
  const id = ID_BASE + userCounter;
  stubRef?.allow(String(id));
  return id;
}

function nextUpdateId(): number {
  updateCounter += 1;
  return ID_BASE + 500_000 + updateCounter;
}

interface UpdateInput {
  updateId: number;
  userId: number;
  text: string;
  chatId?: number;
  chatType?: string;
  languageCode?: string;
  firstName?: string;
  username?: string;
}

function updateBody(input: UpdateInput): string {
  return JSON.stringify({
    update_id: input.updateId,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: input.chatId ?? input.userId, type: input.chatType ?? 'private' },
      from: {
        id: input.userId,
        is_bot: false,
        first_name: input.firstName ?? 'Батбаяр',
        last_name: 'Ө<&>Ү',
        username: input.username ?? 'gate_visitor',
        language_code: input.languageCode ?? 'ru',
      },
      text: input.text,
    },
  });
}

function since(mark: number): StubHit[] {
  return (stubRef?.hits ?? []).slice(mark);
}

function mark(): number {
  return stubRef?.hits.length ?? 0;
}

async function waitForHit(
  from: number,
  predicate: (hit: StubHit) => boolean,
  timeoutMs: number,
): Promise<StubHit | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = since(from).find(predicate);
    if (found !== undefined) return found;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

const decoyPath = path.join(configDir, '.dev.vars');
let decoySaved: string | null = null;
let decoyExisted = false;

function placeDecoy(): void {
  decoyExisted = existsSync(decoyPath);
  decoySaved = decoyExisted ? readFileSync(decoyPath, 'utf8') : null;
  const body = Object.entries(DECOY)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  writeFileSync(decoyPath, `${body}\n`, 'utf8');
}

function removeDecoy(): void {
  if (decoyExisted && decoySaved !== null) writeFileSync(decoyPath, decoySaved, 'utf8');
  else rmSync(decoyPath, { force: true });
  decoySaved = null;
  decoyExisted = false;
}

let flagsVerdict = 'не измерено';

async function case0(base: string): Promise<CaseResult> {
  const c = openCase(
    0,
    'подложный .dev.vars рядом с конфигурацией НЕ перебивает флаги --var (измерение, а не ритуал)',
  );

  const start = mark();

  const withFlag = await ask({ base, path: '/admin/diag', method: 'GET', adminToken: FAKE.adminToken });
  guardRoundTrip(c, withFlag, 'GET /admin/diag с флаговым админ-токеном');
  if (!expectStatus(c, withFlag, 200, 'GET /admin/diag с флаговым админ-токеном')) {
    c.problems.push(
      `${M_ENV}: подстановка --var не доехала до рантайма. ` +
        'Отличить это от «не тот админ-токен» по коду ответа нельзя — форма флага у ' +
        '`wrangler dev` это `--var KEY:VALUE` (двоеточие), а `KEY=VALUE` создаёт ' +
        'переменную с именем «KEY=VALUE» МОЛЧА. См. факт 1 в шапке файла.',
    );
    return c;
  }

  const withDecoyToken = await ask({
    base,
    path: '/admin/diag',
    method: 'GET',
    adminToken: DECOY.BOT_ADMIN_TOKEN,
  });
  guardRoundTrip(c, withDecoyToken, 'GET /admin/diag с админ-токеном ИЗ ФАЙЛА');
  if (withDecoyToken.status !== 401) {
    c.problems.push(
      `${M_ENV}: админ-токен ИЗ ФАЙЛА .dev.vars принят (${withDecoyToken.status}). ` +
        'Значит файл перебил флаг, и запускать драйвер на дереве с боевым .dev.vars нельзя.',
    );
  }

  const diag = asJson(withFlag.text);
  const config = (diag?.config ?? {}) as Record<string, unknown>;
  if (config.manager_contact_url !== FAKE.managerUrl) {
    c.problems.push(
      `${M_ENV}: diag отдал адрес менеджера ${String(config.manager_contact_url)}, ` +
        `ожидался флаговый ${FAKE.managerUrl}`,
    );
  }
  if (config.tg_chat_id_tail4 !== FAKE.chatId.slice(-4)) {
    c.problems.push(
      `${M_ENV}: diag отдал хвост chat_id «${String(config.tg_chat_id_tail4)}», ` +
        `ожидался флаговый «${FAKE.chatId.slice(-4)}» (у файла был бы ` +
        `«${DECOY.TG_CHAT_ID.slice(-4)}»)`,
    );
  }

  const user = nextUserId();
  const answer = await ask({
    base,
    path: WEBHOOK_PATH,
    secret: FAKE.webhookSecret,
    body: updateBody({
      updateId: nextUpdateId(),
      userId: user,
      text: `/start ${encodeStart({ source: 'fb', direction: 'affiliate', locale: 'mn', campaign: '', click: '' })}`,
    }),
  });
  guardRoundTrip(c, answer, 'POST вебхука под подложным .dev.vars');
  expectStatus(c, answer, 200, 'POST вебхука с верным секретом');

  const fresh = since(start).filter((hit) => hit.method === 'sendMessage');
  if (fresh.length !== 2) {
    c.problems.push(
      `${M_ENV}: попыток отправки ${fresh.length}, ожидалось 2. ` +
        'Ноль означает, что до рантайма доехал TG_API_BASE ИЗ ФАЙЛА (порт 9, там не ' +
        'слушает никто) — то есть файл перебил флаг.',
    );
  } else if (!fresh.some((hit) => hit.chatId === FAKE.chatId)) {
    c.problems.push(
      `${M_ENV}: ни одно сообщение не ушло в подставленный чат менеджеров ` +
        '(значения не печатаются намеренно).',
    );
  }

  if (c.problems.length === 0) {
    flagsVerdict =
      'флаги сильнее `.dev.vars`: файл рядом с конфигурацией прочитан wrangler-ом ' +
      '(«Using secrets defined in …»), но каждое его значение перекрыто флагом --var';
    c.notes.push(flagsVerdict);
  } else {
    flagsVerdict =
      'ГРОМКАЯ ОСТАНОВКА: подстановка --var не победила файл. Запускать драйвер на ' +
      'дереве, где рядом с конфигурацией лежит боевой .dev.vars, НЕЛЬЗЯ.';
  }
  return c;
}

async function mainPass(base: string): Promise<void> {

  const c1 = openCase(1, '/admin/diag с верным админ-токеном: 200 — окружение доехало и бандл собрался');
  const a1 = await ask({ base, path: '/admin/diag', method: 'GET', adminToken: FAKE.adminToken });
  guardRoundTrip(c1, a1, 'GET /admin/diag');
  if (expectStatus(c1, a1, 200, 'GET /admin/diag с верным админ-токеном')) {
    const body = asJson(a1.text);
    for (const key of ['bot', 'webhook', 'config']) {
      if (body?.[key] === undefined) c1.problems.push(`в ответе diag нет группы «${key}»`);
    }
  }

  const validBody = (): string =>
    updateBody({
      updateId: nextUpdateId(),
      userId: nextUserId(),
      text: `/start ${encodeStart({ source: 'fb', direction: 'bank', locale: 'ru', campaign: '', click: '' })}`,
    });

  const c2 = openCase(2, 'POST вебхука БЕЗ заголовка секрета: 401, в заглушке ноль попаданий');
  const m2 = mark();
  const a2 = await ask({ base, path: WEBHOOK_PATH, body: validBody() });
  guardRoundTrip(c2, a2, 'POST без заголовка секрета');
  if (!expectStatus(c2, a2, 401, 'POST без заголовка секрета')) {
    c2.problems.push(`${M_FOREIGN_SECRET}: запрос без заголовка секрета не отвергнут 401-м`);
  }
  if (since(m2).length !== 0) {
    c2.problems.push(`${M_FOREIGN_SECRET}: неаутентифицированный запрос вызвал ${since(m2).length} обращен(ий) к Bot API`);
  }

  const c3 = openCase(3, 'POST вебхука с НЕВЕРНЫМ секретом: 401, ноль попаданий');
  const m3 = mark();
  const a3 = await ask({
    base,
    path: WEBHOOK_PATH,
    secret: `${FAKE.webhookSecret}-wrong`,
    body: validBody(),
  });
  guardRoundTrip(c3, a3, 'POST с неверным секретом');
  if (!expectStatus(c3, a3, 401, 'POST с неверным секретом')) {
    c3.problems.push(`${M_FOREIGN_SECRET}: чужое значение секрета принято`);
  }
  const a3empty = await ask({ base, path: WEBHOOK_PATH, secret: '', body: validBody() });
  guardRoundTrip(c3, a3empty, 'POST с ПУСТЫМ секретом');
  if (!expectStatus(c3, a3empty, 401, 'POST с пустым значением секрета')) {
    c3.problems.push(`${M_FOREIGN_SECRET}: пустое значение секрета принято`);
  }
  if (since(m3).length !== 0) {
    c3.problems.push(`${M_FOREIGN_SECRET}: неаутентифицированные запросы вызвали ${since(m3).length} обращен(ий) к Bot API`);
  }

  const c4 = openCase(4, 'GET на вебхук с ВЕРНЫМ секретом: 405 (не 404 — Telegram не отличит адрес от метода)');
  const a4 = await ask({ base, path: WEBHOOK_PATH, method: 'GET', secret: FAKE.webhookSecret });
  guardRoundTrip(c4, a4, 'GET вебхука');
  expectStatus(c4, a4, 405, 'GET на вебхук');

  const c5 = openCase(5, `тело больше потолка (${WEBHOOK_BODY_MAX_BYTES} Б): 413`);
  const m5 = mark();
  const huge = JSON.stringify({ update_id: nextUpdateId(), padding: 'x'.repeat(WEBHOOK_BODY_MAX_BYTES + 4096) });
  const a5 = await ask({ base, path: WEBHOOK_PATH, secret: FAKE.webhookSecret, body: huge });
  guardRoundTrip(c5, a5, 'POST тела больше потолка');
  expectStatus(c5, a5, 413, 'POST тела больше потолка');
  if (since(m5).length !== 0) {
    c5.problems.push(`${M_STUB_EXTRA}: отвергнутое по размеру тело вызвало ${since(m5).length} обращен(ий) к Bot API`);
  }

  const c6 = openCase(
    6,
    'верный секрет + /start с меткой: 200 и РОВНО два sendMessage — посетителю с кнопкой, затем менеджерам с parse_mode HTML',
  );
  const userA = nextUserId();
  const m6 = mark();
  const a6 = await ask({
    base,
    path: WEBHOOK_PATH,
    secret: FAKE.webhookSecret,
    body: updateBody({
      updateId: nextUpdateId(),
      userId: userA,
      text: `/start ${encodeStart({ source: 'fb', direction: 'teamcash', locale: 'ru', campaign: 'gate', click: 'c1', })}`,
    }),
  });
  guardRoundTrip(c6, a6, 'POST /start');
  expectStatus(c6, a6, 200, 'POST /start с верным секретом');

  let fullLeadLength = 0;
  const fresh6 = since(m6);
  if (fresh6.length !== 2) {
    c6.problems.push(
      `${fresh6.length < 2 ? M_STUB_SHORT : M_STUB_EXTRA}: обращений к Bot API ${fresh6.length}, ожидалось 2`,
    );
  } else {
    const [toVisitor, toManagers] = fresh6 as [StubHit, StubHit];
    if (toVisitor.method !== 'sendMessage' || toManagers.method !== 'sendMessage') {
      c6.problems.push(`методы обращений: ${fresh6.map((h) => h.method).join(', ')}, ожидались два sendMessage`);
    }
    if (toVisitor.chatId !== String(userA)) {
      c6.problems.push('ПЕРВЫМ ушло сообщение не посетителю — порядок конвейера нарушен (значения не печатаются)');
    }
    if (!toVisitor.hasMarkup) {
      c6.problems.push('ответ посетителю ушёл БЕЗ reply_markup — кнопки с контактом менеджера нет (решение заказчика Д-01)');
    }
    if (toManagers.chatId !== FAKE.chatId) {
      c6.problems.push('ВТОРЫМ ушло сообщение не в чат менеджеров (значения не печатаются намеренно)');
    }
    if (toManagers.parseMode !== 'HTML') {
      c6.problems.push(`сообщение менеджерам ушло с parse_mode «${toManagers.parseMode}», ожидался HTML`);
    }
    if (!toManagers.text.includes(EXPECTED_LEAD_HEAD)) {
      c6.problems.push(`в сообщении менеджерам нет заголовка «${EXPECTED_LEAD_HEAD}»`);
    }
    fullLeadLength = toManagers.text.length;
    c6.notes.push(`полный лид — ${fullLeadLength} символ(ов); ответ посетителю — ${toVisitor.text.length}`);
  }

  const directions = Object.keys(DIRECTIONS) as Direction[];
  const locales = Object.keys(LOCALES) as Locale[];
  const sources = ['', 'fb'] as const;
  const c7 = openCase(
    7,
    `перебор меток ${directions.length}×${locales.length}×${sources.length}: направление и источник доезжают до сообщения менеджерам`,
  );
  let combos = 0;
  for (const direction of directions) {
    for (const locale of locales) {
      for (const source of sources) {
        combos += 1;
        const label = encodeStart({ source, direction, locale, campaign: '', click: '' });
        const user = nextUserId();
        const m = mark();
        const answer = await ask({
          base,
          path: WEBHOOK_PATH,
          secret: FAKE.webhookSecret,
          body: updateBody({
            updateId: nextUpdateId(),
            userId: user,
            text: `/start ${label}`,
            languageCode: 'en',
          }),
        });
        guardRoundTrip(c7, answer, `POST /start «${label}»`);
        const where = `метка «${label}» (${direction}/${locale}/${source === '' ? 'без источника' : source})`;
        if (answer.status !== 200) {
          c7.problems.push(`${M_STATUS} 200: ${where} вернула ${answer.status}`);
          continue;
        }
        const managers = since(m).find((hit) => hit.chatId === FAKE.chatId);
        if (managers === undefined) {
          c7.problems.push(`${M_STUB_SHORT}: ${where} не дала сообщения в чат менеджеров`);
          continue;
        }
        const expectedDirection = EXPECTED_DIRECTION_TEXT[direction];
        if (!managers.text.includes(expectedDirection)) {
          c7.problems.push(`${M_TAG_LOST}: ${where} — в сообщении нет направления «${expectedDirection}»`);
        }
        const expectedSource = source === '' ? EXPECTED_DIRECT_SOURCE : source;
        if (!managers.text.includes(`Источник:</b> ${expectedSource}`)) {
          c7.problems.push(`${M_TAG_LOST}: ${where} — в сообщении нет источника «${expectedSource}»`);
        }

        if (!managers.text.includes(`Язык:</b> ${locale}`)) {
          c7.problems.push(`${M_TAG_LOST}: ${where} — в сообщении нет языка метки «${locale}»`);
        }
      }
    }
  }
  c7.notes.push(`перебрано комбинаций: ${combos}`);

  const c8 = openCase(8, 'повтор /start от ТОГО ЖЕ user id: 200, менеджерам — КОРОТКАЯ пометка, посетителю — ответ');
  const m8 = mark();
  const a8 = await ask({
    base,
    path: WEBHOOK_PATH,
    secret: FAKE.webhookSecret,
    body: updateBody({
      updateId: nextUpdateId(),
      userId: userA,
      text: `/start ${encodeStart({ source: 'fb', direction: 'teamcash', locale: 'ru', campaign: 'gate', click: 'c1' })}`,
    }),
  });
  guardRoundTrip(c8, a8, 'повторный POST /start');
  expectStatus(c8, a8, 200, 'повторный /start');
  const fresh8 = since(m8);
  if (!fresh8.some((hit) => hit.chatId === String(userA))) {
    c8.problems.push(`${M_STUB_SHORT}: посетителю на повторе не ушло ничего — а отвечать надо всегда`);
  }
  const managers8 = fresh8.find((hit) => hit.chatId === FAKE.chatId);
  if (managers8 === undefined) {
    c8.problems.push(`${M_STUB_SHORT}: пометки повтора в чат менеджеров не ушло (BOT-03)`);
  } else {
    if (managers8.text.includes(EXPECTED_LEAD_HEAD)) {
      c8.problems.push(`${M_REPEAT_DUP}: менеджерам ушёл ПОЛНЫЙ лид вместо короткой пометки`);
    }
    if (!managers8.text.includes(EXPECTED_REPEAT_HEAD)) {
      c8.problems.push(`${M_REPEAT_DUP}: в сообщении нет признака повтора «${EXPECTED_REPEAT_HEAD}»`);
    }
    if (fullLeadLength > 0 && managers8.text.length >= fullLeadLength) {
      c8.problems.push(
        `${M_REPEAT_DUP}: пометка длиной ${managers8.text.length} не короче полного лида (${fullLeadLength})`,
      );
    }
    c8.notes.push(`пометка повтора — ${managers8.text.length} символ(ов) против ${fullLeadLength} у полного лида`);
  }

  const c9 = openCase(9, 'третий /start того же user id: 200, посетителю ответ, менеджерам НИЧЕГО');
  const m9 = mark();
  const a9 = await ask({
    base,
    path: WEBHOOK_PATH,
    secret: FAKE.webhookSecret,
    body: updateBody({
      updateId: nextUpdateId(),
      userId: userA,
      text: '/start',
    }),
  });
  guardRoundTrip(c9, a9, 'третий POST /start');
  expectStatus(c9, a9, 200, 'третий /start');
  const fresh9 = since(m9);
  if (!fresh9.some((hit) => hit.chatId === String(userA))) {
    c9.problems.push(`${M_STUB_SHORT}: посетителю на третьем обращении не ушло ничего`);
  }
  if (fresh9.some((hit) => hit.chatId === FAKE.chatId)) {
    c9.problems.push(`${M_SILENCE}: на третьем обращении в чат менеджеров всё-таки ушло сообщение`);
  }

  const c10 = openCase(
    10,
    'заглушка отказывает по чату менеджеров: Telegram всё равно 200, а в техчат приходит алерт (из ctx.waitUntil)',
  );
  const userB = nextUserId();
  const m10 = mark();
  if (stubRef !== null) stubRef.refuse = { chatId: FAKE.chatId, code: 403 };
  const a10 = await ask({
    base,
    path: WEBHOOK_PATH,
    secret: FAKE.webhookSecret,
    body: updateBody({
      updateId: nextUpdateId(),
      userId: userB,
      text: `/start ${encodeStart({ source: 'fb', direction: 'affiliate', locale: 'mn', campaign: '', click: '' })}`,
    }),
  });
  guardRoundTrip(c10, a10, 'POST /start при отказе доставки менеджерам');
  expectStatus(c10, a10, 200, 'POST /start при отказе доставки менеджерам');
  const alert = await waitForHit(
    m10,
    (hit) => hit.chatId === FAKE.techChatId,
    WAIT_UNTIL_TIMEOUT_MS,
  );
  if (alert === null) {
    c10.problems.push(
      `${M_ALERT}: за ${WAIT_UNTIL_TIMEOUT_MS} мс в техчат не пришло ничего. ` +
        'Недоставленный лид остался бы невидимым ровно столько, сколько никто не смотрит на число лидов.',
    );
  } else if (!alert.text.includes(EXPECTED_ALERT_HEAD)) {
    c10.problems.push(`${M_ALERT}: текст в техчате не похож на алерт о недоставке`);
  }
  const attempts10 = since(m10).filter((hit) => hit.chatId === FAKE.chatId).length;
  if (attempts10 < 2) {
    c10.problems.push(`${M_STUB_SHORT}: попыток доставки менеджерам ${attempts10}, ожидалось не меньше 2 (первая + повтор из waitUntil)`);
  }
  if (!since(m10).some((hit) => hit.chatId === String(userB))) {
    c10.problems.push(`${M_STUB_SHORT}: посетитель не получил ответа, хотя отказ был только по чату менеджеров`);
  }
  c10.notes.push(`попыток доставки менеджерам: ${attempts10}, алерт в техчат: ${alert === null ? 'НЕТ' : 'есть'}`);
  if (stubRef !== null) stubRef.refuse = null;

  const c13 = openCase(13, 'апдейт из супергруппы (/start@бот и обычный текст): 200 и НОЛЬ попаданий в заглушке');
  stubRef?.allow(String(GROUP_CHAT_ID));
  const m13 = mark();
  const a13a = await ask({
    base,
    path: WEBHOOK_PATH,
    secret: FAKE.webhookSecret,
    body: updateBody({
      updateId: nextUpdateId(),
      userId: nextUserId(),
      chatId: GROUP_CHAT_ID,
      chatType: 'supergroup',
      text: `/start@melbet_mn_bot ${encodeStart({ source: 'fb', direction: 'affiliate', locale: 'mn', campaign: '', click: '' })}`,
    }),
  });
  guardRoundTrip(c13, a13a, 'POST /start@бот из супергруппы');
  expectStatus(c13, a13a, 200, '/start@бот из супергруппы');
  const a13b = await ask({
    base,
    path: WEBHOOK_PATH,
    secret: FAKE.webhookSecret,
    body: updateBody({
      updateId: nextUpdateId(),
      userId: nextUserId(),
      chatId: GROUP_CHAT_ID,
      chatType: 'supergroup',
      text: 'а этот лид чей? я ему написал',
    }),
  });
  guardRoundTrip(c13, a13b, 'POST ответа менеджера в супергруппе');
  expectStatus(c13, a13b, 200, 'ответ менеджера в супергруппе');
  const fresh13 = since(m13);
  if (fresh13.length !== 0) {
    c13.problems.push(
      `${M_GROUP}: групповые апдейты вызвали ${fresh13.length} обращен(ий) к Bot API ` +
        `(чаты: ${fresh13.map((h) => (h.chatId === FAKE.chatId ? 'менеджеры' : h.chatId === FAKE.techChatId ? 'техчат' : 'иной')).join(', ')})`,
    );
  }

  const c14 = openCase(
    14,
    'повторная доставка того же update_id: конвейер второй раз не проходит, окно охлаждения не двигается',
  );
  const userD = nextUserId();
  const updD = nextUpdateId();
  const bodyD = updateBody({
    updateId: updD,
    userId: userD,
    text: `/start ${encodeStart({ source: 'fb', direction: 'bank', locale: 'en', campaign: '', click: '' })}`,
  });

  const m14first = mark();
  const a14first = await ask({ base, path: WEBHOOK_PATH, secret: FAKE.webhookSecret, body: bodyD });
  guardRoundTrip(c14, a14first, 'первая доставка апдейта');
  expectStatus(c14, a14first, 200, 'первая доставка апдейта');
  const afterFirst = since(m14first);

  const m14second = mark();
  const a14second = await ask({ base, path: WEBHOOK_PATH, secret: FAKE.webhookSecret, body: bodyD });
  guardRoundTrip(c14, a14second, 'повторная доставка того же апдейта');
  expectStatus(c14, a14second, 200, 'повторная доставка того же апдейта');
  const afterSecond = since(m14second);

  if (afterSecond.some((hit) => hit.chatId === String(userD))) {
    c14.problems.push(`${M_REDELIVERY}: посетитель получил ВТОРОЙ ответ на ту же доставку`);
  }
  if (afterSecond.some((hit) => hit.chatId === FAKE.chatId)) {
    c14.problems.push(`${M_REDELIVERY}: в чат менеджеров ушло второе сообщение по тому же update_id`);
  }

  const techNotes = afterSecond.filter((hit) => hit.chatId === FAKE.techChatId).length;
  if (techNotes !== 1) {
    c14.problems.push(
      `${M_REDELIVERY}: строк в техчат об отсечённом ретрае ${techNotes}, ожидалась ровно 1 ` +
        '(молчаливое отсечение — единственный путь, на котором лид пропадает без следа)',
    );
  }
  c14.notes.push(
    `первая доставка — ${afterFirst.length} обращен(ий), повторная — ${afterSecond.length} ` +
      '(из них строка в техчат об отсечённом ретрае)',
  );

  const m14next = mark();
  const a14next = await ask({
    base,
    path: WEBHOOK_PATH,
    secret: FAKE.webhookSecret,
    body: updateBody({ updateId: nextUpdateId(), userId: userD, text: '/start' }),
  });
  guardRoundTrip(c14, a14next, 'следующий /start после ретрая');
  expectStatus(c14, a14next, 200, 'следующий /start после ретрая');
  const managersNext = since(m14next).find((hit) => hit.chatId === FAKE.chatId);

  const userCtl = nextUserId();
  const bodyCtl = (): string =>
    updateBody({
      updateId: nextUpdateId(),
      userId: userCtl,
      text: `/start ${encodeStart({ source: 'fb', direction: 'bank', locale: 'en', campaign: '', click: '' })}`,
    });
  await ask({ base, path: WEBHOOK_PATH, secret: FAKE.webhookSecret, body: bodyCtl() });
  const mCtl = mark();
  await ask({ base, path: WEBHOOK_PATH, secret: FAKE.webhookSecret, body: bodyCtl() });
  const managersCtl = since(mCtl).find((hit) => hit.chatId === FAKE.chatId);

  if (managersNext === undefined) {
    c14.problems.push(
      `${M_WINDOW_MOVED}: следующий /start того же человека ПРОМОЛЧАЛ — значит ретрай ` +
        'засчитался окном как отдельное обращение и сдвинул счёт на единицу вперёд.',
    );
  } else if (!managersNext.text.includes(EXPECTED_REPEAT_HEAD)) {
    c14.problems.push(`${M_WINDOW_MOVED}: следующее обращение дало не пометку повтора, а другое сообщение`);
  }
  if (managersCtl === undefined || !managersCtl.text.includes(EXPECTED_REPEAT_HEAD)) {
    c14.problems.push(
      `${M_WINDOW_MOVED}: контрольный человек БЕЗ ретрая повёл себя иначе — сравнивать не с чем`,
    );
  }
  c14.notes.push(
    'после ретрая следующее обращение = второе (пометка повтора), как и у контрольного человека без ретрая',
  );

  const c16 = openCase(16, 'POST /admin/webhook/delete БЕЗ админ-токена: 401 и ноль попаданий (вызов разрушительный)');
  const m16 = mark();
  const a16 = await ask({ base, path: '/admin/webhook/delete', body: '{}' });
  guardRoundTrip(c16, a16, 'POST /admin/webhook/delete без токена');
  if (!expectStatus(c16, a16, 401, 'POST /admin/webhook/delete без админ-токена')) {
    c16.problems.push(`${M_ADMIN_OPEN}: удаление вебхука доступно без предъявления токена`);
  }
  const a16wrong = await ask({ base, path: '/admin/webhook/delete', adminToken: `${FAKE.adminToken}-wrong`, body: '{}' });
  guardRoundTrip(c16, a16wrong, 'POST /admin/webhook/delete с чужим токеном');
  if (!expectStatus(c16, a16wrong, 401, 'POST /admin/webhook/delete с чужим токеном')) {
    c16.problems.push(`${M_ADMIN_OPEN}: удаление вебхука прошло с чужим админ-токеном`);
  }
  if (since(m16).length !== 0) {
    c16.problems.push(`${M_ADMIN_OPEN}: неаутентифицированный /admin/webhook/delete вызвал обращение к Bot API`);
  }

  const c17 = openCase(
    17,
    'заглушка отказывает 403 по чату ПОСЕТИТЕЛЯ: Telegram всё равно 200, лид менеджерам несёт пометку «контакт НЕ доставлен», в техчат уходит строка',
  );
  const userC = nextUserId();
  const m17 = mark();
  if (stubRef !== null) stubRef.refuse = { chatId: String(userC), code: 403 };
  const a17 = await ask({
    base,
    path: WEBHOOK_PATH,
    secret: FAKE.webhookSecret,
    body: updateBody({
      updateId: nextUpdateId(),
      userId: userC,
      text: `/start ${encodeStart({ source: '', direction: 'bank', locale: 'ru', campaign: '', click: '' })}`,
    }),
  });
  guardRoundTrip(c17, a17, 'POST /start при отказе доставки ПОСЕТИТЕЛЮ');
  expectStatus(c17, a17, 200, 'POST /start при отказе доставки ПОСЕТИТЕЛЮ');

  const lead17 = since(m17).find((hit) => hit.chatId === FAKE.chatId);
  if (lead17 === undefined) {
    c17.problems.push(`${M_STUB_SHORT}: лид в чат менеджеров не ушёл вовсе`);
  } else if (!lead17.text.toLowerCase().includes('не доставлен')) {
    c17.problems.push(
      `${M_REPLY_OUTCOME}: менеджеру ушёл обычный лид, хотя контакт до человека не доехал. ` +
        'Менеджер будет ждать сообщения, которого не будет, — Д-01 отменяется молча.',
    );
  }

  const techLine = await waitForHit(m17, (hit) => hit.chatId === FAKE.techChatId, WAIT_UNTIL_TIMEOUT_MS);
  if (techLine === null) {
    c17.problems.push(
      `${M_REPLY_OUTCOME}: за ${WAIT_UNTIL_TIMEOUT_MS} мс в техчат не пришло ничего — ` +
        'недоставленный контакт остался бы невидимым полностью.',
    );
  } else if (!techLine.text.includes(String(userC))) {
    c17.problems.push(`${M_REPLY_OUTCOME}: в строке техчата нет id посетителя — искать человека нечем`);
  }

  const visitorTries = since(m17).filter((hit) => hit.chatId === String(userC)).length;
  if (visitorTries !== 1) {
    c17.problems.push(
      `${M_REPLY_OUTCOME}: попыток ответа посетителю ${visitorTries}, ожидалась РОВНО ОДНА: ` +
        '403 — это «заблокирован», и повтор отправляет сообщение человеку, который нас заблокировал.',
    );
  }
  c17.notes.push(
    `попыток ответа посетителю: ${visitorTries}; пометка в лиде: ${lead17?.text.toLowerCase().includes('не доставлен') ? 'есть' : 'НЕТ'}; строка в техчат: ${techLine === null ? 'НЕТ' : 'есть'}`,
  );
  if (stubRef !== null) stubRef.refuse = null;
}

async function inertCase(
  base: string,
  n: number,
  missing: string,
  why: string,
): Promise<void> {
  const c = openCase(n, `рантайм БЕЗ ${missing}: вебхук отвечает 503 и не делает ни одного обращения к Bot API (${why})`);
  const m = mark();
  const answer = await ask({
    base,
    path: WEBHOOK_PATH,
    secret: FAKE.webhookSecret,
    body: updateBody({
      updateId: nextUpdateId(),
      userId: nextUserId(),
      text: `/start ${encodeStart({ source: 'fb', direction: 'affiliate', locale: 'mn', campaign: '', click: '' })}`,
    }),
  });
  guardRoundTrip(c, answer, `POST /start на рантайме без ${missing}`);
  if (!expectStatus(c, answer, 503, `POST /start на рантайме без ${missing}`)) {
    c.problems.push(`${M_NOT_INERT}: без ${missing} воркер обязан быть инертен`);
  }
  if (since(m).length !== 0) {
    c.problems.push(`${M_NOT_INERT}: недонастроенный воркер сделал ${since(m).length} обращен(ий) к Bot API`);
  }
}

async function adminFailClosedCase(base: string): Promise<void> {
  const c = openCase(
    15,
    'рантайм БЕЗ BOT_ADMIN_TOKEN: любой путь /admin/* отвечает РОВНО 401 (не 503 и не 404) — fail-closed наблюдается',
  );
  const m = mark();
  const paths: [string, 'GET' | 'POST'][] = [
    ['/admin/diag', 'GET'],
    ['/admin/webhook', 'POST'],
    ['/admin/webhook/delete', 'POST'],
    ['/admin/profile', 'POST'],

    ['/admin/unknown-probe', 'GET'],
  ];
  for (const [route, method] of paths) {
    for (const token of [undefined, FAKE.adminToken, '']) {
      const answer = await ask({ base, path: route, method, adminToken: token, body: '{}' });
      guardRoundTrip(c, answer, `${method} ${route}`);
      if (answer.status !== 401) {
        c.problems.push(
          `${M_ADMIN_OPEN}: ${method} ${route} с ${token === undefined ? 'отсутствующим' : token === '' ? 'пустым' : 'каким-то'} токеном вернул ${answer.status}, ожидался 401`,
        );
      }
    }
  }
  if (since(m).length !== 0) {
    c.problems.push(`${M_ADMIN_OPEN}: закрытая админ-поверхность сделала ${since(m).length} обращен(ий) к Bot API`);
  }
  c.notes.push(`проверено комбинаций: ${paths.length * 3}`);
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  const occupied = await occupiedPorts([RUNTIME_PORT]);
  if (occupied.length > 0) {
    console.error(portGuardMessage(occupied));
    process.exit(1);
  }

  if (!existsSync(configPath)) {
    console.error(`FAIL: нет файла конфигурации ${configLabel} — поднимать нечего.`);
    process.exit(1);
  }

  console.log('--- Драйвер воркера бота: случай 0 и 17 случаев против настоящего рантайма ---\n');
  console.log(`Конфигурация:   ${configLabel}`);
  console.log(`Порт рантайма:  ${RUNTIME_PORT}`);
  console.log('Форма подстановки окружения: `wrangler dev --var KEY:VALUE` (ДВОЕТОЧИЕ).');
  console.log('  ⚠️ У соседнего `wrangler pages dev` это `--binding KEY=VALUE`; формы не взаимозаменяемы.');
  console.log('  ⚠️ `--var KEY=VALUE` МОЛЧА заводит переменную с именем «KEY=VALUE» — измерено этим планом.\n');

  const stub = await startTelegramStub();
  stubRef = stub;
  let runtime: Runtime | null = null;

  try {

    placeDecoy();
    try {
      runtime = await startRuntime(runtimeEnv(stub.port));
      const c0 = await case0(runtime.base);
      await runtime.stop();
      runtime = null;
      if (c0.problems.length > 0) {

        console.error(`\n${flagsVerdict}\n`);
        report(startedAt, stub);
        return;
      }
    } finally {
      removeDecoy();
    }

    runtime = await startRuntime(runtimeEnv(stub.port));
    await mainPass(runtime.base);
    await runtime.stop();
    runtime = null;

    runtime = await startRuntime(runtimeEnv(stub.port, ['TG_CHAT_ID']));
    await inertCase(runtime.base, 11, 'TG_CHAT_ID', 'слать лид некуда');
    await runtime.stop();
    runtime = null;

    runtime = await startRuntime(runtimeEnv(stub.port, ['MANAGER_CONTACT_URL']));
    await inertCase(
      runtime.base,
      12,
      'MANAGER_CONTACT_URL',
      'вход, несущий решение заказчика Д-01, охраняется наравне с секретами',
    );
    await runtime.stop();
    runtime = null;

    runtime = await startRuntime(runtimeEnv(stub.port, ['BOT_ADMIN_TOKEN']));
    await adminFailClosedCase(runtime.base);
    await runtime.stop();
    runtime = null;
  } finally {
    if (runtime !== null) {
      try {
        await runtime.stop();
      } catch (err) {
        globalProblems.push(err instanceof Error ? err.message : String(err));
      }
    }
    removeDecoy();
    await stub.close();
    stubRef = null;
  }

  if (!(await portFree(RUNTIME_PORT))) {
    globalProblems.push(`${M_ORPHAN}: порт ${RUNTIME_PORT} занят после завершения прогона`);
  }

  report(startedAt, stub);
}

function report(startedAt: number, stub: TelegramStub): void {
  const problems = [...globalProblems, ...stub.breaches];
  if (problems.length > 0) {
    const c = openCase(-1, 'сверка подстановки на КАЖДОМ попадании заглушки и отсутствие осиротевших серверов');
    c.problems.push(...problems);
  }

  const ordered = [...results].sort((a, b) => a.n - b.n);
  for (const result of ordered) {
    const label = result.n < 0 ? '**' : String(result.n).padStart(2, ' ');
    console.log(`${result.problems.length === 0 ? 'OK  ' : 'FAIL'}  ${label}  ${result.title}`);
    for (const note of result.notes) console.log(`          ~ ${note}`);
    for (const problem of result.problems) console.log(`          ${problem}`);
  }

  const numbered = ordered.filter((r) => r.n >= 0);
  const failed = ordered.filter((r) => r.problems.length > 0);

  console.log('');
  console.log(`Вердикт случая 0: ${flagsVerdict}`);
  console.log(
    `Идентификаторы прогона: посетители ${ID_BASE + 1}…${ID_BASE + userCounter}, ` +
      `апдейты ${ID_BASE + 500_001}…${ID_BASE + 500_000 + updateCounter}`,
  );
  if (runtimeStarts.length > 0) {
    console.log(`Стартов рантайма: ${runtimeStarts.length} (${runtimeStarts.join(', ')} мс)`);
  }
  console.log(
    `Обмен с воркером: максимум ${maxRoundTripMs} мс при потолке ${ROUND_TRIP_MAX_MS} мс` +
      (warmUpMaxMs > 0 ? `; прогревочные (не в счёт) до ${warmUpMaxMs} мс` : ''),
  );
  console.log(`Обращений к заглушке Bot API: ${stub.hits.length}; нарушений подстановки: ${stub.breaches.length}`);
  console.log(`Полный прогон: ${((Date.now() - startedAt) / 1000).toFixed(1)} с`);
  console.log(`Итог: ${numbered.length - failed.filter((r) => r.n >= 0).length}/${numbered.length} случаев пройдено.`);

  if (failed.length > 0) {
    console.error(
      `\nFAIL: не пройдено — ${failed.length}: ` +
        `${failed.map((r) => (r.n < 0 ? 'сверка заглушки' : `№${r.n}`)).join(', ')}.`,
    );
    process.exit(1);
  }
  console.log('PASS: конвейер бота ведёт себя по контракту против настоящего рантайма Workers.');
}

main().catch((err) => {

  try {
    removeDecoy();
  } catch {
    /* */
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
