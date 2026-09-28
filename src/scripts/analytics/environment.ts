
export function siteHost(siteUrl: string): string {
  try {
    return new URL(siteUrl).hostname;
  } catch {
    return '';
  }
}

export function isInternalHost(hostname: string, siteUrl: string): boolean {
  const host = siteHost(siteUrl);
  return host === '' || hostname.toLowerCase() !== host.toLowerCase();
}
