
import { WEBHOOK_PATH, handleWebhook } from './webhook.ts';
import type { BotEnv, BotExecutionContext } from './webhook.ts';
import { handleAdmin } from './admin.ts';
import { NO_LEADS_CRON, runNoLeadsCycle, runUptimeCycle } from './monitor-run.ts';
import type { MonitorEnv } from './monitor-run.ts';

const ADMIN_PREFIX = '/admin/';

interface BotScheduledEvent {
  readonly cron: string;
}

export default {
  async fetch(
    request: Request,
    env: BotEnv,
    ctx: BotExecutionContext,
  ): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === WEBHOOK_PATH) return handleWebhook(request, env, ctx);
    if (pathname.startsWith(ADMIN_PREFIX)) return handleAdmin(request, env);

    return new Response(null, { status: 404 });
  },

  async scheduled(
    event: BotScheduledEvent,
    env: MonitorEnv,
    ctx: BotExecutionContext,
  ): Promise<void> {
    const cycle =
      event.cron === NO_LEADS_CRON ? runNoLeadsCycle(env) : runUptimeCycle(env);
    const guarded = cycle.then(
      () => undefined,
      () => undefined,
    );
    ctx.waitUntil(guarded);
    await guarded;
  },
};
