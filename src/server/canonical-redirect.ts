
const PASS_THROUGH_PREFIXES = ['/api/', '/cdn-cgi/'];

export function canonicalRedirectTarget(
  requestUrl: string,
  method: string,
  canonicalOrigin: string | undefined,
): string | null {
  if (!canonicalOrigin) return null;

  let canonical: URL;
  let url: URL;
  try {
    canonical = new URL(canonicalOrigin);
    url = new URL(requestUrl);
  } catch {
    return null;
  }

  if (method !== 'GET' && method !== 'HEAD') return null;
  if (url.hostname === canonical.hostname) return null;
  if (PASS_THROUGH_PREFIXES.some((p) => url.pathname.startsWith(p))) return null;

  const host = url.hostname.toLowerCase();
  const isProductionPagesDev = host.endsWith('.pages.dev') && host.split('.').length === 3;
  const isWww = host === `www.${canonical.hostname.toLowerCase()}`;
  if (!isProductionPagesDev && !isWww) return null;

  return `${canonical.origin}${url.pathname}${url.search}`;
}
