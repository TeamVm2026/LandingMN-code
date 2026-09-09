
import { setCommonParams, track } from './analytics/bus';
import { maybeRegisterDebugSink } from './analytics/debug-sink';
import { readAttribution, attributionSummary } from '../lib/attribution';
import { ANALYTICS_ENABLED, TURNSTILE_ENABLED } from '../config';
import { mountRepeatPanel, mountSuccessPanel } from './lead/repeat.ts';
import { mountLeadSubmit, type SubmitErrorType } from './lead/submit.ts';

import { DIRECTIONS, type Direction } from '../lib/start-codec.ts';

import { installClientErrorReporter } from './report/client-error.ts';

import {
  applyConsentChoice,
  isConsentRequiredRegion,
  readConsentChoice,
  writeConsentChoice,
  type ConsentChoice,
} from './analytics/consent';

import { regionOnce } from './analytics/region';

mountRepeatPanel();

installClientErrorReporter();

{
  const directionCards = Array.from(
    document.querySelectorAll<HTMLDetailsElement>('details[data-track-direction]'),
  );

  if (directionCards.length > 0) {

    const openedCards = new WeakSet<HTMLDetailsElement>();

    const isDirection = (value: string): value is Direction =>
      Object.prototype.hasOwnProperty.call(DIRECTIONS, value);

    for (const card of directionCards) {

      card.addEventListener('toggle', () => {
        const direction = card.dataset.trackDirection;
        if (!direction || !isDirection(direction)) return;

        if (card.open) {
          if (openedCards.has(card)) return;
          openedCards.add(card);

          track('direction_select', { direction, placement: 'card' });
        } else {
          openedCards.delete(card);
        }

      });
    }
  }
}

{

  const korni = getComputedStyle(document.documentElement);
  const chislo = (imya: string, zapas: number): number => {
    const v = korni.getPropertyValue(imya).trim();

    const m = /^([\d.]+)(ms|s|px)?$/.exec(v);
    if (!m) return zapas;
    const n = Number.parseFloat(m[1]!);
    return Number.isFinite(n) ? (m[2] === 's' ? n * 1000 : n) : zapas;
  };
  const DLIT = chislo('--motion-reveal', 400);
  const ZAZOR = chislo('--space-md', 16);

  const krivaya = ((): ((t: number) => number) => {
    const v = korni.getPropertyValue('--ease-reveal').trim();
    const m = /^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/.exec(v);
    if (!m) return (t) => t;
    const [x1, y1, x2, y2] = m.slice(1, 5).map(Number) as [number, number, number, number];
    const bez = (a: number, b: number, t: number): number => {
      const u = 1 - t;
      return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
    };

    return (t: number): number => {
      let g = t;
      for (let i = 0; i < 5; i++) {
        const x = bez(x1, x2, g) - t;
        const u = 1 - g;
        const d = 3 * u * u * x1 + 6 * u * g * (x2 - x1) + 3 * g * g * (1 - x2);
        if (Math.abs(d) < 1e-6) break;
        g -= x / d;
        if (g < 0) g = 0;
        else if (g > 1) g = 1;
      }
      return bez(y1, y2, g);
    };
  })();

  const tishe = window.matchMedia('(prefers-reduced-motion: reduce)');
  let idyot: number | null = null;

  const stop = (): void => {
    if (idyot !== null) cancelAnimationFrame(idyot);
    idyot = null;
    window.removeEventListener('wheel', stop);
    window.removeEventListener('touchstart', stop);
    window.removeEventListener('keydown', stop);
  };

  const podvesti = (cel: number): void => {
    const start = window.scrollY;
    const put = cel - start;

    if (Math.abs(put) < 1) return;

    if (tishe.matches) {
      window.scrollTo(0, cel);
      return;
    }

    stop();

    window.addEventListener('wheel', stop, { passive: true, once: true });
    window.addEventListener('touchstart', stop, { passive: true, once: true });
    window.addEventListener('keydown', stop, { once: true });

    const t0 = performance.now();
    const shag = (t: number): void => {
      const dolya = Math.min(1, (t - t0) / DLIT);

      const potolok = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo(0, Math.min(start + put * krivaya(dolya), potolok));
      if (dolya < 1) idyot = requestAnimationFrame(shag);
      else stop();
    };
    idyot = requestAnimationFrame(shag);
  };

  const akkordeony = document.querySelectorAll<HTMLDetailsElement>(
    'details.direction-card, details.faq-item',
  );

  for (const blok of akkordeony) {
    blok.addEventListener('toggle', () => {

      if (blok.open) return;
      const shapka = blok.querySelector<HTMLElement>('summary');
      if (!shapka) return;

      const box = shapka.getBoundingClientRect();

      if (box.top >= 0) return;

      podvesti(Math.max(0, window.scrollY + box.top - ZAZOR));
    });
  }
}

