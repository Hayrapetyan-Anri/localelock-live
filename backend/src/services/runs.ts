import {
  BASELINE_RUN_ID,
  HERO_LOCALE,
  HERO_VERSION,
  RUN_DEDUPE_WINDOW_MS,
  SYNTHETIC_DISCLAIMER,
  TITLE_ID,
  type AgentTrace,
  type Finding,
  type ReleaseRun,
  type ReleaseState,
  type RunError,
  type RunPhase,
  type RunTrigger,
  type SemanticReview,
  type ToolTraceEntry,
} from '../domain/constants.js';
import { sortFindings, withEvidenceJson } from '../domain/rules.js';
import { countWhere, deleteWhere, ensureSchema, insertRows, query, queryOne } from '../db/clickhouse.js';
import { eventToRow, findingToRow, rowToEvent, rowToFinding, rowToRun, runToRow, toPublicRun, type RunDoc } from '../db/rows.js';
import { newEventId, newRunId } from '../db/ids.js';
import { readMeta as readDemoMeta } from '../domain/seed.js';

export async function findingsForRun(run_id: string): Promise<Finding[]> {
  const rows = await query<Record<string, unknown>>(
    'SELECT * FROM {db:Identifier}.qc_findings WHERE run_id = {run_id:String} ORDER BY priority, cue_id',
    { run_id },
    { final: true },
  );
  return sortFindings(rows.map(rowToFinding));
}

export async function getRun(run_id: string): Promise<ReleaseRun | null> {
  const doc = await getRunDoc(run_id);
  if (!doc) return null;
  return toPublicRun(doc, await findingsForRun(run_id));
}

export async function getRunDoc(run_id: string): Promise<RunDoc | null> {
  const row = await queryOne<Record<string, unknown>>(
    'SELECT * FROM {db:Identifier}.release_runs WHERE run_id = {run_id:String}',
    { run_id },
    { final: true },
  );
  return row ? rowToRun(row) : null;
}

async function saveRun(doc: RunDoc): Promise<void> {
  await insertRows('release_runs', [runToRow(doc)]);
}

