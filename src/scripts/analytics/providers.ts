
import { config } from '../../config';
import { readAttribution, attributionSummary } from '../../lib/attribution';
import { initGa4 } from './ga4';
import { initClarity } from './clarity';
import { resolveAnalyticsDefault } from './consent';
import { isInternalHost } from './environment';

export async function initProviders(): Promise<void> {
  const { gaId, clarityId } = config.analytics;

  const summary = attributionSummary(readAttribution());

  const internal = isInternalHost(window.location.hostname, config.siteUrl);

  if (clarityId) {
    initClarity(clarityId, {
      lang: document.documentElement.lang,
      ft_source: summary.source,

      env: internal ? 'test' : 'prod',
    });
  }

  if (gaId) {

    const analyticsDefault = await resolveAnalyticsDefault();

    const props: Record<string, string> = {};
    if (summary.source) props.ft_source = summary.source;
    if (summary.campaign) props.ft_campaign = summary.campaign;
    if (summary.medium) props.ft_medium = summary.medium;
    initGa4(gaId, analyticsDefault, props, internal);
  }
}
