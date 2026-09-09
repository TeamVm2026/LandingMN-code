
import { readCappedBody } from '../../src/server/http/capped-body.ts';
import { TELEGRAM_ATTEMPT_TIMEOUT_MS, deliverWithRetries } from '../../src/server/lead/telegram.ts';
import { buildCapNoticeMessage, buildReportMessage } from '../../src/server/report/message.ts';
import {
  bumpIpDelivered,
  hitIpLimit,
  readIpDelivered,
  readSeen,
  readWindow,
  writeSeen,
  writeWindow,
  type ReportCache,
} from '../../src/server/report/store.ts';
import {
  DEDUP_WINDOW_MS,
  REPORT_BODY_MAX_BYTES,
  decideDelivery,
  nextWindow,
  normalizeReport,
  reportKey,
} from '../../src/server/report/throttle.ts';

interface ReportEnv {
  TG_BOT_TOKEN?: string;
  TG_TECH_CHAT_ID?: string;

  TG_API_BASE?: string;
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function clientIp(request: Request): string {
  const direct = request.headers.get('CF-Connecting-IP');
  if (direct !== null && direct.trim() !== '') return direct.trim();

  const forwarded = request.headers.get('X-Forwarded-For');
  if (forwarded !== null) {
    const first = (forwarded.split(',')[0] ?? '').trim();
    if (first !== '') return first;
  }

  return 'local-dev';
}

function sharedCache(): ReportCache | null {
  const store = (globalThis as { caches?: { default?: unknown } }).caches;
  const candidate = store?.default;
  if (candidate !== undefined && typeof (candidate as ReportCache).match === 'function') {
    return candidate as ReportCache;
  }
  return null;
}

const fetchImpl = (url: string, init: RequestInit): Promise<Response> => fetch(url, init);

export const onRequestPost: PagesFunction<ReportEnv> = async (context) => {
  const { request, env } = context;

  try {

    const token = (env.TG_BOT_TOKEN ?? '').trim();
    const techChat = (env.TG_TECH_CHAT_ID ?? '').trim();
    if (token === '' || techChat === '') return noContent();

    const declared = Number(request.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > REPORT_BODY_MAX_BYTES) return noContent();

    const body = await readCappedBody(request, REPORT_BODY_MAX_BYTES);
    if (body === null || body === '') return noContent();

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return noContent();
    }

    const report = normalizeReport(parsed);
    if (report === null) return noContent();

    const cache = sharedCache();
    if (cache === null) return noContent();

    const now = Date.now();
    const ip = clientIp(request);
    const ipVerdict = await hitIpLimit(cache, ip, now);
    if (!ipVerdict.allowed) return noContent();

    const key = await reportKey(report);
    const [seen, window] = await Promise.all([readSeen(cache, key), readWindow(cache)]);
    const ipDelivered = await readIpDelivered(cache, ip, window === null ? null : window.start);
    const decision = decideDelivery({ key, now, seen, window, ipDelivered });

    const updated = nextWindow(window, now, decision);
    await writeWindow(cache, updated, now, DEDUP_WINDOW_MS);
    if (decision.kind === 'deliver') {
      await writeSeen(cache, key, { firstSeenAt: now }, DEDUP_WINDOW_MS);

      const startedAt = updated === null ? now : updated.start;
      await bumpIpDelivered(cache, ip, startedAt, ipDelivered, now, DEDUP_WINDOW_MS);
    }

    if (decision.kind === 'duplicate' || decision.kind === 'capped' || decision.kind === 'ip-capped') {
      return noContent();
    }

    const host = new URL(request.url).host;
    const text =
      decision.kind === 'cap-notice'
        ? buildCapNoticeMessage({
            cap: decision.cap,
            until: decision.until,
            at: new Date(now),
            host,
          })
        : buildReportMessage({ report, key, at: new Date(now), host });

    context.waitUntil(
      deliverWithRetries({
        token,
        chatId: techChat,
        text,
        fetchImpl,
        sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        apiBase: (env.TG_API_BASE ?? '').trim() === '' ? undefined : env.TG_API_BASE,
        timeoutMs: TELEGRAM_ATTEMPT_TIMEOUT_MS,
      }).catch(() => undefined),
    );

    return noContent();
  } catch {

    return noContent();
  }
};
