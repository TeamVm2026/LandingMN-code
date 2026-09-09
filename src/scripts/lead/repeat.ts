
import { readLeadState, clearLeadState } from './state.ts';
import { revealBelowSticky } from './reveal.ts';

const PANEL_CLASS = 'lead-repeat';

const SUCCESS_TITLE_ID = 'lead-success-title';

interface PanelStrings {
  title: string;
  body: string;
  cta: string;
  href: string;
}

function buildPanel(
  marker: 'data-lead-repeat' | 'data-lead-success',
  strings: PanelStrings,
): { panel: HTMLDivElement; titleEl: HTMLParagraphElement } {
  const panel = document.createElement('div');
  panel.className = PANEL_CLASS;
  panel.setAttribute(marker, '');

  const titleEl = document.createElement('p');
  titleEl.className = `${PANEL_CLASS}__title type-body-bold`;
  titleEl.textContent = strings.title;

  const bodyEl = document.createElement('p');
  bodyEl.className = `${PANEL_CLASS}__body type-body`;
  bodyEl.textContent = strings.body;

  const ctaEl = document.createElement('a');
  ctaEl.className = `${PANEL_CLASS}__cta type-body-bold`;
  ctaEl.href = strings.href;
  ctaEl.target = '_blank';
  ctaEl.rel = 'noopener noreferrer';
  ctaEl.textContent = strings.cta;

  panel.appendChild(titleEl);
  panel.appendChild(bodyEl);
  panel.appendChild(ctaEl);

  return { panel, titleEl };
}

function swapFormFor(form: HTMLFormElement, panel: HTMLElement, afterInsert?: () => void): void {
  form.insertAdjacentElement('afterend', panel);
  afterInsert?.();
  form.hidden = true;
}

export function mountRepeatPanel(): void {
  const form = document.querySelector<HTMLFormElement>('[data-lead-form]');
  if (!form) return;

  if (form.parentElement?.querySelector(`.${PANEL_CLASS}`)) return;

  if (!readLeadState()) return;

  const title = form.dataset.repeatTitle;
  const body = form.dataset.repeatBody;
  const cta = form.dataset.repeatCta;
  const reset = form.dataset.repeatReset;
  const href = form.dataset.repeatHref;

  if (!title || !body || !cta || !reset || !href) return;

  const { panel } = buildPanel('data-lead-repeat', { title, body, cta, href });

  const resetEl = document.createElement('button');
  resetEl.type = 'button';
  resetEl.className = `${PANEL_CLASS}__reset type-body`;
  resetEl.textContent = reset;
  resetEl.addEventListener('click', () => {
    clearLeadState();
    panel.remove();
    form.hidden = false;

    form
      .querySelector<HTMLElement>('input:not([type="hidden"]):not([hidden]), select, textarea')
      ?.focus();
  });

  panel.appendChild(resetEl);

  swapFormFor(form, panel);
}

export function mountSuccessPanel(): boolean {
  const form = document.querySelector<HTMLFormElement>('[data-lead-form]');
  if (!form) return false;

  if (form.parentElement?.querySelector(`.${PANEL_CLASS}`)) return true;

  const title = form.dataset.successTitle;
  const body = form.dataset.repeatBody;
  const cta = form.dataset.repeatCta;
  const href = form.dataset.repeatHref;

  if (!title || !body || !cta || !href) return false;

  const { panel, titleEl } = buildPanel('data-lead-success', { title, body, cta, href });

  titleEl.id = SUCCESS_TITLE_ID;
  panel.setAttribute('tabindex', '-1');
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-labelledby', SUCCESS_TITLE_ID);

  swapFormFor(form, panel, () => {

    panel.focus({ preventScroll: true });
  });

  revealBelowSticky(panel);
  return true;
}
