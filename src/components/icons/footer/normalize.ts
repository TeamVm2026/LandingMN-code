
export function normalizePackIcon(raw: string): string {
  return raw
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/fill="#000000"/g, 'fill="currentColor"')
    .replace(/\s+width="[^"]*"/, '')
    .replace(/\s+height="[^"]*"/, '')
    .trim();
}
