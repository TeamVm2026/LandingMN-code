
export function revealBelowSticky(el: HTMLElement): void {

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const behavior: ScrollBehavior = reduced ? 'auto' : 'smooth';

  const rect = el.getBoundingClientRect();
  const reserved = Number.parseFloat(getComputedStyle(el).scrollMarginBottom) || 0;

  if (rect.top >= 0 && rect.bottom + reserved <= window.innerHeight) return;
  el.scrollIntoView({ block: rect.top < 0 ? 'nearest' : 'end', behavior });
}
