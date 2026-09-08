import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanOverlaps, scanReadingSpeed, scanGlossaryDrift, countChars, computeCps, levenshtein, findClosestTerm,
  repairReadingSpeedEnd, buildOverlapFinding, buildReadingSpeedFinding, buildGlossaryFinding, buildSemanticFinding,
  semanticIsBlocker, applyRepairs, deterministicViolations,
} from '../src/domain/rules.js';
import type { SemanticReview } from '../src/domain/constants.js';

const ctx = { run_id: 'run_t', title_id: 'tt', locale: 'es', version: 7, created_at: '2026-01-01T00:00:00.000Z' };

test('overlap scan finds consecutive overlaps sorted desc and proposes an 80 ms gap', () => {
  const cues = [
    { cue_id: 1, start_ms: 0, end_ms: 1000, text: 'a' },
    { cue_id: 2, start_ms: 1500, end_ms: 2600, text: 'b' },
    { cue_id: 3, start_ms: 2500, end_ms: 3000, text: 'c' },
    { cue_id: 4, start_ms: 3400, end_ms: 4000, text: 'd' },
    { cue_id: 5, start_ms: 3980, end_ms: 4400, text: 'e' },
  ];
  const rows = scanOverlaps(cues);
  assert.deepEqual(rows.map((r) => [r.cue_id, r.next_cue_id, r.overlap_ms]), [[2, 3, 100], [4, 5, 20]]);
  const f = buildOverlapFinding(rows[0], cues[1], ctx);
  assert.equal(f.headline, 'Cue 2 overlaps cue 3 by 100 ms');
  assert.equal(f.proposed_repair!.kind, 'trim_out_time');
  assert.equal(f.proposed_repair!.after.end_ms, 2420);
  assert.equal(f.is_blocker, true);
  assert.equal(f.priority, 1);
});

test('cps counts code points without newlines; 59 chars over 2.4 s = 24.6', () => {
  const text = 'Si el último tranvía se va sin nosotros, nadie sabrá dónde.';
  assert.equal(countChars(text), 59);
  assert.equal(countChars('ab\ncd'), 4);
  assert.equal(computeCps(text, 2400), 24.6);
  const rows = scanReadingSpeed([{ cue_id: 204, start_ms: 611_200, end_ms: 613_600, text }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cps, 24.6);
  assert.equal(rows[0].chars, 59);
  assert.deepEqual(repairReadingSpeedEnd(611_200, 59, 615_000), { end_ms: 614_200, fits: true });
  assert.deepEqual(repairReadingSpeedEnd(611_200, 59, 613_900), { end_ms: 613_820, fits: false });
  const f = buildReadingSpeedFinding(rows[0], { cue_id: 204, start_ms: 611_200, end_ms: 613_600, text }, 615_000, ctx);
  assert.equal(f.headline, 'Cue 204 reads at 24.6 CPS, above the 20 CPS limit');
  assert.equal(f.proposed_repair!.after.end_ms, 614_200);
  assert.equal(f.proposed_repair!.verification.cps, 19.7);
  assert.equal(scanReadingSpeed([{ cue_id: 1, start_ms: 0, end_ms: 1000, text: 'exactly twenty chars' }]).length, 0);
});

test('levenshtein + n-gram search finds "Maria Voss" for "Mara Voss"', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('', 'abc'), 3);
  assert.deepEqual(findClosestTerm('Maria Voss firmó el manifiesto ella misma.', 'Mara Voss'), { found_term: 'Maria Voss', edit_distance: 1 });
  assert.deepEqual(findClosestTerm('Vamos a la cochera, dijo.', 'la cochera'), { found_term: 'la cochera', edit_distance: 0 });
  assert.equal(findClosestTerm('Está en el deposito ahora.', 'la cochera').edit_distance > 0, true);
});

