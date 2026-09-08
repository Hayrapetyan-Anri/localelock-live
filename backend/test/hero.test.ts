import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  heroCuesForVersion, heroPairsForVersion, heroGlossary, heroEvents, baselineRun, HERO_CUE_COUNT, heroSourceText,
} from '../src/domain/hero.js';
import {
  localRows, evaluateDeterministicFindings, deterministicViolations, glossaryViolationsCaseInsensitive, minGapViolations,
  applyRepairs, applyRepairsToPairs, countChars, computeCps,
} from '../src/domain/rules.js';
import { HERO_VERSION, CPS_LIMIT, MIN_CUE_GAP_MS } from '../src/domain/constants.js';

const cues = heroCuesForVersion(HERO_VERSION);
const pairs = heroPairsForVersion(HERO_VERSION);
const glossary = heroGlossary();
const byId = new Map(cues.map((c) => [c.cue_id, c]));

test('hero v7 has 240 cues, monotonic timeline within 0..720000 ms', () => {
  assert.equal(cues.length, HERO_CUE_COUNT);
  const sorted = [...cues].sort((a, b) => a.cue_id - b.cue_id);
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    assert.equal(c.cue_id, i + 1);
    assert.ok(c.start_ms >= 0 && c.end_ms <= 720_000, `cue ${c.cue_id} out of timeline`);
    assert.ok(c.end_ms > c.start_ms, `cue ${c.cue_id} has non-positive duration`);
    if (i > 0) assert.ok(c.start_ms > sorted[i - 1].start_ms, `cue ${c.cue_id} not monotonic`);
  }
  const gaps = minGapViolations(cues);
  assert.deepEqual(gaps.map((g) => g.cue_id), [118]);
});

test('hero anchors have the exact values from SPEC §4', () => {
  assert.deepEqual([byId.get(57)!.start_ms, byId.get(57)!.end_ms], [171_000, 173_800]);
  assert.equal(byId.get(57)!.text, 'Maria Voss firmó el manifiesto ella misma.');
  assert.ok(byId.get(117)!.end_ms <= 348_920);
  assert.deepEqual([byId.get(118)!.start_ms, byId.get(118)!.end_ms], [349_000, 352_420]);
  assert.equal(byId.get(118)!.text, '¿Y si el tranvía no vuelve?');
  assert.deepEqual([byId.get(119)!.start_ms, byId.get(119)!.end_ms], [352_000, 354_600]);
  assert.equal(byId.get(119)!.text, 'Siempre vuelve. Esta noche también.');
  assert.deepEqual([byId.get(204)!.start_ms, byId.get(204)!.end_ms], [611_200, 613_600]);
  assert.equal(byId.get(204)!.text.normalize('NFC'), 'Si el último tranvía se va sin nosotros, nadie sabrá dónde.');
  assert.equal(countChars(byId.get(204)!.text), 59);
  assert.equal(computeCps(byId.get(204)!.text, 2400), 24.6);
  assert.ok(byId.get(205)!.start_ms >= 615_000);
  assert.deepEqual([byId.get(231)!.start_ms, byId.get(231)!.end_ms], [700_400, 702_600]);
  assert.equal(byId.get(231)!.text, 'Envialo ahora.');
  const p231 = pairs.find((p) => p.cue_id === 231)!;
  assert.equal(p231.source_text, 'Do not send it yet.');
  assert.equal(p231.previous_source_text, 'Send it now.');
  assert.equal(p231.source_revision, 'r3');
  assert.equal(heroSourceText(231, 'r2'), 'Send it now.');
  assert.equal(pairs.filter((p) => p.source_revision === 'r3').length, 1);
});

