import {
  HERO_LOCALE,
  TITLE_ID,
  TITLE_NAME,
  type ApprovalDecision,
  type ApprovalRecord,
  type ApprovalRequest,
  type ApprovalResponse,
  type Finding,
  type ReleaseRun,
  type SourceTargetPair,
  type SubtitleCue,
} from '../domain/constants.js';
import { applyRepairs, applyRepairsToPairs, deterministicViolations } from '../domain/rules.js';
import { buildSrt } from '../domain/srt.js';
import { deleteWhere, ensureSchema, insertRows, query, queryOne } from '../db/clickhouse.js';
import { approvalToRow, eventToRow, findingToRow, rowToFinding, rowToRun, runToRow, type ApprovalDoc, type RunDoc } from '../db/rows.js';
import { getRunDoc } from './runs.js';
import { newApprovalBatchId, newApprovalId, newEventId } from '../db/ids.js';
import { findingsForRun, getRun, latestSourceRevision } from './runs.js';
import { ApiError } from '../http/errors.js';

const titleNameFor = (title_id: string) => (title_id === TITLE_ID ? TITLE_NAME : title_id);

export async function loadVersionCues(title_id: string, locale: string, version: number): Promise<SubtitleCue[]> {
  const docs = await query<SubtitleCue>(
    'SELECT title_id, locale, cue_id, version, start_ms, end_ms, text, source_revision FROM {db:Identifier}.subtitle_cues WHERE title_id = {title_id:String} AND locale = {locale:String} AND version = {version:UInt16} ORDER BY cue_id',
    { title_id, locale, version },
  );
  return docs as SubtitleCue[];
}

export async function loadVersionPairs(title_id: string, locale: string, target_version: number): Promise<SourceTargetPair[]> {
  const docs = await query<SourceTargetPair>(
    'SELECT title_id, locale, cue_id, source_text, target_text, source_revision, target_version, previous_source_text FROM {db:Identifier}.source_target_pairs WHERE title_id = {title_id:String} AND locale = {locale:String} AND target_version = {target_version:UInt16} ORDER BY cue_id',
    { title_id, locale, target_version },
  );
  return docs as SourceTargetPair[];
}

async function clearLock(run_id: string): Promise<void> {
  const doc = await getRunDoc(run_id);
  if (doc) await insertRows('release_runs', [runToRow({ ...doc, approval_lock: null })]);
}

