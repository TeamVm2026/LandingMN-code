
import type { ConsoleMessage } from '@playwright/test';
import { isOffCloudflareNoise } from '../../scripts/lib/off-cloudflare.ts';

export { isOffCloudflareNoise, OFF_CLOUDFLARE_PATHS } from '../../scripts/lib/off-cloudflare.ts';

export function isOffCloudflareNoiseMessage(message: ConsoleMessage): boolean {
  return isOffCloudflareNoise(message.text(), message.location().url);
}
