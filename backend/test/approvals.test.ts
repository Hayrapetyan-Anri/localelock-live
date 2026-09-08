import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heroCuesForVersion, heroPairsForVersion, heroGlossary, baselineRun } from '../src/domain/hero.js';
import { applyRepairs, applyRepairsToPairs, deterministicViolations, buildSemanticFinding, minGapViolations } from '../src/domain/rules.js';
import { buildSrt } from '../src/domain/srt.js';
import type { SemanticReview } from '../src/domain/constants.js';

test('approval math: v8 = v7 + the four repairs, clean, deterministic SRT hash', () => {
  const v7 = heroCuesForVersion(7);
  const pairs7 = heroPairsForVersion(7);
  const glossary = heroGlossary();
  const base = baselineRun(new Date(), { model: 'm', backend: 'vertex-ai', synthetic_rows_total: 0 });
  const deterministic = base.findings.filter((f) => f.rule_id !== 'SEMANTIC_REVERSAL');
  const review: SemanticReview = {
    framework: 'google-adk', agent_name: 'semantic_reviewer', model: 'm', backend: 'vertex-ai',
    input: { cue_id: 231, locale: 'es', source_language: 'en', source_text: 'Do not send it yet.', target_text: 'Envialo ahora.', previous_source_text: 'Send it now.', source_revision: 'r3', target_version: 7 },
    output: { verdict: 'MEANING_REVERSED', severity: 'high', confidence: 0.98, explanation: 'Polarity reversed', suggested_target_text: 'No lo envíes todavía.' },
    raw_text: null, started_at: new Date().toISOString(), latency_ms: 1,
  };
  const cue231 = v7.find((c) => c.cue_id === 231)!;
  const p231 = pairs7.find((p) => p.cue_id === 231)!;
  const semantic = buildSemanticFinding({ cue_id: 231, source_text: p231.source_text, target_text: p231.target_text, previous_source_text: p231.previous_source_text, source_revision: 'r3', target_version: 7 }, cue231, review, 'r3', { run_id: 'run_x', title_id: 'tt_last_tram', locale: 'es', version: 7, created_at: new Date().toISOString() })!;
  const all = [...deterministic, semantic];
  assert.equal(all.length, 4);

  const v8 = applyRepairs(v7, all).map((c) => ({ ...c, version: 8, source_revision: 'r3' }));
  const pairs8 = applyRepairsToPairs(pairs7, v8).map((p) => ({ ...p, target_version: 8 }));
  assert.equal(v8.length, 240);
  assert.deepEqual(deterministicViolations(v8, pairs8, glossary), []);
  assert.deepEqual(minGapViolations(v8), []);
  const by = new Map(v8.map((c) => [c.cue_id, c]));
  assert.equal(by.get(118)!.end_ms, 351_920);
  assert.equal(by.get(204)!.end_ms, 614_200);
  assert.equal(by.get(57)!.text, 'Mara Voss firmó el manifiesto ella misma.');
  assert.equal(by.get(231)!.text, 'No lo envíes todavía.');
  assert.equal(pairs8.find((p) => p.cue_id === 231)!.target_text, 'No lo envíes todavía.');
  assert.equal(pairs8.find((p) => p.cue_id === 231)!.source_revision, 'r3');
  assert.equal(pairs8.filter((p) => p.source_revision === 'r3').length, 1);
  const changed = v8.filter((c) => {
    const o = v7.find((x) => x.cue_id === c.cue_id)!;
    return o.start_ms !== c.start_ms || o.end_ms !== c.end_ms || o.text !== c.text;
  });
  assert.deepEqual(changed.map((c) => c.cue_id), [57, 118, 204, 231]);

  const a = buildSrt(v8, 'The Last Tram', 'es', 8);
  const b = buildSrt([...v8].reverse(), 'The Last Tram', 'es', 8);
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.cue_count, 240);
  assert.equal(a.filename, 'the-last-tram.es.v8.approved.srt');
  assert.ok(a.text.includes('00:05:49,000 --> 00:05:51,920\n¿Y si el tranvía no vuelve?'));
  assert.ok(a.text.endsWith('\n') && !a.text.endsWith('\n\n\n'));
});
