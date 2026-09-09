
import { registerSink } from './bus';
import type { ClarityFn } from './consent';

const TAG_MAX = 255;

const TAG_LIMIT_PER_PAGE = 128;

export function initClarity(id: string, tags: Record<string, string>): void {

  const clarity: ClarityFn =
    window.clarity ??
    (((...args: unknown[]): void => {
      (clarity.q = clarity.q ?? []).push(args);
    }) as ClarityFn);
  window.clarity = clarity;

  try {
    clarity('consentv2', { ad_Storage: 'denied', analytics_Storage: 'denied' });
  } catch {

    /* */
  }

  const entries = Object.entries(tags).slice(0, TAG_LIMIT_PER_PAGE);
  for (const [key, value] of entries) {
    if (!value) continue;
    try {
      clarity('set', key.slice(0, TAG_MAX), value.slice(0, TAG_MAX));
    } catch {
      /* */
    }
  }

  const tag = document.createElement('script');
  tag.async = true;
  tag.src = `https://www.clarity.ms/tag/${encodeURIComponent(id)}`;

  tag.onload = (): void => {
    registerSink((name) => {
      window.clarity?.('event', name);
    });
  };

  tag.onerror = (): void => {};

  document.head.appendChild(tag);
}
