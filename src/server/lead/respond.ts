
import { escapeHtml } from './message.ts';
import {
  DEFAULT_LOCALE,
  ERROR_CODES,
  RATE_LIMIT_WINDOW_MS,
  SUCCESS_ROUTE,
} from '../../lib/lead-contract.ts';
import type { ErrorCode } from '../../lib/lead-contract.ts';
import type { Locale } from '../../i18n/routes.ts';
import { t } from '../../i18n/t.ts';
import type { TranslationKey } from '../../i18n/t.ts';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  [ERROR_CODES.methodNotAllowed]: 405,
  [ERROR_CODES.bodyTooLarge]: 400,
  [ERROR_CODES.badRequest]: 400,
  [ERROR_CODES.rateLimited]: 429,
  [ERROR_CODES.validationFailed]: 422,
  [ERROR_CODES.captchaFailed]: 403,
  [ERROR_CODES.serviceUnconfigured]: 503,
  [ERROR_CODES.internalError]: 500,
};

const MESSAGE_KEY_BY_CODE: Record<ErrorCode, TranslationKey> = {
  [ERROR_CODES.methodNotAllowed]: 'api.err_generic',
  [ERROR_CODES.bodyTooLarge]: 'api.err_generic',
  [ERROR_CODES.badRequest]: 'api.err_generic',
  [ERROR_CODES.rateLimited]: 'api.err_rate_limited',
  [ERROR_CODES.validationFailed]: 'api.err_validation',
  [ERROR_CODES.captchaFailed]: 'api.err_captcha',
  [ERROR_CODES.serviceUnconfigured]: 'api.err_generic',
  [ERROR_CODES.internalError]: 'api.err_generic',
};

const SAFE_SCHEMES = new Set(['https:', 'http:', 'tg:']);

const MANAGER_URL_LAST_RESORT = 'https://t.me/';

const NO_STORE = 'no-store';

export interface SuccessOptions {

  json: boolean;

  locale?: Locale;
}

export interface ErrorOptions {
  json: boolean;

  code: ErrorCode;
  locale?: Locale;

  fields?: readonly string[];

  retryAfterSec?: number;

  managerUrl: string;
}

export function wantsJson(request: Request): boolean {
  const accept = request.headers.get('accept');
  if (accept === null) return false;
  return accept.toLowerCase().includes('application/json');
}

export function respondSuccess({ json, locale = DEFAULT_LOCALE }: SuccessOptions): Response {
  if (json) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': NO_STORE,
      },
    });
  }

  return new Response(null, {
    status: 303,
    headers: { location: SUCCESS_ROUTE[locale], 'cache-control': NO_STORE },
  });
}

export function respondError({
  json,
  code,
  locale = DEFAULT_LOCALE,
  fields,
  retryAfterSec,
  managerUrl,
}: ErrorOptions): Response {
  const status = STATUS_BY_CODE[code];
  const headers: Record<string, string> = { 'cache-control': NO_STORE };

  if (code === ERROR_CODES.rateLimited) {
    headers['retry-after'] = String(retryAfterSeconds(retryAfterSec));
  }
  if (code === ERROR_CODES.methodNotAllowed) {

    headers['allow'] = 'POST';
  }

  if (json) {
    const body: { ok: false; error: ErrorCode; fields?: string[] } = { ok: false, error: code };

    if (fields !== undefined && fields.length > 0) body.fields = [...fields];
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
    });
  }

  return new Response(errorPage(locale, code, managerUrl), {
    status,
    headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
  });
}

function retryAfterSeconds(value: number | undefined): number {
  const fullWindow = Math.floor(RATE_LIMIT_WINDOW_MS / 1000);
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fullWindow;
  return Math.max(1, Math.ceil(value));
}

function safeManagerUrl(value: string): string {
  try {
    const parsed = new URL(value.trim());
    if (!SAFE_SCHEMES.has(parsed.protocol)) return MANAGER_URL_LAST_RESORT;
    return parsed.href;
  } catch {
    return MANAGER_URL_LAST_RESORT;
  }
}

function errorPage(locale: Locale, code: ErrorCode, managerUrl: string): string {
  const title = escapeHtml(t(locale, 'api.err_title'));
  const message = escapeHtml(t(locale, MESSAGE_KEY_BY_CODE[code]));
  const cta = escapeHtml(t(locale, 'api.fallback_cta'));
  const href = safeManagerUrl(managerUrl);

  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
:root{color-scheme:dark}
body{margin:0;padding:56px 20px;background:#07090b;color:#f7f6f1;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:17px;line-height:1.55;-webkit-text-size-adjust:100%}
main{max-width:32rem;margin:0 auto}
h1{margin:0 0 14px;font-size:1.5rem;line-height:1.25;font-weight:700;letter-spacing:-0.01em}
p{margin:0 0 28px;color:#a6adb7}
a{display:inline-block;padding:15px 26px;border-radius:12px;background:#f1c632;color:#07090b;font-weight:700;text-decoration:none}
a:focus-visible{outline:3px solid #ffdb63;outline-offset:3px}
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p>${message}</p>
<p><a href="${href}">${cta}</a></p>
</main>
</body>
</html>
`;
}
