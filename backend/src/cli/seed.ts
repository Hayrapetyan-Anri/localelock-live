import { seedDatabase } from '../domain/seed.js';
import { closeClickHouse } from '../db/clickhouse.js';
import { getConfig, hostHint } from '../config.js';

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const cfg = await getConfig();
  console.log(`[seed] target ${hostHint(cfg.clickhouse.host)} / ${cfg.clickhouse.database}${force ? ' (force)' : ''}`);
  const result = await seedDatabase({ force, log: (m) => console.log(`[seed] ${m}`) });
  if (result.skipped) {
    console.log('[seed] skipped (already seeded at this seed_version)');
  } else {
    console.log('[seed] inserted:', JSON.stringify(result.inserted));
  }
  console.log('[seed] counts:', JSON.stringify(result.stats.counts));
  console.log(`[seed] synthetic_rows_total=${result.stats.synthetic_rows_total} titles=${result.stats.titles} locales=${result.stats.locales} duration_ms=${result.duration_ms}`);
}

main()
  .catch((err) => {
    console.error('[seed] failed:', (err as Error).stack ?? err);
    process.exitCode = 1;
  })
  .finally(() => closeClickHouse());
