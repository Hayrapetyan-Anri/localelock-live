import {
  CPS_LIMIT,
  MIN_CUE_GAP_MS,
  RULE_PRIORITY,
  SEMANTIC_FALLBACK_TARGET_TEXT,
  type Finding,
  type FindingSource,
  type GlossaryDriftEvidence,
  type ProposedRepair,
  type QueryId,
  type ReadingSpeedEvidence,
  type RuleId,
  type SemanticEvidence,
  type SemanticReview,
  type SemanticReviewInput,
  type SemanticReviewOutput,
  type Severity,
  type SourceTargetPair,
  type SubtitleCue,
  type TimingOverlapEvidence,
} from './constants.js';

export interface OverlapRow {
  cue_id: number;
  start_ms: number;
  end_ms: number;
  next_cue_id: number | null;
  next_start_ms: number | null;
  overlap_ms: number;
}
export interface CpsRow {
  cue_id: number;
  start_ms: number;
  end_ms: number;
  text: string;
  chars: number;
  duration_ms: number;
  cps: number;
}
export interface GlossaryRow {
  source_term: string;
  approved_target_term: string;
}
export interface PairRow {
  cue_id: number;
  source_text: string;
  target_text: string;
}
export interface SemanticCandidateRow extends PairRow {
  previous_source_text?: string | null;
  source_revision: string;
  target_version: number;
}

