import type { WorkerPayload } from './invoke.js';
import { closeClickHouse, ensureSchema } from '../db/clickhouse.js';

export async function handler(event: WorkerPayload | { body?: string }): Promise<{ ok: boolean; type: string; detail?: unknown }> {
  const payload = normalize(event);
  const started = Date.now();
  console.log(`[worker] start ${payload.type}${'run_id' in payload ? ` ${payload.run_id}` : ''}`);
  try {
    await ensureSchema();
    if (payload.type === 'run_release_gate') {
      const { runReleaseGatePipeline } = await import('../services/pipeline.js');
      await runReleaseGatePipeline(payload.run_id);
      console.log(`[worker] done run_release_gate ${payload.run_id} in ${Date.now() - started} ms`);
      return { ok: true, type: payload.type };
    }
    if (payload.type === 'seed') {
      const { seedDatabase } = await import('../domain/seed.js');
      const { invalidateStatsCache } = await import('../services/state.js');
      const { invalidateCatalogCache } = await import('../domain/catalog.js');
      const result = await seedDatabase({ force: payload.force !== false, log: (m) => console.log(`[seed] ${m}`) });
      invalidateStatsCache();
      invalidateCatalogCache();
      console.log(`[worker] done seed in ${Date.now() - started} ms (${result.stats.synthetic_rows_total} rows)`);
      return { ok: true, type: payload.type, detail: { rows: result.stats.synthetic_rows_total, skipped: result.skipped } };
    }
    throw new Error(`unknown worker payload type ${(payload as { type: string }).type}`);
  } catch (err) {
    console.error(`[worker] failed ${payload.type}:`, (err as Error).stack ?? err);
    if (payload.type === 'run_release_gate') {
      try {
        const { failRun } = await import('../services/runs.js');
        await failRun(payload.run_id, { message: (err as Error).message, retryable: true, hint: null });
      } catch (inner) {
        console.error('[worker] could not mark run failed', inner);
      }
    }
    return { ok: false, type: payload.type, detail: (err as Error).message };
  }
}

function normalize(event: WorkerPayload | { body?: string }): WorkerPayload {
  if (event && typeof (event as { body?: string }).body === 'string') return JSON.parse((event as { body: string }).body) as WorkerPayload;
  return event as WorkerPayload;
}
