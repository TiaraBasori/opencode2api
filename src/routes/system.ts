// P4 TS: system routes (models/health/details/metrics/404) (ported from P3 .js, behavior identical).
import type { Application, Request, Response } from 'express';
import type { AppContext } from '../types/context.js';

function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String((e as Record<string, unknown>)?.['message'] ?? e);
}

export function registerSystemRoutes(app: Application, ctx: AppContext): void {
  const {
    API_KEY,
    INTERNAL_TOOL_METRICS_ENABLED,
    INTERNAL_TOOL_DISCOVERY_FIXTURE,
    HEALTH_DETAILS_ENABLED,
    HEALTH_DETAILS_REQUIRE_AUTH,
    METRICS_ENABLED,
    METRICS_REQUIRE_AUTH,
    SERVER_INTERNAL_ALLOWED_TOOL_NAMES,
    getProvidersList,
    buildModelsList,
    normalizeConfiguredToolNames,
    internalToolMetrics,
    getCachedToolIds,
    getCachedToolIdsAt,
  } = ctx;
  const hasValidBearerAuth = (req: Request): boolean => {
    if (!API_KEY || API_KEY.trim() === '') return true;
    const authHeader: unknown = req.headers.authorization;
    const apiKeyHeader: unknown = req.headers['x-api-key'];
    return Boolean(
      (authHeader && authHeader === `Bearer ${API_KEY}`) || (apiKeyHeader && apiKeyHeader === API_KEY),
    );
  };

  const shouldAllowOperationalEndpoint = (
    req: Request,
    opts: { enabled: unknown; requireAuth: unknown },
  ): boolean => {
    if (!opts.enabled) return false;
    if (!opts.requireAuth) return true;
    return hasValidBearerAuth(req);
  };

  // Models endpoint
  app.get('/v1/models', (_req: Request, res: Response): void => {
    void (async (): Promise<void> => {
      try {
        const models = buildModelsList(await getProvidersList());
        res.json({ object: 'list', data: models });
      } catch (error: unknown) {
        console.error('[Proxy] Model Fetch Error:', toErrorMessage(error));
        res.json({ object: 'list', data: [{ id: 'opencode/kimi-k2.5-free', object: 'model' }] });
      }
    })();
  });

  app.get('/health', (_req: Request, res: Response): void => {
    res.json({
      status: 'ok',
      proxy: true,
    });
  });

  app.get('/health/details', (req: Request, res: Response): void => {
    if (
      !shouldAllowOperationalEndpoint(req, {
        enabled: HEALTH_DETAILS_ENABLED,
        requireAuth: HEALTH_DETAILS_REQUIRE_AUTH,
      })
    ) {
      res.status(HEALTH_DETAILS_ENABLED ? 401 : 404).json({
        error: { message: HEALTH_DETAILS_ENABLED ? 'Unauthorized' : 'Not found' },
      });
      return;
    }
    const metricsSnapshot = INTERNAL_TOOL_METRICS_ENABLED ? { ...internalToolMetrics } : null;
    const cached = getCachedToolIds();
    const cachedAt = getCachedToolIdsAt();
    res.json({
      status: 'ok',
      proxy: true,
      internal_tools: {
        config: {
          allowed_tools: SERVER_INTERNAL_ALLOWED_TOOL_NAMES,
          metrics_enabled: INTERNAL_TOOL_METRICS_ENABLED,
          discovery_fixture: normalizeConfiguredToolNames(INTERNAL_TOOL_DISCOVERY_FIXTURE),
        },
        metrics: metricsSnapshot,
        cache: {
          tool_ids_cached: !!cached,
          tool_id_count: cached ? cached.length : 0,
          age_ms: cachedAt ? Date.now() - cachedAt : null,
        },
        audit: {
          available: true,
          fields: [
            'requestedAllowlist',
            'allowedToolNames',
            'deniedRequestedTools',
            'resolutionPath',
            'resultingMode',
          ],
        },
      },
    });
  });

  app.get('/metrics', (req: Request, res: Response): void => {
    if (
      !shouldAllowOperationalEndpoint(req, {
        enabled: METRICS_ENABLED,
        requireAuth: METRICS_REQUIRE_AUTH,
      })
    ) {
      res.status(METRICS_ENABLED ? 401 : 404).send(METRICS_ENABLED ? 'Unauthorized' : 'Not found');
      return;
    }

    const cached = getCachedToolIds();
    const metricsLines = [
      '# HELP opencode_internal_tool_mode_requests_total Count of internal tool mode selections by mode.',
      '# TYPE opencode_internal_tool_mode_requests_total counter',
      `opencode_internal_tool_mode_requests_total{mode="external_bridge"} ${internalToolMetrics.externalBridgeRequests}`,
      `opencode_internal_tool_mode_requests_total{mode="internal_allowlist"} ${internalToolMetrics.internalAllowlistRequests}`,
      `opencode_internal_tool_mode_requests_total{mode="disabled"} ${internalToolMetrics.disabledRequests}`,
      '# HELP opencode_internal_tool_discovery_failures_total Count of backend tool discovery failures.',
      '# TYPE opencode_internal_tool_discovery_failures_total counter',
      `opencode_internal_tool_discovery_failures_total ${internalToolMetrics.discoveryFailures}`,
      '# HELP opencode_internal_tool_fallback_disabled_total Count of allowlist resolutions that fell back to disabled.',
      '# TYPE opencode_internal_tool_fallback_disabled_total counter',
      `opencode_internal_tool_fallback_disabled_total ${internalToolMetrics.fallbackToDisabled}`,
      '# HELP opencode_internal_tool_cache_ids Number of cached backend tool IDs.',
      '# TYPE opencode_internal_tool_cache_ids gauge',
      `opencode_internal_tool_cache_ids ${cached ? cached.length : 0}`,
    ];

    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(`${metricsLines.join('\n')}\n`);
  });
}

export function registerNotFoundRoute(app: Application): void {
  app.use((req: Request, res: Response): void => {
    res.status(404).json({
      error: {
        message: `Route not found: ${req.method} ${req.path}`,
        type: 'not_found_error',
      },
    });
  });
}
