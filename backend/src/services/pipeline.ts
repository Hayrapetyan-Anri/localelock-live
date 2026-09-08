import {
  RULE_QUERY,
  SEMANTIC_FALLBACK_TARGET_TEXT,
  TITLE_NAME,
  type Finding,
  type QueryId,
  type RuleId,
  type SemanticReview,
  type ToolTraceEntry,
} from '../domain/constants.js';
import {
  buildSemanticFinding,
  evaluateDeterministicFindings,
  semanticIsBlocker,
  semanticReviewInput,
  type CpsRow,
  type CueLike,
  type DeterministicRows,
  type FindingContext,
  type GlossaryRow,
  type OverlapRow,
  type PairRow,
  type SemanticCandidateRow,
} from '../domain/rules.js';
import { buildQueryPlan } from '../domain/queries.js';
import { query } from '../db/clickhouse.js';
import { rowToEvent } from '../db/rows.js';
import { getConfig } from '../config.js';
import { GeminiNotConfiguredError } from '../agent/gemini.js';
import { PooledMcpToolset } from '../agent/pooledToolset.js';
import { executeQueryPlanWithAgent, rowsFor } from '../agent/releaseGateAgent.js';
import { SemanticReviewError, reviewSemanticPair } from '../agent/semanticReviewer.js';
import {
  attachFindings,
  claimRun,
  failRun,
  finalizeRun,
  getRunDoc,
  latestSourceRevision,
  pushTrace,
  releaseRunClaim,
  resetRunForExecution,
  setAgentTrace,
  setPhase,
  setPhaseNote,
  setSemanticReview,
} from './runs.js';

export async function runReleaseGatePipeline(run_id: string): Promise<void> {
  const config = await getConfig();
  let pool: PooledMcpToolset | null = null;

  const claim = await claimRun(run_id, config.mode === 'lambda' ? (config.functionName ?? 'lambda-worker') : 'local-worker');
  if (claim === 'missing') throw new Error(`run ${run_id} not found`);
  if (claim === 'busy') {
    console.log(`[pipeline] run ${run_id} is already being executed by another worker - skipping duplicate invocation`);
    return;
  }
  await resetRunForExecution(run_id);

  try {
    const run = await getRunDoc(run_id);
    if (!run) throw new Error(`run ${run_id} not found`);
    const { title_id, locale, version } = run;

    const triggerRows = run.trigger_event_id
      ? await query<Record<string, unknown>>(
          'SELECT * FROM {db:Identifier}.localization_events WHERE event_id = {event_id:String} LIMIT 1',
          { event_id: run.trigger_event_id },
          { final: true },
        )
      : [];
    const triggerEvent = triggerRows.length ? rowToEvent(triggerRows[0]) : null;
    await setPhaseNote(run_id, triggerEvent ? `${triggerEvent.event_type}: ${triggerEvent.summary}` : `Manual ${run.trigger} trigger for v${version}`, 'event_received');

    if (!config.gemini.configured) throw new GeminiNotConfiguredError();

    const glossary = await query<GlossaryRow>(
      'SELECT source_term, approved_target_term FROM {db:Identifier}.glossary_terms WHERE title_id = {title_id:String} AND locale = {locale:String} ORDER BY source_term',
      { title_id, locale },
    );
    const cues = await query<CueLike>(
      'SELECT cue_id, start_ms, end_ms, text FROM {db:Identifier}.subtitle_cues WHERE title_id = {title_id:String} AND locale = {locale:String} AND version = {version:UInt16} ORDER BY start_ms',
      { title_id, locale, version },
    );
    if (cues.length === 0) throw new Error(`No cues found for ${title_id} / ${locale} / v${version} - seed the demo first (npm run seed -- --force).`);

    const source_revision = (await latestSourceRevision(title_id, locale)) ?? 'r3';
    const plan = buildQueryPlan({ title_id, locale, version, source_revision, glossary, database: config.clickhouse.database, title_name: title_id === 'tt_last_tram' ? TITLE_NAME : title_id });

    await setPhase(run_id, 'querying_clickhouse', `Google ADK + Gemini (${config.gemini.model}) executing ${plan.length} read-only queries through the official mcp-clickhouse server`);
    pool = await PooledMcpToolset.create({ config });
    const agentResult = await executeQueryPlanWithAgent({
      plan,
      database: config.clickhouse.database,
      config,
      pool,
      onTrace: (entry: ToolTraceEntry) => pushTrace(run_id, entry),
    });
    await setAgentTrace(run_id, agentResult.agent);
    const executed = agentResult.entries.filter((e) => e.ok).length;
    const fallbacks = agentResult.entries.filter((e) => e.initiator === 'app_fallback').length;
    await setPhaseNote(
      run_id,
      `${executed}/${agentResult.entries.length} MCP tool calls succeeded${fallbacks ? ` (${fallbacks} executed by the application after the agent deviated)` : ''}`,
      'querying_clickhouse',
    );

    const failed = agentResult.entries.filter((e) => !e.ok);
    if (failed.length === agentResult.entries.length && failed.length > 0) {
      throw new Error(`Every MCP query failed - first error: ${failed[0].error ?? 'unknown'}`);
    }

    await setPhase(run_id, 'deterministic_qc', 'Evaluating timing, reading speed and glossary rules on the rows ClickHouse returned');
    const rows: DeterministicRows = {
      q2: rowsFor(agentResult, 'Q2_TIMING_OVERLAP') as OverlapRow[],
      q3: rowsFor(agentResult, 'Q3_READING_SPEED') as CpsRow[],
      q4: (rowsFor(agentResult, 'Q4_GLOSSARY_TERMS') as GlossaryRow[]).length > 0 ? (rowsFor(agentResult, 'Q4_GLOSSARY_TERMS') as GlossaryRow[]) : glossary,
      q5: rowsFor(agentResult, 'Q5_GLOSSARY_DRIFT') as PairRow[],
    };
    const created_at = new Date().toISOString();
    const evidence_ref = buildEvidenceRefs(agentResult.entries);
    const ctx: FindingContext = { run_id, title_id, locale, version, created_at, evidence_ref };
    const deterministic = evaluateDeterministicFindings(rows, cues, ctx);
    await attachFindings(run_id, deterministic);
    await setPhaseNote(
      run_id,
      `${deterministic.length} deterministic finding${deterministic.length === 1 ? '' : 's'}: ${summarizeRules(deterministic) || 'none'}`,
      'deterministic_qc',
    );

    await setPhase(run_id, 'gemini_semantic_review', 'Narrowing to source/target pairs whose source changed after translation');
    const candidates = rowsFor(agentResult, 'Q6_SEMANTIC_CANDIDATES') as SemanticCandidateRow[];
    const semanticFindings: Finding[] = [];
    let lastReview: SemanticReview | null = null;

    if (candidates.length === 0) {
      await setSemanticReview(run_id, null, 0);
      await setPhaseNote(run_id, `No source/target pair changed in ${source_revision}; semantic escalation not required`, 'gemini_semantic_review');
    } else {
      const cueById = new Map(cues.map((c2) => [c2.cue_id, c2]));
      for (const candidate of candidates) {
        const cue = cueById.get(candidate.cue_id);
        if (!cue) continue;
        const input = semanticReviewInput(candidate, locale);
        const review = await reviewSemanticPair(input, { config });
        lastReview = review;
        const finding = buildSemanticFinding(candidate, cue, review, source_revision, ctx, {
          source: 'gemini_semantic_review',
          fallback_target_text: SEMANTIC_FALLBACK_TARGET_TEXT,
        });
        if (finding) semanticFindings.push(finding);
      }
      await setSemanticReview(run_id, lastReview, candidates.length);
      if (semanticFindings.length > 0) await attachFindings(run_id, semanticFindings);
      const verdicts = semanticFindings.length > 0 ? semanticFindings.map((f) => (f.evidence as { review: SemanticReview }).review.output.verdict).join(', ') : (lastReview?.output.verdict ?? 'none');
      await setPhaseNote(
        run_id,
        `${candidates.length} narrowed pair${candidates.length === 1 ? '' : 's'} reviewed by Gemini - ${verdicts}`,
        'gemini_semantic_review',
      );
    }

    await setPhase(run_id, 'producer_decision', 'Aggregating blockers and persisting the release state');
    const all = [...deterministic, ...semanticFindings];
    const blocker_count = all.filter((f) => f.is_blocker).length;
    await finalizeRun(run_id, {
      release_state: blocker_count > 0 ? 'HELD' : 'READY',
      blocker_count,
      finding_count: all.length,
    });
  } catch (err) {
    await failRun(run_id, toRunError(err));
  } finally {
    if (pool) await pool.shutdown().catch(() => undefined);
    await releaseRunClaim(run_id).catch(() => undefined);
  }
}

