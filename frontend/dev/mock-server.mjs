#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.MOCK_PORT || 8790);
const RESET_KEY = process.env.MOCK_RESET_KEY || null;
const FAIL_PHASE = process.env.MOCK_FAIL_PHASE || null;
const SPEED = Math.max(0.1, Number(process.env.MOCK_SPEED || 1));
const REPO_URL = process.env.MOCK_REPO_URL || null;

const DISCLAIMER = 'Synthetic demo data - The Last Tram is original fictional content. No real studio, vendor, or customer data.';
const TITLE_ID = 'tt_last_tram';
const DB = 'localelock_dev';
const MCP_VERSION = '0.6.0';
const ADK_VERSION = '2.0.0';
const GENAI_VERSION = '2.21.0';
const MODEL = 'gemini-2.5-flash';
const SYNTHETIC_ROWS = 121_480;

const iso = (d) => new Date(d).toISOString();
const ms = (n) => n / SPEED;
const sleep = (n) => new Promise((r) => setTimeout(r, ms(n)));
let idCounter = 0;
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${(idCounter++).toString(36)}`;

const GLOSSARY = [
  ['Mara Voss', 'Mara Voss'],
  ['Teo Aldana', 'Teo Aldana'],
  ['the depot', 'la cochera'],
  ['dispatch', 'despacho'],
  ['last tram', 'último tranvía'],
  ['night shift', 'turno de noche'],
].map(([source_term, approved_target_term]) => ({ source_term, approved_target_term }));

const Q2_ROWS = [{ cue_id: 118, start_ms: 349000, end_ms: 352420, next_cue_id: 119, next_start_ms: 352000, overlap_ms: 420 }];
const Q3_ROWS = [
  { cue_id: 204, start_ms: 611200, end_ms: 613600, text: 'Si el último tranvía se va sin nosotros, nadie sabrá dónde.', chars: 59, duration_ms: 2400, cps: 24.6 },
];
const Q5_ROWS = [{ cue_id: 57, source_text: 'Mara Voss signed the manifest herself.', target_text: 'Maria Voss firmó el manifiesto ella misma.' }];
const Q6_ROWS_V7 = [
  { cue_id: 231, source_text: 'Do not send it yet.', target_text: 'Envialo ahora.', previous_source_text: 'Send it now.', source_revision: 'r3', target_version: 7 },
];
const Q6_ROWS_V8 = [
  { cue_id: 231, source_text: 'Do not send it yet.', target_text: 'No lo envíes todavía.', previous_source_text: 'Send it now.', source_revision: 'r3', target_version: 8 },
];

function queryPlan(version) {
  const match = { title_id: TITLE_ID, locale: 'es', version };
  return [
    { query_id: 'Q1_LIST_COLLECTIONS', tool: 'list_tables', collection: null, query: { database: DB }, summary: `Discover collections in ${DB}`, rows: () => [
      { name: 'subtitle_cues' }, { name: 'source_target_pairs' }, { name: 'glossary_terms' }, { name: 'localization_events' }, { name: 'qc_findings' }, { name: 'release_runs' }, { name: 'approvals' }, { name: 'demo_meta' },
    ] },
    { query_id: 'Q2_TIMING_OVERLAP', tool: 'run_query', collection: 'subtitle_cues', summary: `Consecutive-cue overlap scan for The Last Tram / es / v${version}`,
      query: { collection: 'subtitle_cues', pipeline: [ { $match: match }, { $sort: { start_ms: 1 } }, { $setWindowFields: { sortBy: { start_ms: 1 }, output: { next_cue_id: { $shift: { output: '$cue_id', by: 1 } }, next_start_ms: { $shift: { output: '$start_ms', by: 1 } } } } }, { $project: { _id: 0, cue_id: 1, start_ms: 1, end_ms: 1, next_cue_id: 1, next_start_ms: 1, overlap_ms: { $subtract: ['$end_ms', '$next_start_ms'] } } }, { $match: { overlap_ms: { $gt: 0 } } }, { $sort: { overlap_ms: -1 } } ] },
      rows: () => (version === 7 ? Q2_ROWS : []) },
    { query_id: 'Q3_READING_SPEED', tool: 'run_query', collection: 'subtitle_cues', summary: `Reading-speed (CPS > 20) aggregate for The Last Tram / es / v${version}`,
      query: { collection: 'subtitle_cues', pipeline: [ { $match: match }, { $project: { _id: 0, cue_id: 1, start_ms: 1, end_ms: 1, text: 1, chars: { $strLenCP: { $replaceAll: { input: '$text', find: '\n', replacement: '' } } }, duration_ms: { $subtract: ['$end_ms', '$start_ms'] } } }, { $addFields: { cps: { $round: [ { $divide: ['$chars', { $divide: ['$duration_ms', 1000] }] }, 1 ] } } }, { $match: { cps: { $gt: 20 } } }, { $sort: { cps: -1 } } ] },
      rows: () => (version === 7 ? Q3_ROWS : []) },
    { query_id: 'Q4_GLOSSARY_TERMS', tool: 'find', collection: 'glossary_terms', summary: 'Load the approved glossary for The Last Tram / es',
      query: { collection: 'glossary_terms', filter: { title_id: TITLE_ID, locale: 'es' }, projection: { _id: 0, source_term: 1, approved_target_term: 1 }, limit: 50 }, rows: () => GLOSSARY },
    { query_id: 'Q5_GLOSSARY_DRIFT', tool: 'find', collection: 'source_target_pairs', summary: `Pairs whose source uses a glossary term but whose target lacks the approved term (v${version})`,
      query: { collection: 'source_target_pairs', filter: { title_id: TITLE_ID, locale: 'es', target_version: version, $or: GLOSSARY.map((g) => ({ source_text: { $regex: g.source_term }, target_text: { $not: { $regex: g.approved_target_term } } })) }, projection: { _id: 0, cue_id: 1, source_text: 1, target_text: 1 }, limit: 50 },
      rows: () => (version === 7 ? Q5_ROWS : []) },
    { query_id: 'Q6_SEMANTIC_CANDIDATES', tool: 'find', collection: 'source_target_pairs', summary: `Pairs whose source changed in r3 after the v${version} translation (semantic candidates)`,
      query: { collection: 'source_target_pairs', filter: { title_id: TITLE_ID, locale: 'es', target_version: version, source_revision: 'r3' }, projection: { _id: 0, cue_id: 1, source_text: 1, target_text: 1, previous_source_text: 1, source_revision: 1, target_version: 1 }, limit: 50 },
      rows: () => (version === 7 ? Q6_ROWS_V7 : Q6_ROWS_V8) },
  ];
}

function baseFinding(run, extra) {
  return {
    finding_id: newId('f'),
    run_id: run.run_id,
    title_id: TITLE_ID,
    locale: 'es',
    version: run.version,
    source: 'deterministic_query',
    confidence: 1,
    status: 'open',
    created_at: iso(Date.now()),
    ...extra,
  };
}

function deterministicFindings(run, traceSteps) {
  return [
    baseFinding(run, {
      cue_id: 118, rule_id: 'TIMING_OVERLAP', severity: 'blocker', is_blocker: true, priority: 1,
      headline: 'Cue 118 overlaps cue 119 by 420 ms',
      detail: 'Cue 118 ends 420 ms after cue 119 starts; consecutive cues need a gap of at least 80 ms.',
      evidence: { rule: 'TIMING_OVERLAP', cue_id: 118, next_cue_id: 119, cue_start_ms: 349000, cue_end_ms: 352420, next_start_ms: 352000, overlap_ms: 420, min_gap_ms: 80 },
      proposed_repair: { kind: 'trim_out_time', cue_id: 118, summary: 'Trim cue 118 out-time by 500 ms so it ends 80 ms before cue 119', before: { start_ms: 349000, end_ms: 352420, text: '¿Y si el tranvía no vuelve?' }, after: { start_ms: 349000, end_ms: 351920, text: '¿Y si el tranvía no vuelve?' }, origin: 'deterministic', requires_human_approval: true, verification: { overlap_ms: -80, cps: 9.2 } },
      evidence_ref: { trace_step: traceSteps.Q2_TIMING_OVERLAP ?? null, query_id: 'Q2_TIMING_OVERLAP' },
    }),
    baseFinding(run, {
      cue_id: 204, rule_id: 'READING_SPEED', severity: 'blocker', is_blocker: true, priority: 2,
      headline: 'Cue 204 reads at 24.6 CPS, above the 20 CPS limit',
      detail: '59 characters in 2.4 s is 24.6 characters per second; the limit is 20.',
      evidence: { rule: 'READING_SPEED', cue_id: 204, text: Q3_ROWS[0].text, chars: 59, duration_ms: 2400, cps: 24.6, limit_cps: 20 },
      proposed_repair: { kind: 'extend_out_time', cue_id: 204, summary: 'Extend cue 204 out-time to 3.0 s (19.7 CPS), keeping 80 ms before cue 205', before: { start_ms: 611200, end_ms: 613600, text: Q3_ROWS[0].text }, after: { start_ms: 611200, end_ms: 614200, text: Q3_ROWS[0].text }, origin: 'deterministic', requires_human_approval: true, verification: { cps: 19.7, gap_to_next_ms: 800 } },
      evidence_ref: { trace_step: traceSteps.Q3_READING_SPEED ?? null, query_id: 'Q3_READING_SPEED' },
    }),
    baseFinding(run, {
      cue_id: 57, rule_id: 'GLOSSARY_DRIFT', severity: 'blocker', is_blocker: true, priority: 3,
      headline: 'Glossary says "Mara Voss", delivery says "Maria Voss"',
      detail: 'The approved character name is Mara Voss; the v7 subtitle for cue 57 uses Maria Voss (edit distance 1).',
      evidence: { rule: 'GLOSSARY_DRIFT', cue_id: 57, source_term: 'Mara Voss', approved_target_term: 'Mara Voss', found_term: 'Maria Voss', edit_distance: 1, source_text: Q5_ROWS[0].source_text, target_text: Q5_ROWS[0].target_text },
      proposed_repair: { kind: 'replace_text', cue_id: 57, summary: 'Replace "Maria Voss" with the approved glossary term "Mara Voss"', before: { start_ms: 171000, end_ms: 173800, text: 'Maria Voss firmó el manifiesto ella misma.' }, after: { start_ms: 171000, end_ms: 173800, text: 'Mara Voss firmó el manifiesto ella misma.' }, origin: 'deterministic', requires_human_approval: true, verification: { glossary_consistent: true } },
      evidence_ref: { trace_step: traceSteps.Q5_GLOSSARY_DRIFT ?? null, query_id: 'Q5_GLOSSARY_DRIFT' },
    }),
  ];
}

function semanticReview(input, preserved) {
  return {
    framework: 'google-adk',
    agent_name: 'semantic_reviewer',
    model: MODEL,
    backend: 'vertex-ai',
    input,
    output: preserved
      ? { verdict: 'MEANING_PRESERVED', severity: 'low', confidence: 0.97, explanation: 'The Spanish line "No lo envíes todavía." faithfully conveys "Do not send it yet." - negation and intent are preserved.', suggested_target_text: null }
      : { verdict: 'MEANING_REVERSED', severity: 'high', confidence: 0.96, explanation: 'The source says NOT to send it yet; the Spanish target "Envialo ahora." instructs to send it now, reversing the polarity and intent of the line.', suggested_target_text: 'No lo envíes todavía.' },
    raw_text: null,
    started_at: iso(Date.now()),
    latency_ms: 1180,
  };
}

function semanticFinding(run, review, traceSteps) {
  return baseFinding(run, {
    cue_id: 231, rule_id: 'SEMANTIC_REVERSAL', severity: 'high', is_blocker: true, priority: 4,
    source: 'gemini_semantic_review', confidence: review.output.confidence,
    headline: 'Source says "Do not send it yet.", subtitle says "Envialo ahora." - meaning reversed',
    detail: 'Cue 231 changed in source r3 after the v7 translation; Gemini reviewed only this pair and found the meaning reversed.',
    evidence: { rule: 'SEMANTIC_REVERSAL', cue_id: 231, source_text: 'Do not send it yet.', target_text: 'Envialo ahora.', previous_source_text: 'Send it now.', source_revision: 'r3', target_version: 7, narrowing_rule: 'source_revision r3 is newer than the revision the v7 target was translated against', review },
    proposed_repair: { kind: 'replace_text', cue_id: 231, summary: 'Replace the reversed line with Gemini\'s suggested "No lo envíes todavía." (human-approved)', before: { start_ms: 700400, end_ms: 702600, text: 'Envialo ahora.' }, after: { start_ms: 700400, end_ms: 702600, text: 'No lo envíes todavía.' }, origin: 'gemini_suggestion', requires_human_approval: true, verification: { chars: 21, cps: 9.5 } },
    evidence_ref: { trace_step: traceSteps.Q6_SEMANTIC_CANDIDATES ?? null, query_id: 'Q6_SEMANTIC_CANDIDATES' },
  });
}

const store = { runs: new Map(), events: [], T0: Date.now(), lastResetAt: 0 };

function makeEvents(T0) {
  const H = 3_600_000, D = 24 * H;
  const releaseAt = T0 + 2 * H;
  const ev = (event_type, source_revision, target_version, occurred_at, summary, actor) => ({ event_id: newId('evt'), title_id: TITLE_ID, locale: 'es', event_type, source_revision, target_version, occurred_at: iso(occurred_at), summary, actor });
  return {
    releaseAt,
    events: [
      ev('script_locked', 'r1', null, T0 - 21 * D, 'Script locked at r1', 'Script department'),
      ev('vendor_delivery', 'r1', 1, T0 - 18 * D, 'Spanish v1 delivered', 'Synthetic vendor: Meridian Subs (fictional)'),
      ev('source_revision', 'r2', null, T0 - 9 * D, 'Minor line polish across 5 cues', 'Script department'),
      ev('vendor_delivery', 'r2', 6, T0 - 2 * D, 'Spanish v6 delivered', 'Synthetic vendor: Meridian Subs (fictional)'),
      ev('release_scheduled', 'r2', null, T0 - D, `Release window opens at ${iso(releaseAt)}`, 'Release management'),
      ev('source_revision', 'r3', null, T0 - (3 * H + 10 * 60_000), 'Line 231 changed: "Send it now." → "Do not send it yet."', "Director's office"),
      ev('vendor_delivery', 'r3', 7, T0 - (2 * H + 5 * 60_000), 'Spanish v7 delivered - translated against source r2', 'Synthetic vendor: Meridian Subs (fictional)'),
    ],
  };
}

function baselineRun(T0) {
  const run = {
    run_id: 'run_baseline_v7', title_id: TITLE_ID, locale: 'es', version: 7, trigger: 'vendor_delivery', trigger_event_id: null, parent_run_id: null, recheck_run_id: null,
    started_at: iso(T0 - 2 * 3_600_000), ended_at: iso(T0 - 2 * 3_600_000 + 1400), duration_ms: 1400, phase: 'complete',
    phases: [], release_state: 'HELD', blocker_count: 4, finding_count: 4, findings: [], trace: [], agent: null, semantic_review: null, semantic_candidates: null, approval: null, error: null,
    origin: 'seed_baseline', dataset: { synthetic_rows_total: SYNTHETIC_ROWS, disclaimer: DISCLAIMER },
  };
  const placeholderReview = {
    framework: 'google-adk', agent_name: 'semantic_reviewer', model: MODEL, backend: 'vertex-ai',
    input: { cue_id: 231, locale: 'es', source_language: 'en', source_text: 'Do not send it yet.', target_text: 'Envialo ahora.', previous_source_text: 'Send it now.', source_revision: 'r3', target_version: 7 },
    output: { verdict: 'MEANING_SHIFTED', severity: 'high', confidence: 0, explanation: 'Pending live Gemini review', suggested_target_text: null },
    raw_text: null, started_at: run.started_at, latency_ms: 0,
  };
  const det = deterministicFindings(run, {});
  const sem = baseFinding(run, {
    cue_id: 231, rule_id: 'SEMANTIC_REVERSAL', severity: 'high', is_blocker: true, priority: 4,
    headline: 'Cue 231 changed in source r3 after translation - semantic review required',
    detail: 'The source line changed after the v7 translation was produced; a live Gemini review will judge the pair.',
    evidence: { rule: 'SEMANTIC_REVERSAL', cue_id: 231, source_text: 'Do not send it yet.', target_text: 'Envialo ahora.', previous_source_text: 'Send it now.', source_revision: 'r3', target_version: 7, narrowing_rule: 'source_revision r3 is newer than the revision the v7 target was translated against', review: placeholderReview },
    proposed_repair: { kind: 'replace_text', cue_id: 231, summary: 'Replace with the deterministic reference line (pending live review)', before: { start_ms: 700400, end_ms: 702600, text: 'Envialo ahora.' }, after: { start_ms: 700400, end_ms: 702600, text: 'No lo envíes todavía.' }, origin: 'deterministic', requires_human_approval: true, verification: {} },
    evidence_ref: { trace_step: null, query_id: 'Q6_SEMANTIC_CANDIDATES' },
  });
  run.findings = [...det, sem];
  return run;
}

function resetStore() {
  store.T0 = Date.now();
  const { events, releaseAt } = makeEvents(store.T0);
  store.events = events;
  store.releaseAt = releaseAt;
  store.runs = new Map();
  const base = baselineRun(store.T0);
  store.runs.set(base.run_id, base);
}
resetStore();

function latestRun() {
  return [...store.runs.values()].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0] ?? null;
}
function stripRun(run) {
  return run;
}
function demoState() {
  const lr = latestRun();
  const now = Date.now();
  const incoming = store.events.find((e) => e.event_type === 'vendor_delivery' && e.target_version === 7);
  const approved = [...store.runs.values()].find((r) => r.approval)?.approval?.approved_version ?? null;
  return {
    title: { title_id: TITLE_ID, name: 'The Last Tram', runtime_min: 12, logline: 'A night dispatcher and a tram driver share the depot\'s last run before it closes for good.', source_language: 'en', latest_source_revision: 'r3' },
    delivery: { locale: 'es', locale_name: 'Spanish (Latin America)', version: 7, vendor: 'Synthetic vendor: Meridian Subs (fictional)', delivered_at: incoming.occurred_at, release_at: iso(store.releaseAt), minutes_to_release: Math.round((store.releaseAt - now) / 60_000) },
    incoming_event: incoming,
    recent_events: [...store.events].sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at)).slice(0, 8),
    release: lr ? { state: lr.release_state, blocker_count: lr.blocker_count, version: lr.version, as_of_run_id: lr.run_id, as_of: lr.ended_at ?? lr.started_at, origin: lr.origin } : { state: 'HELD', blocker_count: 4, version: 7, as_of_run_id: null, as_of: iso(now), origin: 'seed_baseline' },
    latest_run: lr ? stripRun(lr) : null,
    approved_version: approved,
    dataset: { synthetic_rows_total: SYNTHETIC_ROWS, counts: { subtitle_cues: 96720, source_target_pairs: 25440, glossary_terms: 6, localization_events: 1512, qc_findings: 4004, release_runs: 601, approvals: 0 }, titles: 45, locales: 4, disclaimer: DISCLAIMER, computed_at: iso(store.T0) },
    now: iso(now),
  };
}

function health(deep) {
  return {
    ok: true, service: 'localelock-live', version: 'mock-0.1.0', time: iso(Date.now()),
    runtime: { mode: 'local', node: process.version, region: null, function: null },
    clickhouse: { ok: true, latency_ms: 3, database: DB, host_hint: '127.0.0.1', version: '26.8.2.7', agent_user: 'localelock_agent', agent_read_only: true, counts: { subtitle_cues: 96720, source_target_pairs: 25440, glossary_terms: 6, localization_events: 1512, qc_findings: 4004, release_runs: 601, approvals: 0, demo_meta: 1 }, synthetic_rows_total: SYNTHETIC_ROWS, error: null },
    gemini: { configured: true, backend: 'vertex-ai', project: 'localelock-live', location: 'us-central1', model: MODEL, ok: deep ? true : null, latency_ms: deep ? 412 : null, error: null },
    mcp: { server: 'mcp-clickhouse', version: MCP_VERSION, read_only: true, tools_allowed: ['list_databases', 'list_tables', 'run_query'], ok: deep ? true : null, latency_ms: deep ? 640 : null, error: null },
    adk: { framework: 'google-adk', version: ADK_VERSION, agents: ['release_gate_agent', 'semantic_reviewer'] },
    agent_db_boundary: 'agent uses a SELECT-only ClickHouse user through mcp-clickhouse with write access disabled; ingestion is a separate app path',
    demo: { reset_requires_key: !!RESET_KEY, seed_requires_key: true },
  };
}

function setPhase(run, phase, note = null) {
  const now = Date.now();
  const last = run.phases[run.phases.length - 1];
  if (last && !last.ended_at) {
    last.ended_at = iso(now);
    last.duration_ms = now - Date.parse(last.started_at);
  }
  run.phase = phase;
  if (phase !== 'complete' && phase !== 'failed') run.phases.push({ phase, started_at: iso(now), ended_at: null, duration_ms: null, note });
}

function createRun({ version, trigger, parent_run_id }) {
  const now = Date.now();
  const trig = store.events.find((e) => e.event_type === 'vendor_delivery' && e.target_version === 7);
  const run = {
    run_id: newId('run'), title_id: TITLE_ID, locale: 'es', version, trigger, trigger_event_id: trig?.event_id ?? null, parent_run_id, recheck_run_id: null,
    started_at: iso(now), ended_at: null, duration_ms: null, phase: 'event_received', phases: [], release_state: 'RUNNING', blocker_count: 0, finding_count: 0,
    findings: [], trace: [], agent: null, semantic_review: null, semantic_candidates: null, approval: null, error: null, origin: 'release_gate',
    dataset: { synthetic_rows_total: SYNTHETIC_ROWS, disclaimer: DISCLAIMER },
  };
  store.runs.set(run.run_id, run);
  void simulate(run);
  return run;
}

async function simulate(run) {
  const fail = (phase) => {
    if (FAIL_PHASE === phase) {
      setPhase(run, 'failed');
      run.release_state = 'FAILED';
      run.error = { phase, message: `Simulated failure in ${phase} (MOCK_FAIL_PHASE)`, retryable: true, hint: 'Unset MOCK_FAIL_PHASE and retry.' };
      run.ended_at = iso(Date.now());
      run.duration_ms = Date.parse(run.ended_at) - Date.parse(run.started_at);
      return true;
    }
    return false;
  };
  const isRecheck = run.trigger === 'recheck_after_approval';
  setPhase(run, 'event_received', isRecheck ? `Recheck after approval - approved v${run.version} ingested` : 'vendor_delivery v7: Spanish v7 delivered - translated against source r2');
  await sleep(500);
  if (fail('event_received')) return;
  setPhase(run, 'querying_clickhouse', 'ADK release_gate_agent executing Q1-Q6 through mcp-clickhouse');
  run.agent = { framework: 'google-adk', adk_version: ADK_VERSION, genai_sdk_version: GENAI_VERSION, model: MODEL, backend: 'vertex-ai', project: 'localelock-live', location: 'us-central1', app_name: 'localelock-live', session_id: crypto.randomUUID(), agent_name: 'release_gate_agent', llm_turns: 0, total_tool_calls: 0, started_at: iso(Date.now()), duration_ms: 0, final_text: null, warnings: [] };
  const steps = {};
  const plan = queryPlan(run.version);
  for (let i = 0; i < plan.length; i += 1) {
    await sleep(380);
    if (fail('querying_clickhouse')) return;
    const q = plan[i];
    const rows = q.rows();
    const fallback = i === 4 && process.env.MOCK_FALLBACK === '1';
    const entry = {
      step: i + 1, kind: 'mcp_tool_call', initiator: fallback ? 'app_fallback' : 'adk_agent', server: 'mcp-clickhouse', server_version: MCP_VERSION, tool: q.tool, query_id: q.query_id, database: DB, collection: q.collection,
      query_summary: q.summary, query: q.query, started_at: iso(Date.now()), duration_ms: 40 + Math.round(Math.random() * 120), ok: true, error: null, row_count: rows.length, rows_preview: rows.slice(0, 10), matched_expected: true,
    };
    run.trace.push(entry);
    steps[q.query_id] = entry.step;
    run.agent.total_tool_calls += 1;
    run.agent.llm_turns += 1;
    if (fallback) run.agent.warnings.push('Q5 was not executed by the agent verbatim; the app ran the exact expected query through MCP (app_fallback).');
  }
  run.agent.llm_turns += 1;
  run.agent.final_text = 'Query plan complete: Q1-Q6 executed.';
  run.agent.duration_ms = Date.now() - Date.parse(run.agent.started_at);
  await sleep(300);
  if (fail('querying_clickhouse')) return;
  setPhase(run, 'deterministic_qc', 'Evaluating TIMING_OVERLAP, READING_SPEED, GLOSSARY_DRIFT from matched trace rows');
  run.findings = isRecheck ? [] : deterministicFindings(run, steps);
  run.finding_count = run.findings.length;
  await sleep(500);
  if (fail('deterministic_qc')) return;
  setPhase(run, 'gemini_semantic_review', isRecheck ? 'Reviewing the corrected cue-231 pair' : 'Reviewing 1 narrowed source/target pair');
  const candidates = plan[5].rows();
  run.semantic_candidates = candidates.length;
  await sleep(1100);
  if (fail('gemini_semantic_review')) return;
  const input = { cue_id: 231, locale: 'es', source_language: 'en', source_text: 'Do not send it yet.', target_text: isRecheck ? 'No lo envíes todavía.' : 'Envialo ahora.', previous_source_text: 'Send it now.', source_revision: 'r3', target_version: run.version };
  run.semantic_review = semanticReview(input, isRecheck);
  if (!isRecheck) run.findings.push(semanticFinding(run, run.semantic_review, steps));
  run.finding_count = run.findings.length;
  await sleep(400);
  if (fail('producer_decision')) return;
  setPhase(run, 'producer_decision', null);
  run.blocker_count = run.findings.filter((f) => f.is_blocker).length;
  run.release_state = run.blocker_count > 0 ? 'HELD' : 'READY';
  await sleep(350);
  const now = Date.now();
  setPhase(run, 'complete');
  run.ended_at = iso(now);
  run.duration_ms = now - Date.parse(run.started_at);
  store.events.push({ event_id: newId('evt'), title_id: TITLE_ID, locale: 'es', event_type: 'release_gate_run', source_revision: 'r3', target_version: run.version, occurred_at: iso(now), summary: `Release gate ${run.release_state} - ${run.blocker_count} blockers`, actor: 'LocaleLock Live', run_id: run.run_id });
}

const tc = (n) => { const h = Math.floor(n / 3600000), m = Math.floor((n % 3600000) / 60000), s = Math.floor((n % 60000) / 1000), mm = n % 1000; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(mm).padStart(3, '0')}`; };
function srtFor(run) {
  const cues = run.findings.filter((f) => f.proposed_repair).map((f) => ({ cue_id: f.cue_id, ...f.proposed_repair.after })).sort((a, b) => a.start_ms - b.start_ms);
  return cues.map((c, i) => `${i + 1}\n${tc(c.start_ms)} --> ${tc(c.end_ms)}\n${c.text}\n`).join('\n') + (cues.length ? '' : '\n');
}