{
  const contactInput = document.querySelector<HTMLInputElement>('[data-contact-input]');
  const channels = document.querySelectorAll<HTMLInputElement>('input[name="contact_channel"]');

  if (contactInput && channels.length > 0) {
    const hints: Record<string, string | undefined> = {
      phone: contactInput.dataset.hintPhone,
      telegram: contactInput.dataset.hintTelegram,
      messenger: contactInput.dataset.hintMessenger,
    };

    const applyChannel = (value: string) => {
      if (value === 'phone') {
        contactInput.inputMode = 'tel';
        contactInput.autocomplete = 'tel';
      } else {
        contactInput.inputMode = 'text';

        contactInput.autocomplete = 'username';
      }

      const hint = hints[value];
      if (hint) contactInput.placeholder = hint;
    };

    for (const radio of channels) {
      if (radio.checked) applyChannel(radio.value);
      radio.addEventListener('change', () => {
        if (radio.checked) applyChannel(radio.value);
      });
    }
  }
}

mountLeadSubmit({

  emitSubmit: emitFormSubmit,
  emitError: emitSubmitError,

  showFieldError,

  onRestore: mountRepeatPanel,

  onSuccess: mountSuccessPanel,
});

{
  const revealItems = document.querySelectorAll<HTMLElement>('.reveal-item');
  const motionOk = window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
  const wideEnough = window.matchMedia('(min-width: 860px)').matches;

  if (revealItems.length > 0 && motionOk && wideEnough && 'IntersectionObserver' in window) {
    const pending: HTMLElement[] = [];

    for (const item of revealItems) {
      const rect = item.getBoundingClientRect();

      if (rect.top >= window.innerHeight) {
        item.classList.add('is-pending');
        pending.push(item);
      }
    }

    if (pending.length > 0) {
      const show = (item: Element, observer: IntersectionObserver) => {

        item.classList.add('is-revealed');
        item.classList.remove('is-pending');
        observer.unobserve(item);
      };

      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {

            if (entry.isIntersecting || entry.boundingClientRect.top < 0) {
              show(entry.target, observer);
            }
          }
        },

        { threshold: 0 },
      );

      for (const item of pending) observer.observe(item);

      window.addEventListener(
        'scrollend',
        () => {
          for (const item of pending) {
            if (!item.classList.contains('is-pending')) continue;
            if (item.getBoundingClientRect().top < window.innerHeight) {
              show(item, observer);
            }
          }
        },
        { passive: true },
      );
    }
  }
}

function showFieldError(field: HTMLElement, text: string): void {

  const holder = field.closest<HTMLElement>('.field, .consent-row');
  if (!holder) return;

  holder.classList.add('has-error');

  let note = holder.querySelector<HTMLElement>('[data-field-error]');
  if (!note) {
    note = document.createElement('p');
    note.className = 'field-error type-label';
    note.setAttribute('data-field-error', '');

    note.setAttribute('role', 'alert');
    holder.appendChild(note);
  }
  note.textContent = text;
}