function buildEvidenceRefs(entries: ToolTraceEntry[]): FindingContext['evidence_ref'] {
  const stepFor = new Map<QueryId, number>();
  for (const e of entries) {
    if (!e.query_id || !e.ok || !e.matched_expected) continue;
    stepFor.set(e.query_id, e.step);
  }
  const out: NonNullable<FindingContext['evidence_ref']> = {};
  for (const [rule, query] of Object.entries(RULE_QUERY) as Array<[RuleId, QueryId]>) {
    out[rule] = { trace_step: stepFor.get(query) ?? null, query_id: query };
  }
  return out;
}

function summarizeRules(findings: Finding[]): string {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.rule_id, (counts.get(f.rule_id) ?? 0) + 1);
  return [...counts.entries()].map(([rule, n]) => `${rule}×${n}`).join(', ');
}

function toRunError(err: unknown): { message: string; retryable: boolean; hint: string | null } {
  if (err instanceof GeminiNotConfiguredError) {
    return { message: 'Gemini is not configured for this deployment', retryable: false, hint: err.hint };
  }
  if (err instanceof SemanticReviewError) {
    return { message: err.message, retryable: err.retryable, hint: err.hint };
  }
  const message = (err as Error)?.message ?? String(err);
  if (/MCP server failed to start|spawn|ENOENT/i.test(message)) {
    return {
      message,
      retryable: true,
      hint: 'The official mcp-clickhouse server could not start. Check /health?deep=1 and that MCP_CLICKHOUSE_BIN points at an installed mcp-clickhouse.',
    };
  }
  if (/BILLING|PERMISSION_DENIED|403|quota|RESOURCE_EXHAUSTED/i.test(message)) {
    return { message, retryable: true, hint: 'Vertex AI rejected the call. Check billing, the Vertex AI User role and quota, then retry.' };
  }
  return { message, retryable: true, hint: null };
}

export { semanticIsBlocker };