test('glossary drift scan mirrors Q5 and builds the replace_text repair', () => {
  const glossary = [{ source_term: 'Mara Voss', approved_target_term: 'Mara Voss' }, { source_term: 'the depot', approved_target_term: 'la cochera' }];
  const pairs = [
    { cue_id: 57, source_text: 'Mara Voss signed the manifest herself.', target_text: 'Maria Voss firmó el manifiesto ella misma.' },
    { cue_id: 20, source_text: 'Mara, the depot called again.', target_text: 'Mara, la cochera llamó otra vez.' },
    { cue_id: 3, source_text: 'Nothing here.', target_text: 'Nada aquí.' },
  ];
  const rows = scanGlossaryDrift(pairs, glossary);
  assert.deepEqual(rows.map((r) => r.cue_id), [57]);
  const f = buildGlossaryFinding(rows[0], glossary[0], { cue_id: 57, start_ms: 171_000, end_ms: 173_800, text: pairs[0].target_text }, ctx);
  assert.equal(f.headline, 'Glossary says "Mara Voss", delivery says "Maria Voss"');
  assert.equal(f.proposed_repair!.after.text, 'Mara Voss firmó el manifiesto ella misma.');
  assert.equal((f.evidence as { edit_distance: number }).edit_distance, 1);
  assert.equal(scanGlossaryDrift(pairs, []).length, 0);
});

function review(verdict: SemanticReview['output']['verdict'], severity: 'low' | 'medium' | 'high', suggestion: string | null): SemanticReview {
  return {
    framework: 'google-adk', agent_name: 'semantic_reviewer', model: 'm', backend: 'vertex-ai',
    input: { cue_id: 231, locale: 'es', source_language: 'en', source_text: 'Do not send it yet.', target_text: 'Envialo ahora.', previous_source_text: 'Send it now.', source_revision: 'r3', target_version: 7 },
    output: { verdict, severity, confidence: 0.97, explanation: 'x', suggested_target_text: suggestion },
    raw_text: null, started_at: ctx.created_at, latency_ms: 10,
  };
}
const candidate = { cue_id: 231, source_text: 'Do not send it yet.', target_text: 'Envialo ahora.', previous_source_text: 'Send it now.', source_revision: 'r3', target_version: 7 };
const cue231 = { cue_id: 231, start_ms: 700_400, end_ms: 702_600, text: 'Envialo ahora.' };

test('semantic finding: reversal is a blocker with the Gemini suggestion; null suggestion falls back; preserved → no finding', () => {
  const f = buildSemanticFinding(candidate, cue231, review('MEANING_REVERSED', 'high', 'No lo envíes aún.'), 'r3', ctx)!;
  assert.equal(f.is_blocker, true);
  assert.equal(f.severity, 'high');
  assert.equal(f.priority, 4);
  assert.equal(f.headline, 'Source says "Do not send it yet.", subtitle says "Envialo ahora." - meaning reversed');
  assert.equal(f.proposed_repair!.origin, 'gemini_suggestion');
  assert.equal(f.proposed_repair!.after.text, 'No lo envíes aún.');
  const fb = buildSemanticFinding(candidate, cue231, review('MEANING_REVERSED', 'high', null), 'r3', ctx)!;
  assert.equal(fb.proposed_repair!.origin, 'deterministic');
  assert.equal(fb.proposed_repair!.after.text, 'No lo envíes todavía.');
  assert.equal(buildSemanticFinding(candidate, cue231, review('MEANING_PRESERVED', 'low', null), 'r3', ctx), null);
  assert.equal(semanticIsBlocker({ verdict: 'MEANING_SHIFTED', severity: 'high', confidence: 1, explanation: '', suggested_target_text: null }), true);
  assert.equal(semanticIsBlocker({ verdict: 'MEANING_SHIFTED', severity: 'medium', confidence: 1, explanation: '', suggested_target_text: null }), false);
  const shifted = buildSemanticFinding(candidate, cue231, review('MEANING_SHIFTED', 'medium', 'Mándalo luego.'), 'r3', ctx)!;
  assert.equal(shifted.is_blocker, false);
  assert.equal(shifted.severity, 'medium');
});

test('applyRepairs + deterministicViolations round-trip', () => {
  const cues = [
    { cue_id: 1, start_ms: 0, end_ms: 1100, text: 'hola' },
    { cue_id: 2, start_ms: 1000, end_ms: 2000, text: 'mundo' },
  ];
  assert.equal(deterministicViolations(cues, [], []).length, 1);
  const f = buildOverlapFinding(scanOverlaps(cues)[0], cues[0], ctx);
  const repaired = applyRepairs(cues, [f]);
  assert.equal(repaired[0].end_ms, 920);
  assert.deepEqual(deterministicViolations(repaired, [], []), []);
  assert.equal(cues[0].end_ms, 1100, 'input not mutated');
});