export async function listRuns(opts: { limit?: number; title_id?: string; locale?: string } = {}): Promise<ReleaseRun[]> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
  const where: string[] = [];
  const params: Record<string, unknown> = { limit };
  if (opts.title_id) {
    where.push('title_id = {title_id:String}');
    params.title_id = opts.title_id;
  }
  if (opts.locale) {
    where.push('locale = {locale:String}');
    params.locale = opts.locale;
  }
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM {db:Identifier}.release_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT {limit:UInt32}`,
    params,
    { final: true },
  );
  return rows.map((r) => toPublicRun({ ...rowToRun(r), trace: [] }, []));
}

export async function latestRun(title_id = TITLE_ID, locale = HERO_LOCALE): Promise<ReleaseRun | null> {
  const row = await queryOne<Record<string, unknown>>(
    'SELECT * FROM {db:Identifier}.release_runs WHERE title_id = {title_id:String} AND locale = {locale:String} ORDER BY started_at DESC LIMIT 1',
    { title_id, locale },
    { final: true },
  );
  if (!row) return null;
  const doc = rowToRun(row);
  return toPublicRun(doc, await findingsForRun(doc.run_id));
}

export interface CreateRunInput {
  title_id?: string;
  locale?: string;
  trigger?: RunTrigger;
  version?: number;
  parent_run_id?: string | null;
}

export interface CreateRunResult {
  run: ReleaseRun;
  created: boolean;
}

export async function runsStartedSince(windowMs: number): Promise<number> {
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = await queryOne<{ n: string }>(
    'SELECT count() AS n FROM {db:Identifier}.run_budget_log WHERE started_at > parseDateTime64BestEffort({since:String})',
    { since },
  );
  return Number(row?.n ?? 0);
}

export async function createRun(input: CreateRunInput = {}): Promise<CreateRunResult> {
  await ensureSchema();
  const title_id = input.title_id ?? TITLE_ID;
  const locale = input.locale ?? HERO_LOCALE;
  const trigger: RunTrigger = input.trigger ?? 'vendor_delivery';
  const now = new Date();

  const youngest = new Date(now.getTime() - RUN_DEDUPE_WINDOW_MS).toISOString();
  const existing = await queryOne<Record<string, unknown>>(
    "SELECT * FROM {db:Identifier}.release_runs WHERE title_id = {title_id:String} AND locale = {locale:String} AND release_state = 'RUNNING' AND started_at > parseDateTime64BestEffort({youngest:String}) ORDER BY started_at DESC LIMIT 1",
    { title_id, locale, youngest },
    { final: true },
  );
  if (existing) return { run: toPublicRun(rowToRun(existing), []), created: false };

  const eventTypes = trigger === 'recheck_after_approval' ? ['approved_version_ingested'] : trigger === 'source_revision' ? ['source_revision'] : ['vendor_delivery', 'source_revision'];
  const triggerRow = await queryOne<Record<string, unknown>>(
    'SELECT * FROM {db:Identifier}.localization_events WHERE title_id = {title_id:String} AND locale = {locale:String} AND event_type IN {types:Array(String)} ORDER BY occurred_at DESC LIMIT 1',
    { title_id, locale, types: eventTypes },
    { final: true },
  );
  const triggerEvent = triggerRow ? rowToEvent(triggerRow) : null;
  const meta = await readDemoMeta();
  const doc: RunDoc = {
    run_id: newRunId(),
    title_id,
    locale,
    version: input.version ?? HERO_VERSION,
    trigger,
    trigger_event_id: triggerEvent?.event_id ?? null,
    parent_run_id: input.parent_run_id ?? null,
    recheck_run_id: null,
    started_at: now.toISOString(),
    ended_at: null,
    duration_ms: null,
    phase: 'event_received',
    phases: [{ phase: 'event_received', started_at: now.toISOString(), ended_at: null, duration_ms: null, note: triggerEvent ? triggerEvent.summary : 'No trigger event found' }],
    release_state: 'RUNNING',
    blocker_count: 0,
    finding_count: 0,
    trace: [],
    agent: null,
    semantic_review: null,
    semantic_candidates: null,
    approval: null,
    error: null,
    origin: 'release_gate',
    dataset: { synthetic_rows_total: meta?.dataset_stats?.synthetic_rows_total ?? 0, disclaimer: SYNTHETIC_DISCLAIMER },
  };
  await saveRun(doc);
  await insertRows('run_budget_log', [
    { run_id: doc.run_id, title_id, locale, trigger, started_at: now.toISOString() },
  ]).catch(() => undefined);
  return { run: toPublicRun(doc, []), created: true };
}

export async function setPhase(run_id: string, phase: RunPhase, note: string | null = null): Promise<void> {
  const doc = await getRunDoc(run_id);
  if (!doc) throw new Error(`run ${run_id} not found`);
  const now = new Date().toISOString();
  const phases = (doc.phases ?? []).map((p) => {
    if (p.ended_at === null) {
      return { ...p, ended_at: now, duration_ms: Math.max(0, new Date(now).getTime() - new Date(p.started_at).getTime()) };
    }
    return p;
  });
  phases.push({ phase, started_at: now, ended_at: null, duration_ms: null, note });
  await saveRun({ ...doc, phase, phases });
}

export async function setPhaseNote(run_id: string, note: string, phase?: RunPhase): Promise<void> {
  const doc = await getRunDoc(run_id);
  if (!doc) return;
  const phases = [...(doc.phases ?? [])];
  const idx = phase ? phases.map((p) => p.phase).lastIndexOf(phase) : phases.findIndex((p) => p.ended_at === null);
  if (idx < 0) return;
  phases[idx] = { ...phases[idx], note };
  await saveRun({ ...doc, phases });
}

export async function pushTrace(run_id: string, entry: ToolTraceEntry): Promise<void> {
  const doc = await getRunDoc(run_id);
  if (!doc) return;
  await saveRun({ ...doc, trace: [...(doc.trace ?? []), entry] });
}

export async function setAgentTrace(run_id: string, agent: AgentTrace): Promise<void> {
  const doc = await getRunDoc(run_id);
  if (!doc) return;
  await saveRun({ ...doc, agent });
}

export async function setSemanticReview(run_id: string, review: SemanticReview | null, semantic_candidates: number): Promise<void> {
  const doc = await getRunDoc(run_id);
  if (!doc) return;
  await saveRun({ ...doc, semantic_review: review, semantic_candidates });
}

export async function attachFindings(run_id: string, findings: Finding[]): Promise<number> {
  if (findings.length > 0) {
    await insertRows('qc_findings', findings.map((f) => findingToRow({ ...f, run_id })));
  }
  const count = await countWhere('qc_findings', 'run_id = {run_id:String}', { run_id });
  const doc = await getRunDoc(run_id);
  if (doc) await saveRun({ ...doc, finding_count: count });
  return count;
}

export async function upsertFinding(finding: Finding): Promise<void> {
  await insertRows('qc_findings', [findingToRow(finding)]);
  const count = await countWhere('qc_findings', 'run_id = {run_id:String}', { run_id: finding.run_id });
  const doc = await getRunDoc(finding.run_id);
  if (doc) await saveRun({ ...doc, finding_count: count });
}

export interface FinalizeInput {
  release_state: Extract<ReleaseState, 'HELD' | 'READY'>;
  blocker_count: number;
  finding_count: number;
}

export async function finalizeRun(run_id: string, input: FinalizeInput): Promise<ReleaseRun> {
  const doc = await getRunDoc(run_id);
  if (!doc) throw new Error(`run ${run_id} not found`);
  const now = new Date();
  const nowIso = now.toISOString();
  const phases = (doc.phases ?? []).map((p) => (p.ended_at === null ? { ...p, ended_at: nowIso, duration_ms: Math.max(0, now.getTime() - new Date(p.started_at).getTime()) } : p));
  const event_id = newEventId();
  await insertRows('localization_events', [eventToRow({
    event_id,
    title_id: doc.title_id,
    locale: doc.locale,
    event_type: 'release_gate_run',
    source_revision: (await latestSourceRevision(doc.title_id, doc.locale)) ?? 'r3',
    target_version: doc.version,
    occurred_at: nowIso,
    summary: `Release gate run ${run_id}: ${input.release_state} - ${input.blocker_count} blocker${input.blocker_count === 1 ? '' : 's'} (v${doc.version})`,
    actor: 'LocaleLock release gate',
    run_id,
  })]);
  await saveRun({
    ...doc,
    phases,
    phase: 'complete',
    ended_at: nowIso,
    duration_ms: now.getTime() - new Date(doc.started_at).getTime(),
    release_state: input.release_state,
    blocker_count: input.blocker_count,
    finding_count: input.finding_count,
    error: null,
  });
  return (await getRun(run_id))!;
}

export async function claimRun(run_id: string, by: string, staleMs = 5 * 60_000): Promise<'claimed' | 'busy' | 'missing'> {
  const doc = await getRunDoc(run_id);
  if (!doc) return 'missing';
  const lock = doc.pipeline_lock;
  if (lock && Date.now() - new Date(lock.at).getTime() < staleMs) return 'busy';
  await saveRun({ ...doc, pipeline_lock: { at: new Date().toISOString(), by } });
  return 'claimed';
}

export async function releaseRunClaim(run_id: string): Promise<void> {
  const doc = await getRunDoc(run_id);
  if (!doc) return;
  await saveRun({ ...doc, pipeline_lock: null });
}

export async function resetRunForExecution(run_id: string): Promise<void> {
  await deleteWhere('qc_findings', 'run_id = {run_id:String}', { run_id });
  const doc = await getRunDoc(run_id);
  if (!doc) return;
  await saveRun({
    ...doc,
    trace: [],
    agent: null,
    semantic_review: null,
    semantic_candidates: null,
    blocker_count: 0,
    finding_count: 0,
    error: null,
  });
}

export interface FailInput {
  phase?: RunPhase;
  message: string;
  retryable?: boolean;
  hint?: string | null;
}

export async function failRun(run_id: string, input: FailInput | Error): Promise<ReleaseRun | null> {
  const doc = await getRunDoc(run_id);
  if (!doc) return null;
  const now = new Date();
  const nowIso = now.toISOString();
  const err: FailInput = input instanceof Error ? { message: input.message, retryable: true, hint: (input as { hint?: string }).hint ?? null } : input;
  const failedPhase: RunPhase = err.phase ?? (doc.phase === 'complete' || doc.phase === 'failed' ? 'producer_decision' : doc.phase);
  const phases = (doc.phases ?? []).map((p) => (p.ended_at === null ? { ...p, ended_at: nowIso, duration_ms: Math.max(0, now.getTime() - new Date(p.started_at).getTime()) } : p));
  const error: RunError = { phase: failedPhase, message: err.message, retryable: err.retryable ?? true, hint: err.hint ?? null };
  await saveRun({
    ...doc,
    phases,
    phase: 'failed',
    release_state: 'FAILED',
    error,
    ended_at: nowIso,
    duration_ms: now.getTime() - new Date(doc.started_at).getTime(),
  });
  return getRun(run_id);
}

export async function latestSourceRevision(title_id: string, locale: string): Promise<string | null> {
  const row = await queryOne<{ source_revision: string }>(
    "SELECT source_revision FROM {db:Identifier}.localization_events WHERE title_id = {title_id:String} AND locale = {locale:String} AND event_type IN ('script_locked', 'source_revision') ORDER BY occurred_at DESC LIMIT 1",
    { title_id, locale },
    { final: true },
  );
  return row?.source_revision ?? null;
}

export { BASELINE_RUN_ID };
