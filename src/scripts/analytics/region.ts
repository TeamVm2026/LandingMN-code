
export async function detectRegion(timeoutMs = 3000): Promise<string | null> {

  try {

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    let text: string;
    try {
      const response = await fetch('/cdn-cgi/trace', {

        cache: 'no-store',

        credentials: 'omit',
        signal: controller.signal,
      });

      if (!response.ok) return null;
      text = await response.text();
    } finally {

      window.clearTimeout(timer);
    }

    for (const line of text.split('\n')) {
      if (!line.startsWith('loc=')) continue;
      const value = line.slice(4).trim().toUpperCase();

      return /^[A-Z]{2}$/.test(value) ? value : null;
    }

    return null;
  } catch {
    return null;
  }
}

let pending: Promise<string | null> | null = null;

export function regionOnce(): Promise<string | null> {
  pending ??= detectRegion();
  return pending;
}