function approve(run, body) {
  if (run.phase !== 'complete') return [409, { error: { code: 'RUN_NOT_COMPLETE', message: 'The run has not completed yet.' } }];
  if (run.approval) return [200, { approval: run.approval, run, idempotent: true }];
  if (run.release_state !== 'HELD') return [409, { error: { code: 'RUN_NOT_HELD', message: `Run is ${run.release_state}, not HELD.` } }];
  const decisions = Array.isArray(body?.decisions) ? body.decisions : [];
  const open = run.findings.filter((f) => f.status === 'open');
  const missing = open.filter((f) => !decisions.find((d) => d.finding_id === f.finding_id));
  if (missing.length) return [400, { error: { code: 'DECISIONS_INCOMPLETE', message: `Missing decisions for ${missing.length} finding(s).`, details: { missing: missing.map((f) => f.finding_id) } } }];
  const rejected = decisions.filter((d) => d.decision === 'reject');
  if (rejected.length) {
    rejected.forEach((d) => { const f = run.findings.find((x) => x.finding_id === d.finding_id); if (f) f.status = 'rejected'; });
    return [409, { error: { code: 'REJECTED', message: `${rejected.length} repair(s) rejected; release stays HELD.` } }];
  }
  const srt = srtFor(run);
  const bytes = Buffer.byteLength(srt, 'utf8');
  const hash = crypto.createHash('sha256').update(srt).digest('hex');
  const now = iso(Date.now());
  run.findings.forEach((f) => { f.status = 'approved'; });
  const eventId = newId('evt');
  run.approval = {
    approval_batch_id: newId('appr'), run_id: run.run_id, reviewer: body?.reviewer || 'Producer', approved_at: now,
    decisions: open.map((f) => ({ finding_id: f.finding_id, cue_id: f.cue_id, rule_id: f.rule_id, decision: 'approve' })),
    approved_version: run.version + 1, patch_hash: hash,
    srt: { filename: `the-last-tram.es.v${run.version + 1}.approved.srt`, bytes, sha256: hash, cue_count: 240, url: `/runs/${run.run_id}/export.srt` },
    ingested: { subtitle_cues: 240, source_target_pairs: 240, localization_events: 1 }, event_id: eventId,
  };
  store.events.push({ event_id: eventId, title_id: TITLE_ID, locale: 'es', event_type: 'approved_version_ingested', source_revision: 'r3', target_version: run.version + 1, occurred_at: now, summary: `Approved v${run.version + 1} ingested - patch ${hash.slice(0, 12)}`, actor: run.approval.reviewer, run_id: run.run_id });
  return [200, { approval: run.approval, run, idempotent: false }];
}

