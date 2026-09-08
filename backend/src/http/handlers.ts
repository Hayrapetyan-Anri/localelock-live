import { getConfig } from '../config.js';
import { closeClickHouse, ensureSchema } from '../db/clickhouse.js';
import { ApiError } from './errors.js';
import { RESET_LIMITS, RUN_LIMITS, enforce } from './rateLimit.js';
import { runsStartedSince } from '../services/runs.js';

async function enforceGlobalRunBudget(): Promise<void> {
  const started = await runsStartedSince(RUN_LIMITS.global.windowMs);
  if (started >= RUN_LIMITS.global.limit) {
    throw new ApiError(
      429,
      'RATE_LIMITED',
      `This public demo has already run ${started} release gates in the last hour and is cost-capped. Try again shortly, or clone the repository and run it against your own ClickHouse and Gemini project.`,
      { limit: RUN_LIMITS.global.limit, window_ms: RUN_LIMITS.global.windowMs, started },
    );
  }
}
import { Router, json, text, parseJsonBody, type HttpRequest } from './router.js';
import { createRun, getRun, listRuns } from '../services/runs.js';
import { deliveredSrt, exportSrt, requireApprovedRun, setRecheckRunId, submitApprovals } from '../services/approvals.js';
import { getDemoState, getHealth, getJudgeStatus, invalidateStatsCache } from '../services/state.js';
import { ResetRateLimited, resetDemo } from '../domain/seed.js';
import { enqueueWorker } from '../lambda/invoke.js';
import type { ApprovalRequest, CreateRunRequest, CreateRunResponse, RecheckResponse, ResetResponse } from '../domain/constants.js';
import { readMeta } from '../domain/seed.js';

const RUN_TRIGGERS = new Set(['vendor_delivery', 'source_revision', 'recheck_after_approval', 'manual']);

function demoKey(req: HttpRequest): string | null {
  return req.headers['x-demo-key'] ?? null;
}

async function requireAdminKey(req: HttpRequest): Promise<void> {
  const cfg = await getConfig();
  if (!cfg.demoAdminKey) throw new ApiError(503, 'UNAUTHORIZED', 'DEMO_ADMIN_KEY is not configured on the server');
  if (demoKey(req) !== cfg.demoAdminKey) throw new ApiError(401, 'UNAUTHORIZED', 'Missing or invalid X-Demo-Key');
}

function pollUrl(run_id: string): string {
  return `/runs/${run_id}`;
}

