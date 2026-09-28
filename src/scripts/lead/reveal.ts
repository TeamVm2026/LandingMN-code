
export function revealFully(el: HTMLElement): void {

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const behavior: ScrollBehavior = reduced ? 'auto' : 'smooth';

  const rect = el.getBoundingClientRect();

  if (rect.top >= 0 && rect.bottom <= window.innerHeight) return;
  el.scrollIntoView({ block: rect.top < 0 ? 'nearest' : 'end', behavior });
}
