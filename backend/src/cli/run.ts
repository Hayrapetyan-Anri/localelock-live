import { createRun, getRun } from '../services/runs.js';
import { runReleaseGatePipeline } from '../services/pipeline.js';
import { requireApprovedRun } from '../services/approvals.js';
import { closeClickHouse } from '../db/clickhouse.js';
import { getConfig, hostHint } from '../config.js';
import type { ReleaseRun, SemanticEvidence } from '../domain/constants.js';

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : null;
}

function ms(n: number | null): string {
  return n === null ? '   -  ' : `${String(n).padStart(5)}ms`;
}

function printRun(run: ReleaseRun): void {
  console.log('\n── phases ──');
  for (const p of run.phases) console.log(`  ${p.phase.padEnd(24)} ${ms(p.duration_ms)}  ${p.note ?? ''}`);

  console.log('\n── MCP tool trace ──');
  for (const t of run.trace) {
    const flag = t.initiator === 'app_fallback' ? '⚠ app_fallback' : t.matched_expected ? '✓ agent' : '~ agent variant';
    console.log(`  ${String(t.step).padStart(2)}. ${(t.query_id ?? 'UNPLANNED').padEnd(24)} ${t.tool.padEnd(16)} ${ms(t.duration_ms)}  rows=${String(t.row_count).padStart(3)}  ${flag}`);
    if (!t.ok) console.log(`      error: ${t.error}`);
  }

  if (run.agent) {
    const a = run.agent;
    console.log(`\n── agent ──\n  ${a.framework} ${a.adk_version} · ${a.model} · ${a.backend}${a.project ? ` · ${a.project}/${a.location}` : ''}`);
    console.log(`  llm_turns=${a.llm_turns} tool_calls=${a.total_tool_calls} duration=${a.duration_ms}ms`);
    if (a.final_text) console.log(`  final: ${a.final_text.slice(0, 140)}`);
    for (const w of a.warnings) console.log(`  ⚠ ${w}`);
  }

  if (run.semantic_review) {
    const r = run.semantic_review;
    console.log(`\n── Gemini semantic review (cue ${r.input.cue_id}) ──`);
    console.log(`  source: ${r.input.source_text}`);
    console.log(`  target: ${r.input.target_text}`);
    console.log(`  verdict=${r.output.verdict} severity=${r.output.severity} confidence=${r.output.confidence} latency=${r.latency_ms}ms`);
    console.log(`  suggestion: ${r.output.suggested_target_text ?? '(none)'}`);
  }

  console.log(`\n── findings (${run.findings.length}) ──`);
  for (const f of run.findings) {
    console.log(`  [${f.rule_id}] cue ${f.cue_id} · ${f.severity}${f.is_blocker ? ' · BLOCKER' : ''} · ${f.source}`);
    console.log(`      ${f.headline}`);
    if (f.proposed_repair) console.log(`      repair: ${f.proposed_repair.summary}`);
  }

  const state = run.release_state === 'READY' ? 'READY TO RELEASE' : run.release_state;
  console.log(`\n═══ ${state} - ${run.blocker_count} blocker${run.blocker_count === 1 ? '' : 's'} (run ${run.run_id}, ${run.duration_ms ?? 0}ms) ═══`);
  if (run.error) console.log(`  error: ${run.error.message}\n  hint:  ${run.error.hint ?? '(none)'}`);
}

async function main(): Promise<void> {
  const cfg = await getConfig();
  const recheck = process.argv.includes('--recheck');
  console.log(`[run-gate] ${hostHint(cfg.clickhouse.host)} / ${cfg.clickhouse.database} · Gemini ${cfg.gemini.model} (${cfg.gemini.backend ?? 'not configured'})`);

  let run_id = arg('--run-id');
  if (!run_id) {
    if (recheck) {
      const parentId = arg('--parent');
      if (!parentId) throw new Error('--recheck needs --parent <approved run id>');
      const parent = await requireApprovedRun(parentId);
      const created = await createRun({
        version: parent.approval.approved_version,
        trigger: 'recheck_after_approval',
        parent_run_id: parent.run_id,
      });
      run_id = created.run.run_id;
      console.log(`[run-gate] recheck run ${run_id} for approved v${parent.approval.approved_version}`);
    } else {
      const created = await createRun({ trigger: 'vendor_delivery' });
      run_id = created.run.run_id;
      console.log(`[run-gate] created run ${run_id}${created.created ? '' : ' (reused a running one)'}`);
    }
  }

  const t0 = Date.now();
  await runReleaseGatePipeline(run_id);
  const run = await getRun(run_id);
  if (!run) throw new Error(`run ${run_id} disappeared`);
  printRun(run);
  console.log(`[run-gate] wall clock ${Date.now() - t0} ms`);
  if (run.release_state === 'FAILED') process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('[run-gate] failed:', (err as Error).stack ?? err);
    process.exitCode = 1;
  })
  .finally(() => closeClickHouse());

export type { SemanticEvidence };