export function buildRouter(): Router {
  const r = new Router();

  r.get('/', async () => json(200, { service: 'localelock-live', ok: true, docs: ['/health', '/demo/state', '/runs', '/judge/status'] }));

  r.get('/health', async (req) => {
    const deep = req.query.deep === '1' || req.query.deep === 'true';
    const health = await getHealth({ deep });
    return json(health.ok ? 200 : 503, health);
  });

  r.get('/demo/state', async () => json(200, await getDemoState()));

  r.post('/runs', async (req) => {
    enforce(req, 'runs', [RUN_LIMITS.perCaller]);
    await enforceGlobalRunBudget();
    const body = parseJsonBody<CreateRunRequest>(req);
    if (body.trigger !== undefined && !RUN_TRIGGERS.has(body.trigger)) throw new ApiError(400, 'BAD_REQUEST', `Unknown trigger ${String(body.trigger)}`);
    if (body.title_id !== undefined && typeof body.title_id !== 'string') throw new ApiError(400, 'BAD_REQUEST', 'title_id must be a string');
    if (body.locale !== undefined && typeof body.locale !== 'string') throw new ApiError(400, 'BAD_REQUEST', 'locale must be a string');
    const { run, created } = await createRun({ title_id: body.title_id, locale: body.locale, trigger: body.trigger });
    if (created) await enqueueWorker({ type: 'run_release_gate', run_id: run.run_id });
    const res: CreateRunResponse = { run_id: run.run_id, status: 'queued', poll_url: pollUrl(run.run_id) };
    return json(created ? 202 : 200, res);
  });

  r.get('/runs', async (req) => {
    const limit = Number(req.query.limit ?? 10);
    const runs = await listRuns({ limit: Number.isFinite(limit) ? limit : 10, title_id: req.query.title_id, locale: req.query.locale });
    return json(200, { runs });
  });

  r.get('/runs/{run_id}', async (_req, p) => {
    await ensureSchema();
    const run = await getRun(p.run_id);
    if (!run) throw new ApiError(404, 'NOT_FOUND', `Run ${p.run_id} not found`);
    return json(200, run);
  });

  r.post('/runs/{run_id}/approvals', async (req, p) => {
    const body = parseJsonBody<ApprovalRequest>(req);
    const out = await submitApprovals(p.run_id, body);
    return json(out.status, out.body);
  });

  r.get('/deliveries/{title_id}/{locale}/{version}.srt', async (_req, p) => {
    const version = Number(p.version);
    if (!Number.isFinite(version)) throw new ApiError(400, 'BAD_REQUEST', 'version must be a number');
    const srt = await deliveredSrt(p.title_id, p.locale, version);
    return text(200, srt.text, {
      'content-disposition': `attachment; filename="${srt.filename}"`,
      'x-sha256': srt.sha256,
      'cache-control': 'no-store',
    });
  });

  r.get('/runs/{run_id}/export.srt', async (_req, p) => {
    const srt = await exportSrt(p.run_id);
    return text(200, srt.text, {
      'content-disposition': `attachment; filename="${srt.filename}"`,
      'x-patch-hash': srt.sha256,
      'cache-control': 'no-store',
    });
  });

  r.post('/runs/{run_id}/recheck', async (_req, p) => {
    enforce(_req, 'runs', [RUN_LIMITS.perCaller]);
    await enforceGlobalRunBudget();
    const parent = await requireApprovedRun(p.run_id);
    if (parent.recheck_run_id) {
      const existing = await getRun(parent.recheck_run_id);
      if (existing && existing.release_state !== 'FAILED') {
        const res: RecheckResponse = { run_id: existing.run_id, parent_run_id: parent.run_id, status: 'existing', poll_url: pollUrl(existing.run_id) };
        return json(200, res);
      }
    }
    const { run, created } = await createRun({
      title_id: parent.title_id,
      locale: parent.locale,
      trigger: 'recheck_after_approval',
      version: parent.approval.approved_version,
      parent_run_id: parent.run_id,
    });
    await setRecheckRunId(parent.run_id, run.run_id);
    if (created) await enqueueWorker({ type: 'run_release_gate', run_id: run.run_id });
    const res: RecheckResponse = { run_id: run.run_id, parent_run_id: parent.run_id, status: created ? 'queued' : 'existing', poll_url: pollUrl(run.run_id) };
    return json(created ? 202 : 200, res);
  });

  r.post('/admin/reset', async (req) => {
    const cfg = await getConfig();
    if (cfg.resetRequiresKey) await requireAdminKey(req);
    else enforce(req, 'reset', [RESET_LIMITS.perCaller]);
    try {
      const result = await resetDemo();
      invalidateStatsCache();
      const { invalidateCatalogCache } = await import('../domain/catalog.js');
      invalidateCatalogCache();
      const state = await getDemoState();
      const res: ResetResponse = { ok: true, removed: result.removed, state };
      return json(200, res);
    } catch (err) {
      if (err instanceof ResetRateLimited) {
        throw new ApiError(429, 'RATE_LIMITED', err.message, { retry_after_ms: err.retry_after_ms });
      }
      throw err;
    }
  });

  r.post('/admin/seed', async (req) => {
    await requireAdminKey(req);
    const body = parseJsonBody<{ force?: boolean }>(req);
    await enqueueWorker({ type: 'seed', force: body.force !== false });
    return json(202, { queued: true });
  });

  r.get('/admin/seed/status', async () => {
    const meta = await readMeta();
    if (!meta) return json(200, { seeded: false });
    return json(200, { seeded: true, ...meta });
  });

  r.get('/catalog/risk', async () => {
    const { catalogRisk } = await import('../domain/catalog.js');
    return json(200, await catalogRisk());
  });

  r.get('/catalog/deliveries/{title_id}/{locale}/{version}/cues', async (_req, p) => {
    const version = Number(p.version);
    if (!Number.isFinite(version)) throw new ApiError(400, 'BAD_REQUEST', 'version must be a number');
    const { deliveryRiskCues } = await import('../domain/catalog.js');
    const { cues, stat } = await deliveryRiskCues(p.title_id, p.locale, version);
    return json(200, { title_id: p.title_id, locale: p.locale, version, cues, query: stat });
  });

  r.get('/judge/status', async (req) => {
    const apiBase = req.baseUrl ? `${req.baseUrl}${req.path.startsWith('/api') ? '/api' : ''}` : '/api';
    return json(200, await getJudgeStatus({ apiBase }));
  });

  return r;
}

let routerSingleton: Router | null = null;
export function router(): Router {
  if (!routerSingleton) routerSingleton = buildRouter();
  return routerSingleton;
}