test('hero v7 yields exactly the four hero findings with exact values', () => {
  const ctx = { run_id: 'run_test', title_id: 'tt_last_tram', locale: 'es', version: 7, created_at: new Date(0).toISOString() };
  const findings = evaluateDeterministicFindings(localRows(cues, pairs, glossary), cues, ctx);
  assert.equal(findings.length, 3);
  const [ov, cps, gl] = findings;
  assert.equal(ov.rule_id, 'TIMING_OVERLAP');
  assert.equal(ov.headline, 'Cue 118 overlaps cue 119 by 420 ms');
  assert.equal(ov.proposed_repair!.after.end_ms, 351_920);
  assert.equal(ov.proposed_repair!.verification.overlap_ms, -80);
  assert.equal(cps.rule_id, 'READING_SPEED');
  assert.equal(cps.headline, 'Cue 204 reads at 24.6 CPS, above the 20 CPS limit');
  assert.equal(cps.proposed_repair!.after.end_ms, 614_200);
  assert.equal(cps.proposed_repair!.verification.cps, 19.7);
  assert.equal(gl.rule_id, 'GLOSSARY_DRIFT');
  assert.equal(gl.headline, 'Glossary says "Mara Voss", delivery says "Maria Voss"');
  assert.equal((gl.evidence as { edit_distance: number }).edit_distance, 1);
  assert.equal(gl.proposed_repair!.after.text, 'Mara Voss firmó el manifiesto ella misma.');

  const semanticCandidates = pairs.filter((p) => p.source_revision === 'r3');
  assert.equal(semanticCandidates.length, 1);
  assert.equal(semanticCandidates[0].cue_id, 231);

  const base = baselineRun(new Date('2026-09-07T00:00:00Z'), { model: 'gemini-2.5-flash', backend: 'vertex-ai', synthetic_rows_total: 1 });
  assert.equal(base.run.release_state, 'HELD');
  assert.equal(base.run.blocker_count, 4);
  assert.equal(base.findings.length, 4);
  assert.deepEqual(base.findings.map((f) => [f.priority, f.cue_id]), [[1, 118], [2, 204], [3, 57], [4, 231]]);
  const sem = base.findings[3];
  assert.equal(sem.source, 'deterministic_query');
  assert.equal(sem.headline, 'Cue 231 changed in source r3 after translation - semantic review required');
  assert.equal((sem.evidence as { review: { output: { explanation: string; confidence: number; verdict: string } } }).review.output.explanation, 'Pending live Gemini review');
  assert.equal(base.run.trace.length, 0);
  assert.equal(base.run.agent, null);
});

test('every other glossary term is consistent (case-sensitive and case-insensitive)', () => {
  const cs = deterministicViolations(cues, pairs, glossary).filter((v) => v.rule === 'GLOSSARY_DRIFT');
  assert.deepEqual(cs.map((v) => v.cue_id), [57]);
  const ci = glossaryViolationsCaseInsensitive(pairs, glossary);
  assert.deepEqual(ci.map((v) => v.cue_id), [57]);
  for (const c of cues) assert.ok(computeCps(c.text, c.end_ms - c.start_ms) <= CPS_LIMIT || c.cue_id === 204, `cue ${c.cue_id} too fast`);
});

test('the repaired set has zero deterministic violations and v8 = v7 + repairs', () => {
  const base = baselineRun(new Date(), { model: 'm', backend: 'vertex-ai', synthetic_rows_total: 0 });
  const repaired = applyRepairs(cues, base.findings.map((f) => ({ proposed_repair: f.proposed_repair })));
  const semFallback = base.findings[3];
  assert.equal(semFallback.proposed_repair, null);
  const withSem = repaired.map((c) => (c.cue_id === 231 ? { ...c, text: 'No lo envíes todavía.' } : c));
  const newPairs = applyRepairsToPairs(pairs, withSem);
  assert.deepEqual(deterministicViolations(withSem, newPairs, glossary), []);
  assert.deepEqual(minGapViolations(withSem), []);
  const changed = withSem.filter((c) => {
    const o = byId.get(c.cue_id)!;
    return o.start_ms !== c.start_ms || o.end_ms !== c.end_ms || o.text !== c.text;
  });
  assert.deepEqual(changed.map((c) => c.cue_id), [57, 118, 204, 231]);
  assert.ok(withSem.every((c, i) => i === 0 || withSem[i - 1].start_ms + MIN_CUE_GAP_MS <= c.start_ms));
});

test('earlier versions exist and legacy versions carry extra issues', () => {
  for (let v = 1; v <= 6; v++) {
    const vc = heroCuesForVersion(v);
    assert.equal(vc.length, 240);
    assert.equal(heroPairsForVersion(v).length, 240);
    const viol = deterministicViolations(vc, heroPairsForVersion(v), glossary);
    assert.ok(viol.length >= 3, `v${v} should still contain hero issues`);
  }
  assert.ok(deterministicViolations(heroCuesForVersion(1), heroPairsForVersion(1), glossary).length > 3);
});

test('hero events are relative to T0 and include the r3 revision and v7 delivery', () => {
  const T0 = new Date('2026-09-07T12:00:00Z');
  const ev = heroEvents(T0);
  const v7 = ev.find((e) => e.event_type === 'vendor_delivery' && e.target_version === 7)!;
  assert.equal(new Date(v7.occurred_at).getTime(), T0.getTime() - (2 * 3_600_000 + 5 * 60_000));
  const r3 = ev.find((e) => e.event_type === 'source_revision' && e.source_revision === 'r3')!;
  assert.equal(r3.summary, 'Line 231 changed: "Send it now." → "Do not send it yet."');
  assert.equal(new Date(r3.occurred_at).getTime(), T0.getTime() - (3 * 3_600_000 + 10 * 60_000));
  assert.equal(ev.filter((e) => e.event_type === 'vendor_delivery').length, 7);
  assert.ok(ev.find((e) => e.event_type === 'release_scheduled')!.summary.includes(new Date(T0.getTime() + 7_200_000).toISOString()));
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i - 1].occurred_at <= ev[i].occurred_at);
});