export async function submitApprovals(run_id: string, body: ApprovalRequest): Promise<{ status: number; body: ApprovalResponse }> {
  await ensureSchema();

  const run = await getRun(run_id);
  if (!run) throw new ApiError(404, 'NOT_FOUND', `Run ${run_id} not found`);
  if (run.approval) return { status: 200, body: { approval: run.approval, run, idempotent: true } };
  if (run.origin === 'seed_baseline') {
    throw new ApiError(409, 'RUN_NOT_COMPLETE', 'The seeded intake baseline cannot be approved - run the live release gate first, then approve that run.');
  }
  if (run.phase !== 'complete') throw new ApiError(409, 'RUN_NOT_COMPLETE', `Run ${run_id} is in phase ${run.phase}; approvals need a complete run`);
  if (run.release_state !== 'HELD') throw new ApiError(409, 'RUN_NOT_HELD', `Run ${run_id} is ${run.release_state}; only HELD runs can be approved`);

  const reviewer = typeof body?.reviewer === 'string' && body.reviewer.trim() ? body.reviewer.trim().slice(0, 120) : '';
  if (!reviewer) throw new ApiError(400, 'BAD_REQUEST', 'reviewer is required');
  if (!Array.isArray(body?.decisions)) throw new ApiError(400, 'BAD_REQUEST', 'decisions[] is required');

  const pending = run.findings.filter((f) => f.status === 'open' || f.status === 'rejected');
  const byId = new Map(pending.map((f) => [f.finding_id, f]));
  const decisionMap = new Map<string, 'approve' | 'reject'>();
  for (const d of body.decisions) {
    if (!d || typeof d.finding_id !== 'string' || (d.decision !== 'approve' && d.decision !== 'reject')) {
      throw new ApiError(400, 'BAD_REQUEST', 'each decision needs finding_id and decision approve|reject');
    }
    if (!byId.has(d.finding_id)) throw new ApiError(400, 'BAD_REQUEST', `Unknown or already decided finding_id ${d.finding_id}`, { finding_id: d.finding_id });
    decisionMap.set(d.finding_id, d.decision);
  }
  const missing = pending.filter((f) => !decisionMap.has(f.finding_id)).map((f) => f.finding_id);
  if (missing.length) throw new ApiError(400, 'DECISIONS_INCOMPLETE', `Missing decisions for ${missing.length} finding(s)`, { missing });
  const decisions: ApprovalDecision[] = pending.map((f) => ({ finding_id: f.finding_id, cue_id: f.cue_id, rule_id: f.rule_id, decision: decisionMap.get(f.finding_id)! }));
  const now = new Date().toISOString();

  const rejected = decisions.filter((d) => d.decision === 'reject');
  if (rejected.length) {
    const batch = newApprovalBatchId();
    await recordDecisions(run_id, batch, decisions, reviewer, now, null);
    await setFindingStatus(run_id, rejected.map((d) => d.finding_id), 'rejected');
    throw new ApiError(409, 'REJECTED', `${rejected.length} repair(s) rejected - release stays HELD; re-run the release gate after fixing the delivery`, {
      rejected: rejected.map((d) => d.finding_id),
    });
  }

  const fresh = await getRunDoc(run_id);
  const locked = fresh && !fresh.approval && !fresh.approval_lock ? fresh : null;
  if (locked) await insertRows('release_runs', [runToRow({ ...locked, approval_lock: { at: now, reviewer } })]);
  if (!locked) {
    const again = await getRun(run_id);
    if (again?.approval) return { status: 200, body: { approval: again.approval, run: again, idempotent: true } };
    throw new ApiError(409, 'APPROVAL_IN_PROGRESS', 'Another approval is being processed for this run; poll GET /runs/{run_id}');
  }

  try {
    const { title_id, locale, version } = run;
    const approved_version = version + 1;
    const sourceRevision = (await latestSourceRevision(title_id, locale)) ?? 'r3';

    const cues = await loadVersionCues(title_id, locale, version);
    const pairs = await loadVersionPairs(title_id, locale, version);
    const glossary = await query<{ title_id: string; locale: string; source_term: string; approved_target_term: string }>(
      'SELECT title_id, locale, source_term, approved_target_term FROM {db:Identifier}.glossary_terms WHERE title_id = {title_id:String} AND locale = {locale:String} ORDER BY source_term',
      { title_id, locale },
    );
    if (cues.length === 0) throw new Error(`No subtitle_cues for ${title_id}/${locale}/v${version}`);
    const approvedFindings: Finding[] = pending.filter((f) => decisionMap.get(f.finding_id) === 'approve');
    const unrepairable = approvedFindings.filter((f) => f.is_blocker && !f.proposed_repair);
    if (unrepairable.length) {
      throw new ApiError(409, 'RUN_NOT_COMPLETE', `Finding(s) ${unrepairable.map((f) => f.finding_id).join(', ')} have no proposed repair; re-run the release gate`, { finding_ids: unrepairable.map((f) => f.finding_id) });
    }
    const repairedCues = applyRepairs(cues, approvedFindings).map((cue) => ({ ...cue, version: approved_version, source_revision: sourceRevision }));
    const repairedPairs = applyRepairsToPairs(pairs, repairedCues).map((p) => ({ ...p, target_version: approved_version }));
    const violations = deterministicViolations(repairedCues, repairedPairs, glossary);
    if (violations.length) {
      throw new ApiError(500, 'INTERNAL', 'Repaired cue set still violates deterministic rules; approval aborted', { violations });
    }

    const srt = buildSrt(repairedCues, titleNameFor(title_id), locale, approved_version);
    const patch_hash = srt.sha256;
    await deleteWhere('subtitle_cues', 'title_id = {title_id:String} AND locale = {locale:String} AND version = {v:UInt16}', { title_id, locale, v: approved_version });
    await deleteWhere('source_target_pairs', 'title_id = {title_id:String} AND locale = {locale:String} AND target_version = {v:UInt16}', { title_id, locale, v: approved_version });
    await insertRows('subtitle_cues', repairedCues as unknown as Array<Record<string, unknown>>);
    await insertRows('source_target_pairs', repairedPairs.map((p) => ({ ...p, previous_source_text: p.previous_source_text ?? '' })));
    const event_id = newEventId();
    await insertRows('localization_events', [eventToRow({
      event_id,
      title_id,
      locale,
      event_type: 'approved_version_ingested',
      source_revision: sourceRevision,
      target_version: approved_version,
      occurred_at: now,
      summary: `Approved v${approved_version} ingested - patch ${patch_hash.slice(0, 12)}`,
      actor: reviewer,
      run_id,
    })]);
    const batch = newApprovalBatchId();
    await recordDecisions(run_id, batch, decisions, reviewer, now, patch_hash);
    await setFindingStatus(run_id, decisions.map((d) => d.finding_id), 'approved');

    const approval: ApprovalRecord = {
      approval_batch_id: batch,
      run_id,
      reviewer,
      approved_at: now,
      decisions,
      approved_version,
      patch_hash,
      srt: { filename: srt.filename, bytes: srt.byteLength, sha256: srt.sha256, cue_count: srt.cue_count, url: `/runs/${run_id}/export.srt` },
      ingested: { subtitle_cues: repairedCues.length, source_target_pairs: repairedPairs.length, localization_events: 1 },
      event_id,
    };

    await insertRows('release_runs', [runToRow({ ...locked, approval, approval_lock: null })]);
    const finalRun = (await getRun(run_id))!;
    return { status: 200, body: { approval, run: finalRun, idempotent: false } };
  } catch (err) {
    await clearLock(run_id);
    throw err;
  }
}

