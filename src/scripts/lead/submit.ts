
import { readAttribution, attributionSummary } from '../../lib/attribution';
import {
  ATTRIBUTION_FIELD,
  DEFAULT_LOCALE,
  ERROR_CODES,
  FIELDS,
  LOCALES,
  SUCCESS_ROUTE,
  type ErrorCode,
} from '../../lib/lead-contract';
import { TURNSTILE_ENABLED } from '../../config';
import { writeLeadState } from './state.ts';
import { revealBelowSticky } from './reveal.ts';
import type { Locale } from '../../i18n/routes';

const TIMEOUT_MS = 10000;

const ENDPOINT = '/api/lead';

const QUIET_ATTR = 'data-status-quiet';

export type SubmitErrorType = 'server' | 'turnstile' | 'ratelimit' | 'network';

interface FailureShape {

  readonly text:
    | 'apiErrValidation'
    | 'apiErrCaptcha'
    | 'apiErrRateLimited'
    | 'apiErrGeneric'
    | 'apiErrNetwork';

  readonly fallback: boolean;
  readonly errorType: SubmitErrorType;
}

const FAILURE_BY_CODE = {
  [ERROR_CODES.validationFailed]: {
    text: 'apiErrValidation',

    fallback: false,
    errorType: 'server',
  },
  [ERROR_CODES.captchaFailed]: { text: 'apiErrCaptcha', fallback: true, errorType: 'turnstile' },
  [ERROR_CODES.rateLimited]: { text: 'apiErrRateLimited', fallback: true, errorType: 'ratelimit' },
  [ERROR_CODES.methodNotAllowed]: { text: 'apiErrGeneric', fallback: true, errorType: 'server' },
  [ERROR_CODES.bodyTooLarge]: { text: 'apiErrGeneric', fallback: true, errorType: 'server' },
  [ERROR_CODES.badRequest]: { text: 'apiErrGeneric', fallback: true, errorType: 'server' },
  [ERROR_CODES.serviceUnconfigured]: { text: 'apiErrGeneric', fallback: true, errorType: 'server' },
  [ERROR_CODES.internalError]: { text: 'apiErrGeneric', fallback: true, errorType: 'server' },
} as const satisfies Record<ErrorCode, FailureShape>;

const NETWORK_FAILURE: FailureShape = {
  text: 'apiErrNetwork',
  fallback: true,
  errorType: 'network',
};

export interface LeadSubmitWiring {

  emitSubmit(direction: string, contactChannel: string): void;

  emitError(errorType: SubmitErrorType, field?: string): void;

  showFieldError(field: HTMLElement, text: string): void;

  onRestore(): void;

  onSuccess(): boolean;
}

function bodyOf(form: HTMLFormElement): URLSearchParams {
  const params = new URLSearchParams();
  for (const [name, value] of new FormData(form)) {
    if (typeof value === 'string') params.set(name, value);
  }
  return params;
}