function recheck(run) {
  if (!run.approval) return [409, { error: { code: 'NOT_APPROVED', message: 'This run has no approval yet.' } }];
  if (run.recheck_run_id) {
    const existing = store.runs.get(run.recheck_run_id);
    if (existing && existing.release_state !== 'FAILED') return [200, { run_id: existing.run_id, parent_run_id: run.run_id, status: 'existing', poll_url: `/runs/${existing.run_id}` }];
  }
  const rc = createRun({ version: run.approval.approved_version, trigger: 'recheck_after_approval', parent_run_id: run.run_id });
  run.recheck_run_id = rc.run_id;
  return [202, { run_id: rc.run_id, parent_run_id: run.run_id, status: 'queued', poll_url: `/runs/${rc.run_id}` }];
}

function send(res, status, body, headers = {}) {
  const isText = typeof body === 'string';
  res.writeHead(status, {
    'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type,x-demo-key',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isText ? body : JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    let path = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') return send(res, 204, '');
    console.log(`${new Date().toISOString()} ${method} ${path}`);

    if (method === 'GET' && path === '/health') return send(res, 200, health(url.searchParams.get('deep') === '1'));
    if (method === 'GET' && path === '/demo/state') return send(res, 200, demoState());
    if (method === 'GET' && path === '/judge/status') {
      const port = PORT;
      return send(res, 200, { health: health(false), state: demoState(), links: { app: 'http://localhost:4173/', judge: 'http://localhost:4173/judge', repo: REPO_URL, api: `http://127.0.0.1:${port}` }, architecture: [], test_steps: [] });
    }
    if (method === 'GET' && path === '/runs') {
      const runs = [...store.runs.values()].map((r) => ({ ...r, trace: [], findings: [] }));
      return send(res, 200, { runs });
    }
    if (method === 'POST' && path === '/runs') {
      const body = await readJson(req);
      if (body === null) return send(res, 400, { error: { code: 'BAD_REQUEST', message: 'Body must be JSON.' } });
      const running = [...store.runs.values()].find((r) => r.release_state === 'RUNNING' && Date.now() - Date.parse(r.started_at) < 180_000);
      if (running) return send(res, 200, { run_id: running.run_id, status: 'queued', poll_url: `/runs/${running.run_id}` });
      const run = createRun({ version: 7, trigger: body.trigger || 'vendor_delivery', parent_run_id: null });
      return send(res, 202, { run_id: run.run_id, status: 'queued', poll_url: `/runs/${run.run_id}` });
    }
    const m = path.match(/^\/runs\/([^/]+)(?:\/(approvals|export\.srt|recheck))?$/);
    if (m) {
      const run = store.runs.get(decodeURIComponent(m[1]));
      if (!run) return send(res, 404, { error: { code: 'NOT_FOUND', message: `Run ${m[1]} not found.` } });
      const sub = m[2];
      if (!sub && method === 'GET') return send(res, 200, run);
      if (sub === 'approvals' && method === 'POST') {
        const body = await readJson(req);
        if (body === null) return send(res, 400, { error: { code: 'BAD_REQUEST', message: 'Body must be JSON.' } });
        const [status, payload] = approve(run, body);
        return send(res, status, payload);
      }
      if (sub === 'recheck' && method === 'POST') {
        const [status, payload] = recheck(run);
        return send(res, status, payload);
      }
      if (sub === 'export.srt' && method === 'GET') {
        if (!run.approval) return send(res, 409, { error: { code: 'NOT_APPROVED', message: 'No approved version to export.' } });
        return send(res, 200, srtFor(run), { 'Content-Disposition': `attachment; filename="${run.approval.srt.filename}"` });
      }
    }
    if (method === 'POST' && path === '/admin/reset') {
      if (RESET_KEY && req.headers['x-demo-key'] !== RESET_KEY) return send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'X-Demo-Key required for reset.' } });
      if (Date.now() - store.lastResetAt < 15_000) return send(res, 429, { error: { code: 'RATE_LIMITED', message: 'Reset cooldown: wait 15 s between resets.' } });
      const removed = { release_runs: store.runs.size - 1, qc_findings: [...store.runs.values()].filter((r) => r.run_id !== 'run_baseline_v7').reduce((n, r) => n + r.findings.length, 0), approvals: [...store.runs.values()].filter((r) => r.approval).length };
      store.lastResetAt = Date.now();
      resetStore();
      return send(res, 200, { ok: true, removed, state: demoState() });
    }
    if (method === 'POST' && path === '/admin/seed') return send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Seeding is not available on the mock server.' } });
    return send(res, 404, { error: { code: 'NOT_FOUND', message: `No route for ${method} ${path}` } });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`LocaleLock Live MOCK API (dev-only, no real data) listening on http://127.0.0.1:${PORT}`);
  console.log(`  reset key: ${RESET_KEY ? 'required' : 'not required'} · fail phase: ${FAIL_PHASE ?? 'none'} · speed x${SPEED}`);
});
