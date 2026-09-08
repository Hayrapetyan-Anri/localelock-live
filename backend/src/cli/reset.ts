import { resetDemo } from '../domain/seed.js';
import { closeClickHouse } from '../db/clickhouse.js';
import { getConfig, hostHint } from '../config.js';

async function main(): Promise<void> {
  const cfg = await getConfig();
  console.log(`[reset] target ${hostHint(cfg.clickhouse.host)} / ${cfg.clickhouse.database}`);
  const result = await resetDemo();
  console.log('[reset] removed:', JSON.stringify(result.removed));
  console.log(`[reset] T0=${result.t0} release_at=${result.release_at} duration_ms=${result.duration_ms}`);
}

main()
  .catch((err) => {
    console.error('[reset] failed:', (err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => closeClickHouse());
