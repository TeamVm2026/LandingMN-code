
import { readCappedBody } from '../../src/server/http/capped-body.ts';
import { TELEGRAM_ATTEMPT_TIMEOUT_MS, deliverWithRetries } from '../../src/server/lead/telegram.ts';
import { CSP_BODY_MAX_BYTES, cspReportKey, isNoise, normalizeCspBody } from '../../src/server/report/csp.ts';
import { buildCapNoticeMessage, buildCspMessage } from '../../src/server/report/message.ts';
import {
  CSP_NS,
  hitIpLimit,
  readSeen,
  readWindow,
  writeSeen,
  writeWindow,
  type ReportCache,
} from '../../src/server/report/store.ts';
import { DEDUP_WINDOW_MS, decideDelivery, nextWindow } from '../../src/server/report/throttle.ts';

const CAP_SUBJECT = 'отчётов о нарушениях CSP';

interface CspEnv {
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

export const onRequestPost: PagesFunction<CspEnv> = async (context) => {
  const { request, env } = context;

  try {

    const token = (env.TG_BOT_TOKEN ?? '').trim();
    const techChat = (env.TG_TECH_CHAT_ID ?? '').trim();
    if (token === '' || techChat === '') return noContent();

    const declared = Number(request.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > CSP_BODY_MAX_BYTES) return noContent();

    const body = await readCappedBody(request, CSP_BODY_MAX_BYTES);
    if (body === null || body === '') return noContent();

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return noContent();
    }

    const violations = normalizeCspBody(parsed);
    if (violations.length === 0) return noContent();

    const worth = violations.filter((violation) => !isNoise(violation));
    if (worth.length === 0) return noContent();

    const cache = sharedCache();
    if (cache === null) return noContent();

    const now = Date.now();
    const ipVerdict = await hitIpLimit(cache, clientIp(request), now, CSP_NS);
    if (!ipVerdict.allowed) return noContent();

    const host = new URL(request.url).host;

    for (const violation of worth) {

      const key = await cspReportKey(violation);
      const [seen, window] = await Promise.all([
        readSeen(cache, key, CSP_NS),
        readWindow(cache, CSP_NS),
      ]);
      const decision = decideDelivery({ key, now, seen, window });

      await writeWindow(cache, nextWindow(window, now, decision), now, DEDUP_WINDOW_MS, CSP_NS);
      if (decision.kind === 'deliver') {
        await writeSeen(cache, key, { firstSeenAt: now }, DEDUP_WINDOW_MS, CSP_NS);
      }

      if (decision.kind === 'duplicate' || decision.kind === 'capped') continue;

      const text =
        decision.kind === 'cap-notice'
          ? buildCapNoticeMessage({
              cap: decision.cap,
              until: decision.until,
              at: new Date(now),
              host,
              subject: CAP_SUBJECT,
            })
          : buildCspMessage({ violation, key, at: new Date(now), host });

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
    }

    return noContent();
  } catch {

    return noContent();
  }
};
