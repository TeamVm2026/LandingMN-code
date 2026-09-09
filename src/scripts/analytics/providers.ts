
import { config } from '../../config';
import { readAttribution, attributionSummary } from '../../lib/attribution';
import { initGa4 } from './ga4';
import { initClarity } from './clarity';
import { resolveAnalyticsDefault } from './consent';

export async function initProviders(): Promise<void> {
  const { gaId, clarityId } = config.analytics;

  const summary = attributionSummary(readAttribution());

  if (clarityId) {
    initClarity(clarityId, {
      lang: document.documentElement.lang,
      ft_source: summary.source,
    });
  }

  if (gaId) {

    const analyticsDefault = await resolveAnalyticsDefault();

    const props: Record<string, string> = {};
    if (summary.source) props.ft_source = summary.source;
    if (summary.campaign) props.ft_campaign = summary.campaign;
    if (summary.medium) props.ft_medium = summary.medium;
    initGa4(gaId, analyticsDefault, props);
  }
}