async function recordDecisions(run_id: string, batch: string, decisions: ApprovalDecision[], reviewer: string, approved_at: string, patch_hash: string | null): Promise<void> {
  if (decisions.length === 0) return;
  const docs: ApprovalDoc[] = decisions.map((d) => ({
    approval_id: newApprovalId(),
    approval_batch_id: batch,
    run_id,
    cue_id: d.cue_id,
    finding_id: d.finding_id,
    rule_id: d.rule_id,
    decision: d.decision,
    reviewer,
    approved_at,
    patch_hash,
  }));
  await insertRows('approvals', docs.map((d) => approvalToRow(d)));
}

async function setFindingStatus(run_id: string, finding_ids: string[], status: Finding['status']): Promise<void> {
  if (finding_ids.length === 0) return;
  const rows = await query<Record<string, unknown>>(
    'SELECT * FROM {db:Identifier}.qc_findings WHERE run_id = {run_id:String} AND finding_id IN {ids:Array(String)}',
    { run_id, ids: finding_ids },
    { final: true },
  );
  if (rows.length === 0) return;
  await insertRows('qc_findings', rows.map((r) => findingToRow({ ...rowToFinding(r), status })));
}

export async function deliveredSrt(title_id: string, locale: string, version: number): Promise<SrtExportResult & { cue_count: number }> {
  const cues = await loadVersionCues(title_id, locale, version);
  if (cues.length === 0) throw new ApiError(404, 'NOT_FOUND', `No delivered subtitle file for ${title_id} / ${locale} / v${version}`);
  const built = buildSrt(cues, title_id === TITLE_ID ? TITLE_NAME : title_id, locale, version);
  return {
    text: built.text,
    filename: built.filename.replace('.approved.srt', '.delivered.srt'),
    bytes: built.byteLength,
    sha256: built.sha256,
    cue_count: built.cue_count,
  };
}

export interface SrtExportResult {
  filename: string;
  text: string;
  sha256: string;
  bytes: number;
}

export async function exportSrt(run_id: string): Promise<SrtExportResult> {
  const run = await getRun(run_id);
  if (!run) throw new ApiError(404, 'NOT_FOUND', `Run ${run_id} not found`);
  if (!run.approval) throw new ApiError(409, 'NOT_APPROVED', 'This run has no approved version yet');
  const cues = await loadVersionCues(run.title_id, run.locale, run.approval.approved_version);
  if (cues.length === 0) throw new ApiError(500, 'INTERNAL', `Approved v${run.approval.approved_version} cues are missing from subtitle_cues`);
  const srt = buildSrt(cues, titleNameFor(run.title_id), run.locale, run.approval.approved_version);
  if (srt.sha256 !== run.approval.patch_hash) {
    throw new ApiError(500, 'INTERNAL', `Export hash mismatch: regenerated SRT sha256 ${srt.sha256.slice(0, 12)}… differs from patch_hash ${run.approval.patch_hash.slice(0, 12)}… - the persisted v${run.approval.approved_version} cues changed after approval`, {
      expected: run.approval.patch_hash,
      actual: srt.sha256,
    });
  }
  return { filename: srt.filename, text: srt.text, sha256: srt.sha256, bytes: srt.byteLength };
}

export async function requireApprovedRun(run_id: string): Promise<ReleaseRun & { approval: ApprovalRecord }> {
  const run = await getRun(run_id);
  if (!run) throw new ApiError(404, 'NOT_FOUND', `Run ${run_id} not found`);
  if (!run.approval) throw new ApiError(409, 'NOT_APPROVED', 'Approve the repairs before rechecking');
  return run as ReleaseRun & { approval: ApprovalRecord };
}

export async function setRecheckRunId(parent_run_id: string, recheck_run_id: string): Promise<void> {
  const doc = await getRunDoc(parent_run_id);
  if (doc) await insertRows('release_runs', [runToRow({ ...doc, recheck_run_id })]);
}

export type { RunDoc };
export { HERO_LOCALE, findingsForRun };