{
  const form = document.querySelector<HTMLFormElement>('[data-lead-form]');

  if (form) {
    const messages = {
      required: form.dataset.errRequired ?? '',
      consent: form.dataset.errConsent ?? '',
      direction: form.dataset.errDirection ?? '',
    };

    const clearError = (field: HTMLElement) => {
      const holder = field.closest<HTMLElement>('.field, .consent-row');
      if (!holder) return;

      if (holder.querySelector('input:invalid, select:invalid, textarea:invalid')) return;
      holder.classList.remove('has-error');
      holder.querySelector('[data-field-error]')?.remove();
    };

    const messageFor = (el: HTMLInputElement): string => {
      if (el.type === 'checkbox') return messages.consent;
      if (el.type === 'radio') return messages.direction;
      return messages.required;
    };

    const isTrimmable = (el: HTMLInputElement): boolean =>
      el.required &&
      el.type !== 'checkbox' &&
      el.type !== 'radio' &&
      el.type !== 'hidden' &&
      typeof el.setCustomValidity === 'function';

    const refreshBlankState = (el: HTMLInputElement): void => {
      if (!isTrimmable(el)) return;

      const blankByTrim = el.value !== '' && el.value.trim() === '';
      el.setCustomValidity(blankByTrim ? messages.required : '');
    };

    const refreshAllBlankStates = (): void => {
      for (const el of form.querySelectorAll<HTMLInputElement>('input, textarea')) {
        refreshBlankState(el);
      }
    };

    form.addEventListener(
      'input',
      (event) => {
        refreshBlankState(event.target as HTMLInputElement);
      },
      true,
    );

    form.addEventListener('click', refreshAllBlankStates, true);

    form.addEventListener(
      'invalid',
      (event) => {
        const field = event.target as HTMLInputElement;

        event.preventDefault();
        showFieldError(field, messageFor(field));

        emitFormError(field);

        if (!form.querySelector('.has-error [data-focus-moved]')) {
          field.setAttribute('data-focus-moved', '');
          field.focus({ preventScroll: false });
          window.setTimeout(() => field.removeAttribute('data-focus-moved'), 0);
        }
      },
      true,
    );

    for (const eventName of ['input', 'change'] as const) {
      form.addEventListener(eventName, (event) => {
        const field = event.target as HTMLInputElement;
        if (typeof field.checkValidity === 'function' && field.checkValidity()) {
          clearError(field);
        }
      });
    }
  }
}

declare global {
  interface Window {

    __lmnEmit?: { formSubmit: (direction: string, contactChannel: string) => void };
  }
}

const LANG_INTENT_KEY = 'lmn_lang_intent';

const LANG_INTENT_TTL_MS = 60_000;

const debugSinkOn = maybeRegisterDebugSink();

{
  const summary = attributionSummary(readAttribution());

  const common: Record<string, string> = { lang: document.documentElement.lang };
  if (summary.source) common.ft_source = summary.source;
  if (summary.campaign) common.ft_campaign = summary.campaign;
  setCommonParams(common);
}

document.addEventListener(
  'click',
  (event) => {
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== 'function') return;

    const langLink = target.closest<HTMLAnchorElement>('.lang-item[href]');
    if (langLink) {
      try {
        sessionStorage.setItem(
          LANG_INTENT_KEY,
          JSON.stringify({
            from: document.documentElement.lang,
            to: langLink.getAttribute('hreflang'),
            ts: Date.now(),
          }),
        );
      } catch {
        /* */
      }
    }

    const el = target.closest<HTMLElement>('[data-track]');
    if (!el) return;

    if (el.dataset.track !== 'messenger_click') return;

    track('messenger_click', {
      channel: el.dataset.trackChannel,
      placement: el.dataset.trackPlacement,

      direction: el.dataset.program || 'none',
      start_payload: startPayloadOf(el),
    });
  },
  { passive: true, capture: true },
);

function startPayloadOf(el: HTMLElement): string | undefined {
  const href = (el as HTMLAnchorElement).href;
  if (!href) return undefined;
  try {
    return new URL(href).searchParams.get('start') ?? undefined;
  } catch {
    return undefined;
  }
}

{
  try {
    const raw = sessionStorage.getItem(LANG_INTENT_KEY);
    if (raw) {

      sessionStorage.removeItem(LANG_INTENT_KEY);

      const intent = JSON.parse(raw) as { from?: unknown; to?: unknown; ts?: unknown };
      const lang = document.documentElement.lang;
      const fresh = typeof intent.ts === 'number' && Date.now() - intent.ts < LANG_INTENT_TTL_MS;

      const arrived = typeof intent.to === 'string' && intent.to === lang;

      if (fresh && arrived && typeof intent.from === 'string') {
        track('language_change', { lang_from: intent.from, lang_to: lang });
      }
    }
  } catch {
    /* */
  }
}

{
  const form = document.querySelector<HTMLElement>('[data-track-form]');
  if (form) {
    const placement = form.dataset.trackForm || 'form';
    const onFirstFocus = (): void => {
      form.removeEventListener('focusin', onFirstFocus);

      track('form_open', { placement, direction: selectedDirection() });

      if (TURNSTILE_ENABLED) {

        import('./lead/turnstile.ts')
          .then((m) => {
            m.ensureTurnstile();
          })
          .catch(() => {
            /* */
          });
      }
    };

    form.addEventListener('focusin', onFirstFocus);
  }
}

