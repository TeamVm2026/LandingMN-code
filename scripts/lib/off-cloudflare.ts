
export const OFF_CLOUDFLARE_PATHS = ['/cdn-cgi/trace', '/api/lead'] as const;

export function isOffCloudflareNoise(text: string, url: string): boolean {

  if (!/Failed to load resource/.test(text)) return false;
  return OFF_CLOUDFLARE_PATHS.some((suffix) => url.endsWith(suffix));
}

export interface ConsoleErrorItem {
  description?: string;
  source?: string;
  sourceLocation?: { url?: string };
}

export function unexpectedConsoleErrors(items: readonly ConsoleErrorItem[]): ConsoleErrorItem[] {
  return items.filter(
    (item) => !isOffCloudflareNoise(item.description ?? '', item.sourceLocation?.url ?? ''),
  );
}
