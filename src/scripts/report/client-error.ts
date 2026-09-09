
import { CLIENT_MAX_PER_PAGELOAD, MESSAGE_MAX } from '../../server/report/throttle.ts';

const ENDPOINT = '/api/client-error';

function trim(value: string): string {
  return value.slice(0, MESSAGE_MAX);
}

function describe(value: unknown): string {
  if (value instanceof Error) {
    const name = value.name || 'Error';
    return `${name}: ${value.message}`;
  }
  if (typeof value === 'string') return value;
  try {
    return String(value);
  } catch {
    return 'необъяснимое значение';
  }
}

let sent = 0;
let installed = false;

function send(payload: Record<string, unknown>): void {

  if (sent >= CLIENT_MAX_PER_PAGELOAD) return;
  sent += 1;

  let body: string;
  try {
    body = JSON.stringify(payload);
  } catch {
    return;
  }

  try {

    if (typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(ENDPOINT, body);
      return;
    }

    void fetch(ENDPOINT, { method: 'POST', body, keepalive: true }).catch(() => undefined);
  } catch {
    /* */
  }
}

function context(): Record<string, unknown> {
  return {

    route: location.pathname,
    locale: document.documentElement.lang,
    ua: navigator.userAgent,
  };
}

export function installClientErrorReporter(): void {
  if (installed) return;
  installed = true;

  try {
    window.addEventListener('error', (event: ErrorEvent) => {
      try {

        if (event.target !== null && event.target !== window) return;

        send({
          kind: 'js-error',
          message: trim(event.message || describe(event.error)),
          source: event.filename ?? '',
          line: event.lineno,
          col: event.colno,
          ...context(),
        });
      } catch {

        /* */
      }
    });

    window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
      try {
        send({
          kind: 'promise',
          message: trim(describe(event.reason)),
          source: '',
          line: null,
          col: null,
          ...context(),
        });
      } catch {
        /* */
      }
    });
  } catch {

    /* */
  }
}