export interface CueLike {
  cue_id: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

export function countChars(text: string): number {
  return Array.from(text.replace(/\n/g, '')).length;
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function computeCps(text: string, duration_ms: number): number {
  if (duration_ms <= 0) return Infinity;
  return round1(countChars(text) / (duration_ms / 1000));
}

export function levenshtein(a: string, b: string): number {
  const s = Array.from(a);
  const t = Array.from(b);
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;
  let prev = new Array<number>(t.length + 1);
  let cur = new Array<number>(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[t.length];
}

const EDGE_PUNCT = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;

export function findClosestTerm(target_text: string, approved_target_term: string): { found_term: string; edit_distance: number } {
  const n = Math.max(1, approved_target_term.trim().split(/\s+/).length);
  const words = target_text.replace(/\n/g, ' ').split(/\s+/).filter(Boolean);
  const approved = approved_target_term.toLowerCase();
  let best = { found_term: '', edit_distance: Number.POSITIVE_INFINITY };
  for (let i = 0; i + n <= words.length; i++) {
    const gram = words.slice(i, i + n).join(' ').replace(EDGE_PUNCT, '');
    if (!gram) continue;
    const d = levenshtein(gram.toLowerCase(), approved);
    if (d < best.edit_distance) best = { found_term: gram, edit_distance: d };
  }
  if (!Number.isFinite(best.edit_distance)) {
    best = { found_term: target_text.trim(), edit_distance: levenshtein(target_text.toLowerCase(), approved) };
  }
  return best;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function scanOverlaps(cues: CueLike[]): OverlapRow[] {
  const sorted = [...cues].sort((a, b) => a.start_ms - b.start_ms || a.cue_id - b.cue_id);
  const rows: OverlapRow[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const cue = sorted[i];
    const next = sorted[i + 1];
    const overlap_ms = cue.end_ms - next.start_ms;
    if (overlap_ms > 0) {
      rows.push({
        cue_id: cue.cue_id,
        start_ms: cue.start_ms,
        end_ms: cue.end_ms,
        next_cue_id: next.cue_id,
        next_start_ms: next.start_ms,
        overlap_ms,
      });
    }
  }
  return rows.sort((a, b) => b.overlap_ms - a.overlap_ms);
}

export function scanReadingSpeed(cues: CueLike[]): CpsRow[] {
  const rows: CpsRow[] = [];
  for (const cue of cues) {
    const chars = countChars(cue.text);
    const duration_ms = cue.end_ms - cue.start_ms;
    const cps = round1(chars / (duration_ms / 1000));
    if (cps > CPS_LIMIT) rows.push({ cue_id: cue.cue_id, start_ms: cue.start_ms, end_ms: cue.end_ms, text: cue.text, chars, duration_ms, cps });
  }
  return rows.sort((a, b) => b.cps - a.cps);
}

export function scanGlossaryDrift<P extends PairRow>(pairs: P[], glossary: GlossaryRow[]): P[] {
  if (glossary.length === 0) return [];
  return pairs.filter((p) =>
    glossary.some((g) => p.source_text.includes(g.source_term) && !p.target_text.includes(g.approved_target_term)),
  );
}

export function repairOverlapEnd(next_start_ms: number): number {
  return next_start_ms - MIN_CUE_GAP_MS;
}

export function repairReadingSpeedEnd(start_ms: number, chars: number, next_start_ms: number | null): { end_ms: number; fits: boolean } {
  const required = Math.ceil((chars / CPS_LIMIT) * 1000 / 100) * 100;
  const wanted = start_ms + required;
  const max = next_start_ms == null ? wanted : next_start_ms - MIN_CUE_GAP_MS;
  if (wanted <= max) return { end_ms: wanted, fits: true };
  return { end_ms: max, fits: false };
}

export function replaceTerm(text: string, found: string, approved: string): string {
  if (!found) return text;
  const idx = text.indexOf(found);
  if (idx < 0) {
    const ci = text.toLowerCase().indexOf(found.toLowerCase());
    if (ci < 0) return text;
    return text.slice(0, ci) + approved + text.slice(ci + found.length);
  }
  return text.slice(0, idx) + approved + text.slice(idx + found.length);
}

export interface FindingContext {
  run_id: string;
  title_id: string;
  locale: string;
  version: number;
  created_at: string;
  evidence_ref?: Partial<Record<RuleId, { trace_step: number | null; query_id: QueryId | null }>>;
  newId?: (rule: RuleId, cue_id: number) => string;
}

function ref(ctx: FindingContext, rule: RuleId, fallback: QueryId): { trace_step: number | null; query_id: QueryId | null } {
  return ctx.evidence_ref?.[rule] ?? { trace_step: null, query_id: fallback };
}

function fid(ctx: FindingContext, rule: RuleId, cue_id: number): string {
  return ctx.newId ? ctx.newId(rule, cue_id) : `f_${ctx.run_id}_${rule.toLowerCase()}_${cue_id}`;
}

function base(ctx: FindingContext, rule: RuleId, cue_id: number, source: FindingSource): Omit<Finding, 'severity' | 'is_blocker' | 'confidence' | 'headline' | 'detail' | 'evidence' | 'proposed_repair' | 'evidence_ref'> {
  return {
    finding_id: fid(ctx, rule, cue_id),
    run_id: ctx.run_id,
    title_id: ctx.title_id,
    locale: ctx.locale,
    version: ctx.version,
    cue_id,
    rule_id: rule,
    source,
    status: 'open',
    created_at: ctx.created_at,
    priority: RULE_PRIORITY[rule],
  };
}

export function buildOverlapFinding(row: OverlapRow, cue: CueLike, ctx: FindingContext): Finding {
  const next_start = row.next_start_ms ?? cue.end_ms;
  const next_id = row.next_cue_id ?? cue.cue_id + 1;
  const newEnd = repairOverlapEnd(next_start);
  const trimmed = cue.end_ms - newEnd;
  const evidence: TimingOverlapEvidence = {
    rule: 'TIMING_OVERLAP',
    cue_id: row.cue_id,
    next_cue_id: next_id,
    cue_start_ms: row.start_ms,
    cue_end_ms: row.end_ms,
    next_start_ms: next_start,
    overlap_ms: row.overlap_ms,
    min_gap_ms: MIN_CUE_GAP_MS,
  };
  const repair: ProposedRepair = {
    kind: 'trim_out_time',
    cue_id: cue.cue_id,
    summary: `Trim cue ${cue.cue_id} out-time by ${trimmed} ms so it ends ${MIN_CUE_GAP_MS} ms before cue ${next_id}`,
    before: { start_ms: cue.start_ms, end_ms: cue.end_ms, text: cue.text },
    after: { start_ms: cue.start_ms, end_ms: newEnd, text: cue.text },
    origin: 'deterministic',
    requires_human_approval: true,
    verification: {
      overlap_ms: newEnd - next_start,
      cps: computeCps(cue.text, newEnd - cue.start_ms),
      cps_limit: CPS_LIMIT,
      trimmed_ms: trimmed,
    },
  };
  return {
    ...base(ctx, 'TIMING_OVERLAP', row.cue_id, 'deterministic_query'),
    severity: 'blocker',
    is_blocker: true,
    confidence: 1,
    headline: `Cue ${row.cue_id} overlaps cue ${next_id} by ${row.overlap_ms} ms`,
    detail: `Cue ${row.cue_id} ends at ${row.end_ms} ms but cue ${next_id} starts at ${next_start} ms; consecutive cues must be separated by at least ${MIN_CUE_GAP_MS} ms.`,
    evidence,
    proposed_repair: repair,
    evidence_ref: ref(ctx, 'TIMING_OVERLAP', 'Q2_TIMING_OVERLAP'),
  };
}

export function buildReadingSpeedFinding(row: CpsRow, cue: CueLike, next_start_ms: number | null, ctx: FindingContext): Finding {
  const { end_ms, fits } = repairReadingSpeedEnd(cue.start_ms, row.chars, next_start_ms);
  const newDuration = end_ms - cue.start_ms;
  const newCps = round1(row.chars / (newDuration / 1000));
  const evidence: ReadingSpeedEvidence = {
    rule: 'READING_SPEED',
    cue_id: row.cue_id,
    text: row.text,
    chars: row.chars,
    duration_ms: row.duration_ms,
    cps: row.cps,
    limit_cps: CPS_LIMIT,
  };
  const repair: ProposedRepair = {
    kind: 'extend_out_time',
    cue_id: cue.cue_id,
    summary: fits
      ? `Extend cue ${cue.cue_id} out-time by ${end_ms - cue.end_ms} ms to ${newDuration} ms so it reads at ${newCps} CPS`
      : `Extend cue ${cue.cue_id} out-time to the maximum that fits before the next cue (${newCps} CPS residual)`,
    before: { start_ms: cue.start_ms, end_ms: cue.end_ms, text: cue.text },
    after: { start_ms: cue.start_ms, end_ms, text: cue.text },
    origin: 'deterministic',
    requires_human_approval: true,
    verification: {
      cps: newCps,
      cps_limit: CPS_LIMIT,
      duration_ms: newDuration,
      gap_to_next_ms: next_start_ms == null ? 'n/a' : next_start_ms - end_ms,
      fits_before_next_cue: fits,
    },
  };
  return {
    ...base(ctx, 'READING_SPEED', row.cue_id, 'deterministic_query'),
    severity: 'blocker',
    is_blocker: true,
    confidence: 1,
    headline: `Cue ${row.cue_id} reads at ${row.cps} CPS, above the ${CPS_LIMIT} CPS limit`,
    detail: `${row.chars} characters over ${row.duration_ms} ms (${(row.duration_ms / 1000).toFixed(1)} s) is ${row.cps} characters per second; the limit is ${CPS_LIMIT}.`,
    evidence,
    proposed_repair: repair,
    evidence_ref: ref(ctx, 'READING_SPEED', 'Q3_READING_SPEED'),
  };
}

export function buildGlossaryFinding(row: PairRow, term: GlossaryRow, cue: CueLike, ctx: FindingContext): Finding {
  const { found_term, edit_distance } = findClosestTerm(row.target_text, term.approved_target_term);
  const newText = replaceTerm(cue.text, found_term, term.approved_target_term);
  const evidence: GlossaryDriftEvidence = {
    rule: 'GLOSSARY_DRIFT',
    cue_id: row.cue_id,
    source_term: term.source_term,
    approved_target_term: term.approved_target_term,
    found_term,
    edit_distance,
    source_text: row.source_text,
    target_text: row.target_text,
  };
  const repair: ProposedRepair = {
    kind: 'replace_text',
    cue_id: cue.cue_id,
    summary: `Replace "${found_term}" with the approved glossary term "${term.approved_target_term}" in cue ${cue.cue_id}`,
    before: { start_ms: cue.start_ms, end_ms: cue.end_ms, text: cue.text },
    after: { start_ms: cue.start_ms, end_ms: cue.end_ms, text: newText },
    origin: 'deterministic',
    requires_human_approval: true,
    verification: {
      contains_approved_term: newText.includes(term.approved_target_term),
      cps: computeCps(newText, cue.end_ms - cue.start_ms),
      cps_limit: CPS_LIMIT,
      edit_distance,
    },
  };
  return {
    ...base(ctx, 'GLOSSARY_DRIFT', row.cue_id, 'deterministic_query'),
    severity: 'blocker',
    is_blocker: true,
    confidence: 1,
    headline: `Glossary says "${term.approved_target_term}", delivery says "${found_term}"`,
    detail: `Source cue ${row.cue_id} contains "${term.source_term}" but the Spanish target uses "${found_term}" instead of the approved term "${term.approved_target_term}" (edit distance ${edit_distance}).`,
    evidence,
    proposed_repair: repair,
    evidence_ref: ref(ctx, 'GLOSSARY_DRIFT', 'Q5_GLOSSARY_DRIFT'),
  };
}

export function semanticIsBlocker(out: SemanticReviewOutput): boolean {
  return out.verdict === 'MEANING_REVERSED' || (out.verdict === 'MEANING_SHIFTED' && out.severity === 'high');
}

export function semanticDisplaySeverity(out: SemanticReviewOutput): Severity {
  if (out.verdict === 'MEANING_REVERSED') return 'high';
  if (out.verdict === 'MEANING_PRESERVED') return 'info';
  return out.severity;
}

export function semanticNarrowingRule(candidate: SemanticCandidateRow, latest_revision: string): string {
  return `Escalated because the source of cue ${candidate.cue_id} changed in revision ${latest_revision} after target v${candidate.target_version} was translated (Q6: source_target_pairs with source_revision = ${latest_revision}); Gemini received only this one source/target pair.`;
}

export function semanticReviewInput(candidate: SemanticCandidateRow, locale: string): SemanticReviewInput {
  return {
    cue_id: candidate.cue_id,
    locale,
    source_language: 'en',
    source_text: candidate.source_text,
    target_text: candidate.target_text,
    previous_source_text: candidate.previous_source_text ?? null,
    source_revision: candidate.source_revision,
    target_version: candidate.target_version,
  };
}

export function placeholderSemanticReview(input: SemanticReviewInput, model: string, backend: 'vertex-ai' | 'gemini-api', started_at: string): SemanticReview {
  return {
    framework: 'google-adk',
    agent_name: 'semantic_reviewer',
    model,
    backend,
    input,
    output: {
      verdict: 'MEANING_SHIFTED',
      severity: 'high',
      confidence: 0,
      explanation: 'Pending live Gemini review',
      suggested_target_text: null,
    },
    raw_text: null,
    started_at,
    latency_ms: 0,
  };
}

export interface SemanticFindingOptions {
  source?: FindingSource;
  headline?: string;
  severity?: Severity;
  is_blocker?: boolean;
  fallback_target_text?: string | null;
}

export function buildSemanticFinding(
  candidate: SemanticCandidateRow,
  cue: CueLike,
  review: SemanticReview,
  latest_revision: string,
  ctx: FindingContext,
  opts: SemanticFindingOptions = {},
): Finding | null {
  const out = review.output;
  if (out.verdict === 'MEANING_PRESERVED' && opts.source !== 'deterministic_query') return null;
  const evidence: SemanticEvidence = {
    rule: 'SEMANTIC_REVERSAL',
    cue_id: candidate.cue_id,
    source_text: candidate.source_text,
    target_text: candidate.target_text,
    previous_source_text: candidate.previous_source_text ?? null,
    source_revision: candidate.source_revision,
    target_version: candidate.target_version,
    narrowing_rule: semanticNarrowingRule(candidate, latest_revision),
    review,
  };
  const duration = cue.end_ms - cue.start_ms;
  const fallback = opts.fallback_target_text === undefined ? SEMANTIC_FALLBACK_TARGET_TEXT : opts.fallback_target_text;
  let suggestion = (out.suggested_target_text ?? '').trim();
  let origin: ProposedRepair['origin'] = 'gemini_suggestion';
  let note = 'Gemini suggestion; requires human approval';
  if (!suggestion || countChars(suggestion) > 84 || computeCps(suggestion, duration) > CPS_LIMIT) {
    if (fallback) {
      note = suggestion
        ? `Gemini suggestion "${suggestion}" would violate a deterministic rule; deterministic reference line used instead`
        : 'Gemini returned no suggestion; deterministic reference line used';
      suggestion = fallback;
      origin = 'deterministic';
    } else {
      suggestion = '';
    }
  }
  const repair: ProposedRepair | null = suggestion
    ? {
        kind: 'replace_text',
        cue_id: cue.cue_id,
        summary: `Replace the subtitle text of cue ${cue.cue_id} with "${suggestion}" (${origin === 'gemini_suggestion' ? 'Gemini suggestion, human-approved' : 'deterministic reference line'})`,
        before: { start_ms: cue.start_ms, end_ms: cue.end_ms, text: cue.text },
        after: { start_ms: cue.start_ms, end_ms: cue.end_ms, text: suggestion },
        origin,
        requires_human_approval: true,
        verification: {
          cps: computeCps(suggestion, duration),
          cps_limit: CPS_LIMIT,
          chars: countChars(suggestion),
          note,
        },
      }
    : null;
  const reversed = out.verdict === 'MEANING_REVERSED';
  const headline =
    opts.headline ??
    (reversed
      ? `Source says "${candidate.source_text}", subtitle says "${candidate.target_text}" - meaning reversed`
      : `Source says "${candidate.source_text}", subtitle says "${candidate.target_text}" - meaning shifted`);
  return {
    ...base(ctx, 'SEMANTIC_REVERSAL', candidate.cue_id, opts.source ?? 'gemini_semantic_review'),
    severity: opts.severity ?? semanticDisplaySeverity(out),
    is_blocker: opts.is_blocker ?? semanticIsBlocker(out),
    confidence: out.confidence,
    headline,
    detail: out.explanation,
    evidence,
    proposed_repair: repair,
    evidence_ref: ref(ctx, 'SEMANTIC_REVERSAL', 'Q6_SEMANTIC_CANDIDATES'),
  };
}

export interface DeterministicRows {
  q2: OverlapRow[];
  q3: CpsRow[];
  q4: GlossaryRow[];
  q5: PairRow[];
}

export function localRows(cues: CueLike[], pairs: PairRow[], glossary: GlossaryRow[]): DeterministicRows {
  return {
    q2: scanOverlaps(cues),
    q3: scanReadingSpeed(cues),
    q4: glossary.map((g) => ({ source_term: g.source_term, approved_target_term: g.approved_target_term })),
    q5: scanGlossaryDrift(pairs, glossary),
  };
}

export function evaluateDeterministicFindings(rows: DeterministicRows, cues: CueLike[], ctx: FindingContext): Finding[] {
  const byId = new Map(cues.map((c) => [c.cue_id, c]));
  const sorted = [...cues].sort((a, b) => a.start_ms - b.start_ms || a.cue_id - b.cue_id);
  const nextStart = new Map<number, number | null>();
  sorted.forEach((c, i) => nextStart.set(c.cue_id, i + 1 < sorted.length ? sorted[i + 1].start_ms : null));
  const findings: Finding[] = [];

  for (const row of rows.q2) {
    const cue = byId.get(row.cue_id);
    if (!cue) continue;
    findings.push(buildOverlapFinding(row, cue, ctx));
  }
  for (const row of rows.q3) {
    const cue = byId.get(row.cue_id);
    if (!cue) continue;
    findings.push(buildReadingSpeedFinding(row, cue, nextStart.get(cue.cue_id) ?? null, ctx));
  }
  for (const row of rows.q5) {
    const cue = byId.get(row.cue_id);
    if (!cue) continue;
    for (const term of rows.q4) {
      if (row.source_text.includes(term.source_term) && !row.target_text.includes(term.approved_target_term)) {
        findings.push(buildGlossaryFinding(row, term, cue, ctx));
        break;
      }
    }
  }
  return sortFindings(findings);
}

export function sortFindings<F extends { priority: number; cue_id: number }>(findings: F[]): F[] {
  return [...findings].sort((a, b) => a.priority - b.priority || a.cue_id - b.cue_id);
}

export function applyRepairs<C extends CueLike>(cues: C[], findings: Pick<Finding, 'proposed_repair'>[]): C[] {
  const repaired = new Map<number, C>(cues.map((c) => [c.cue_id, { ...c }]));
  for (const f of findings) {
    const r = f.proposed_repair;
    if (!r) continue;
    const cue = repaired.get(r.cue_id);
    if (!cue) continue;
    repaired.set(r.cue_id, { ...cue, start_ms: r.after.start_ms, end_ms: r.after.end_ms, text: r.after.text });
  }
  return [...repaired.values()].sort((a, b) => a.cue_id - b.cue_id);
}

export function applyRepairsToPairs<P extends SourceTargetPair>(pairs: P[], repairedCues: CueLike[]): P[] {
  const text = new Map(repairedCues.map((c) => [c.cue_id, c.text]));
  return pairs.map((p) => {
    const t = text.get(p.cue_id);
    return t !== undefined && t !== p.target_text ? { ...p, target_text: t } : { ...p };
  });
}

export interface Violation {
  rule: RuleId;
  cue_id: number;
  detail: string;
}

export function deterministicViolations(cues: CueLike[], pairs: PairRow[], glossary: GlossaryRow[]): Violation[] {
  const rows = localRows(cues, pairs, glossary);
  const v: Violation[] = [];
  for (const r of rows.q2) v.push({ rule: 'TIMING_OVERLAP', cue_id: r.cue_id, detail: `overlaps ${r.next_cue_id} by ${r.overlap_ms} ms` });
  for (const r of rows.q3) v.push({ rule: 'READING_SPEED', cue_id: r.cue_id, detail: `${r.cps} CPS` });
  for (const r of rows.q5) v.push({ rule: 'GLOSSARY_DRIFT', cue_id: r.cue_id, detail: `target lacks approved term` });
  return v;
}

export function glossaryViolationsCaseInsensitive(pairs: PairRow[], glossary: GlossaryRow[]): Violation[] {
  const v: Violation[] = [];
  for (const p of pairs) {
    for (const g of glossary) {
      if (p.source_text.toLowerCase().includes(g.source_term.toLowerCase()) && !p.target_text.toLowerCase().includes(g.approved_target_term.toLowerCase())) {
        v.push({ rule: 'GLOSSARY_DRIFT', cue_id: p.cue_id, detail: `"${g.source_term}" present, "${g.approved_target_term}" missing (ci)` });
      }
    }
  }
  return v;
}

export function minGapViolations(cues: CueLike[]): Violation[] {
  const sorted = [...cues].sort((a, b) => a.start_ms - b.start_ms);
  const v: Violation[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = sorted[i + 1].start_ms - sorted[i].end_ms;
    if (gap < MIN_CUE_GAP_MS) v.push({ rule: 'TIMING_OVERLAP', cue_id: sorted[i].cue_id, detail: `gap ${gap} ms < ${MIN_CUE_GAP_MS}` });
  }
  return v;
}

export function withEvidenceJson<F extends Finding>(f: F): F & { evidence_json: string } {
  return { ...f, evidence_json: JSON.stringify(f.evidence) };
}

export { SubtitleCue };