function selectedDirection(): string {
  const checked = document.querySelector<HTMLInputElement>('input[name="direction"]:checked');
  return checked?.value ?? 'none';
}

let errorBurst = false;

function emitFormError(field: HTMLInputElement): void {
  if (errorBurst) return;
  errorBurst = true;
  window.setTimeout(() => {
    errorBurst = false;
  }, 0);

  track('form_error', {
    error_type: 'validation',

    field: field.name || field.id || 'unknown',
  });
}

function emitFormSubmit(direction: string, contactChannel: string): void {
  track('form_submit', { direction, contact_channel: contactChannel });
}

function emitSubmitError(errorType: SubmitErrorType, field?: string): void {
  track('form_error', {

    error_type: errorType,
    field,
  });
}

if (debugSinkOn) {
  window.__lmnEmit = { formSubmit: emitFormSubmit };
}

if (ANALYTICS_ENABLED) {

  mountConsentControl();

  const boot = (): void => {
    const go = (): void => {

      import('./analytics/providers')
        .then(async (m) => {

          await m.initProviders();

          resumeOrAskConsent().catch(() => {
            /* */
          });
        })
        .catch(() => {
          /* */
        });
    };

    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(go, { timeout: 4000 });
    } else {

      window.setTimeout(go, 2000);
    }
  };

  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot, { once: true });
}

async function resumeOrAskConsent(): Promise<void> {
  try {

    const saved = readConsentChoice();
    if (saved) {
      applyConsentChoice(saved);
      return;
    }

    const banner = document.querySelector<HTMLElement>('[data-consent-banner]');
    if (!banner) return;

    const loc = await regionOnce();
    if (!isConsentRequiredRegion(loc)) return;

    openConsentBanner(banner);
  } catch {

    /* */
  }
}

function openConsentBanner(banner: HTMLElement): void {
  const root = document.documentElement;

  const publishHeight = (): void => {
    root.style.setProperty('--consent-h', `${banner.offsetHeight}px`);
  };

  banner.hidden = false;
  publishHeight();

  requestAnimationFrame(() => {
    requestAnimationFrame(() => banner.classList.add('is-open'));
  });

  window.addEventListener('resize', publishHeight, { passive: true });

  let settled = false;

  const decide = (choice: ConsentChoice): void => {
    if (settled) return;
    settled = true;

    writeConsentChoice(choice);

    applyConsentChoice(choice);

    window.removeEventListener('resize', publishHeight);
    banner.classList.remove('is-open');

    root.style.setProperty('--consent-h', '0px');

    window.setTimeout(() => {
      banner.hidden = true;
    }, 400);
  };

  banner
    .querySelector<HTMLButtonElement>('[data-consent-accept]')
    ?.addEventListener('click', () => decide('granted'));
  banner
    .querySelector<HTMLButtonElement>('[data-consent-decline]')
    ?.addEventListener('click', () => decide('denied'));
}

function mountConsentControl(): void {
  try {

    const control = document.querySelector<HTMLElement>('[data-consent-control]');
    if (!control) return;

    const saved = readConsentChoice();
    if (!saved) return;

    const stateEl = control.querySelector<HTMLElement>('[data-consent-state]');
    const toggle = control.querySelector<HTMLButtonElement>('[data-consent-toggle]');

    if (!stateEl || !toggle) return;

    const stateOn = control.dataset.stateOn ?? '';
    const stateOff = control.dataset.stateOff ?? '';
    const actionOff = control.dataset.actionOff ?? '';
    const actionOn = control.dataset.actionOn ?? '';

    let current: ConsentChoice = saved;

    const render = (): void => {
      const on = current === 'granted';
      stateEl.textContent = on ? stateOn : stateOff;
      toggle.textContent = on ? actionOff : actionOn;
    };

    render();
    control.hidden = false;

    toggle.addEventListener('click', () => {
      const next: ConsentChoice = current === 'granted' ? 'denied' : 'granted';

      writeConsentChoice(next);

      applyConsentChoice(next);

      current = next;
      render();
    });
  } catch {

    /* */
  }
}