export function mountLeadSubmit(wiring: LeadSubmitWiring): void {
  const form = document.querySelector<HTMLFormElement>('[data-lead-form]');
  if (!form) return;

  const status = form.querySelector<HTMLElement>('[data-lead-status]');
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');

  if (!status || !button) return;

  const labelIdle = form.dataset.labelSubmit ?? button.textContent ?? '';
  const labelBusy = form.dataset.labelSubmitting ?? labelIdle;

  let inFlight = false;

  const controlNamed = (name: string): HTMLElement | null => {

    for (const element of Array.from(form.elements)) {
      if (element instanceof HTMLElement && (element as HTMLInputElement).name === name) {
        return element;
      }
    }
    return null;
  };

  const fieldValue = (name: string): string => {
    const control = controlNamed(name);
    if (control instanceof HTMLInputElement) {

      const group = form.elements.namedItem(name);
      if (group instanceof RadioNodeList) return group.value;
      return control.value;
    }
    if (control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) {
      return control.value;
    }
    return '';
  };

  const localeOf = (): Locale => {
    const value = fieldValue(FIELDS.lang);
    return (LOCALES as readonly string[]).includes(value) ? (value as Locale) : DEFAULT_LOCALE;
  };

  const resetStatus = (): void => {
    status.textContent = '';
    status.removeAttribute(QUIET_ATTR);
  };

  const lock = (): void => {

    button.setAttribute('aria-busy', 'true');
    button.setAttribute('aria-disabled', 'true');
    button.textContent = labelBusy;

    resetStatus();

    status.setAttribute(QUIET_ATTR, '');

    const announcement = document.createElement('span');
    announcement.className = 'visually-hidden';
    announcement.textContent = labelBusy;
    status.appendChild(announcement);
  };

  const unlock = (): void => {
    inFlight = false;
    button.removeAttribute('aria-busy');
    button.removeAttribute('aria-disabled');
    button.textContent = labelIdle;
  };

  const showFailure = (shape: FailureShape, fields: readonly string[]): void => {

    unlock();
    resetStatus();

    const notice = document.createElement('p');
    notice.className = 'lead-form__notice type-body';

    const body = document.createElement('span');
    body.textContent = form.dataset[shape.text] ?? '';
    notice.appendChild(body);

    const fallbackLabel = form.dataset.apiFallbackCta ?? '';
    const fallbackHref = form.dataset.apiFallbackHref ?? '';

    const hrefSafe = /^https?:\/\//i.test(fallbackHref);
    if (shape.fallback && fallbackLabel !== '' && hrefSafe) {
      const link = document.createElement('a');
      link.className = 'lead-form__notice-link type-body-bold';
      link.href = fallbackHref;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = fallbackLabel;
      body.appendChild(document.createTextNode(' '));
      body.appendChild(link);
    }

    status.appendChild(notice);

    let firstField: string | undefined;
    const invalidText = form.dataset.errInvalid ?? '';
    for (const name of fields) {
      const control = controlNamed(name);
      if (!control) continue;
      wiring.showFieldError(control, invalidText);
      if (firstField === undefined) {
        firstField = name;
        control.focus({ preventScroll: true });
      }
    }

    revealBelowSticky(status);

    try {
      wiring.emitError(shape.errorType, firstField);
    } catch {
      /* */
    }
  };

  form.addEventListener('submit', (event) => {

    event.preventDefault();

    if (inFlight) return;

    inFlight = true;

    lock();

    try {
      const attr = controlNamed(ATTRIBUTION_FIELD);
      if (attr instanceof HTMLInputElement) {
        attr.value = JSON.stringify(attributionSummary(readAttribution()));
      }
    } catch {

      /* */
    }

    const direction = fieldValue(FIELDS.direction);
    const contactChannel = fieldValue(FIELDS.contactChannel);
    const locale = localeOf();

    void (async () => {
      let response: Response;
      try {
        response = await fetch(ENDPOINT, {
          method: 'POST',

          headers: { Accept: 'application/json' },

          body: bodyOf(form),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {

        showFailure(NETWORK_FAILURE, []);
        return;
      }

      if (response.ok) {

        try {
          wiring.emitSubmit(direction, contactChannel);
        } catch {

          /* */
        }
        try {
          writeLeadState(direction);
        } catch {

          /* */
        }

        let shown = false;
        try {
          shown = wiring.onSuccess();
        } catch {
          shown = false;
        }

        if (!shown) location.assign(SUCCESS_ROUTE[locale]);
        return;
      }

      let code: string | undefined;
      let fields: string[] = [];
      try {
        const payload: unknown = await response.json();
        if (typeof payload === 'object' && payload !== null) {
          const record = payload as Record<string, unknown>;
          if (typeof record.error === 'string') code = record.error;
          if (Array.isArray(record.fields)) {
            fields = record.fields.filter((name): name is string => typeof name === 'string');
          }
        }
      } catch {
        /* */
      }

      const shape =
        code !== undefined && code in FAILURE_BY_CODE
          ? FAILURE_BY_CODE[code as ErrorCode]
          : NETWORK_FAILURE;

      showFailure(shape, fields);

      if (TURNSTILE_ENABLED && code === ERROR_CODES.captchaFailed) {
        import('./turnstile.ts')
          .then((m) => {
            m.resetTurnstile();
          })
          .catch(() => {
            /* */
          });
      }
    })();
  });

  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    unlock();
    resetStatus();

    wiring.onRestore();
  });
}
