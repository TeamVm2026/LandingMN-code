
import { TURNSTILE_ENABLED, config } from '../../config';
import { TURNSTILE_TOKEN_FIELD } from '../../lib/lead-contract.ts';

const API_JS_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileRenderParams {
  sitekey: string;
  appearance: 'interaction-only';
  size: 'flexible' | 'compact';
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

    widgetId = api.render(container, {

      sitekey: config.turnstileSitekey,

      appearance: 'interaction-only',

      size: container.clientWidth >= 300 ? 'flexible' : 'compact',

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
