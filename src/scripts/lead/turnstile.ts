
import { TURNSTILE_ENABLED, config } from '../../config';
import { TURNSTILE_TOKEN_FIELD } from '../../lib/lead-contract.ts';

const API_JS_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileRenderParams {
  sitekey: string;
  appearance: 'interaction-only';
  size: 'flexible';
  language: TurnstileLanguage;
  theme: 'dark';
  'response-field-name': string;
  'error-callback': (code: string) => boolean;
  'expired-callback': () => void;
}

interface TurnstileApi {
  render(container: HTMLElement, params: TurnstileRenderParams): string | undefined;
  reset(widgetId?: string): void;
}

declare global {
  interface Window {

    turnstile?: TurnstileApi;
  }
}

let injected = false;

let widgetId: string | undefined;

type TurnstileLanguage = 'ru' | 'en';

function widgetLanguage(): TurnstileLanguage {
  return document.documentElement.lang === 'ru' ? 'ru' : 'en';
}

const FLEXIBLE_MIN_WIDTH = 300;

function fitWidget(container: HTMLElement, mount: HTMLElement): void {
  const width = container.clientWidth;
  if (width > 0 && width < FLEXIBLE_MIN_WIDTH) {
    const scale = width / FLEXIBLE_MIN_WIDTH;

    const height = mount.offsetHeight;
    mount.style.width = `${FLEXIBLE_MIN_WIDTH}px`;
    mount.style.transformOrigin = '0 0';
    mount.style.transform = `scale(${scale})`;
    mount.style.marginBottom = height > 0 ? `${(scale - 1) * height}px` : '';
  } else {
    mount.style.width = '';
    mount.style.transformOrigin = '';
    mount.style.transform = '';
    mount.style.marginBottom = '';
  }
}

export function ensureTurnstile(): void {

  if (!TURNSTILE_ENABLED) return;
  if (injected) return;

  const container = document.querySelector<HTMLElement>('[data-turnstile]');
  if (!container) return;

  injected = true;

  const script = document.createElement('script');
  script.src = API_JS_URL;

  script.onload = (): void => {
    const api = window.turnstile;

    if (!api) return;

    const mount = document.createElement('div');
    container.appendChild(mount);
    fitWidget(container, mount);

    if (typeof ResizeObserver === 'function') {
      const refit = new ResizeObserver(() => fitWidget(container, mount));
      refit.observe(container);
      refit.observe(mount);
    }

    widgetId = api.render(mount, {

      sitekey: config.turnstileSitekey,

      appearance: 'interaction-only',

      size: 'flexible',

      language: widgetLanguage(),

      theme: 'dark',

      'response-field-name': TURNSTILE_TOKEN_FIELD,

      'error-callback': (): boolean => false,

      'expired-callback': (): void => {},
    });
  };

  script.onerror = (): void => {
    /* */
  };

  document.head.appendChild(script);
}

export function resetTurnstile(): void {
  if (!TURNSTILE_ENABLED) return;
  const api = window.turnstile;

  if (!api || widgetId === undefined) return;
  api.reset(widgetId);
}
