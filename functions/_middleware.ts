
/// <reference types="@cloudflare/workers-types" />

import { canonicalRedirectTarget } from '../src/server/canonical-redirect.ts';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-DNS-Prefetch-Control': 'off',
};

interface Env {
  CANONICAL_ORIGIN?: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {

  const target = canonicalRedirectTarget(
    context.request.url,
    context.request.method,
    context.env.CANONICAL_ORIGIN,
  );
  if (target) {
    const headers = new Headers({ location: target, 'cache-control': 'public, max-age=3600' });
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
    return new Response(null, { status: 301, headers });
  }

  const response = await context.next();

  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
