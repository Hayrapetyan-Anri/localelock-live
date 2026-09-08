import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInstruction,
  buildQueryPlan,
  canonicalize,
  matchTraceEntry,
  mcpArgsFor,
  missingQueries,
  normalizeSql,
  type QueryPlan,
} from '../src/domain/queries.js';
import { HERO_LOCALE, HERO_VERSION, LATEST_SOURCE_REVISION, QUERY_ORDER, TITLE_ID } from '../src/domain/constants.js';

const DB = 'localelock';

function plan(): QueryPlan {
  return buildQueryPlan({
    title_id: TITLE_ID,
    locale: HERO_LOCALE,
    version: HERO_VERSION,
    source_revision: LATEST_SOURCE_REVISION,
    database: DB,
  });
}

test('plan has the six entries with the official mcp-clickhouse tools', () => {
  const p = plan();
  assert.equal(p.length, 6);
  assert.deepEqual(
    p.map((e) => e.query_id),
    QUERY_ORDER,
  );
  assert.deepEqual(
    p.map((e) => e.tool),
    ['list_tables', 'run_query', 'run_query', 'run_query', 'run_query', 'run_query'],
  );
  assert.deepEqual(p[0].args, { database: DB });
  for (const entry of p.slice(1)) {
    assert.deepEqual(Object.keys(entry.args), ['query']);
    assert.equal(typeof entry.args.query, 'string');
    assert.ok((entry.args.query as string).startsWith('SELECT '), `${entry.label} must be a SELECT`);
    assert.ok((entry.args.query as string).includes(`${DB}.`), `${entry.label} must be database-qualified`);
  }
});

test('the SQL encodes the deterministic rules', () => {
  const p = plan();
  const sql = Object.fromEntries(p.map((e) => [e.query_id, String(e.args.query ?? '')]));
  assert.match(sql.Q2_TIMING_OVERLAP, /leadInFrame\(start_ms\) OVER w/);
  assert.match(sql.Q2_TIMING_OVERLAP, /end_ms > next_start_ms/);
  assert.match(sql.Q3_READING_SPEED, /lengthUTF8\(replaceAll\(text, '\\n', ''\)\) AS chars/);
  assert.match(sql.Q3_READING_SPEED, /cps > 20/);
  assert.match(sql.Q5_GLOSSARY_DRIFT, /INNER JOIN localelock\.glossary_terms/);
  assert.match(sql.Q5_GLOSSARY_DRIFT, /position\(p\.target_text, g\.approved_target_term\) = 0/);
  assert.match(sql.Q6_SEMANTIC_CANDIDATES, /source_revision = 'r3'/);
});

test('literals are quoted, so a hostile title id cannot break out of the SQL', () => {
  const hostile = "tt'; DROP TABLE subtitle_cues; --";
  const p = buildQueryPlan({
    title_id: hostile,
    locale: HERO_LOCALE,
    version: HERO_VERSION,
    source_revision: LATEST_SOURCE_REVISION,
    database: DB,
  });
  const sql = String(p[1].args.query);
  assert.match(sql, /title_id = 'tt\\'; DROP TABLE subtitle_cues; --'/);
  assert.ok(!sql.replace(/\\'/g, '').includes("'; DROP"), 'the payload must stay inside the quoted literal');
});

test('normalizeSql collapses formatting so the matcher is stable', () => {
  assert.equal(normalizeSql('  SELECT   a,\n   b  FROM t ;  '), 'SELECT a, b FROM t');
  const p = plan();
  const reformatted = String(p[2].args.query).replace(/ /g, '\n  ');
  assert.equal(canonicalize('run_query', { query: reformatted }), canonicalize('run_query', p[2].args));
});

test('exact match wins; an altered query is labelled as an agent variant', () => {
  const p = plan();
  const exact = matchTraceEntry(p, 'run_query', mcpArgsFor(p[1]));
  assert.equal(exact.query_id, 'Q2_TIMING_OVERLAP');
  assert.equal(exact.matched_expected, true);

  const altered = matchTraceEntry(p, 'run_query', { query: `${String(p[1].args.query)} LIMIT 5` });
  assert.equal(altered.query_id, 'Q2_TIMING_OVERLAP');
  assert.equal(altered.matched_expected, false, 'a changed query must not count as the planned one');

  const unrelated = matchTraceEntry(p, 'list_databases', {});
  assert.equal(unrelated.query_id, null);
  assert.equal(unrelated.matched_expected, false);
});

test('missingQueries lists unmatched plan entries in Q order; the instruction embeds the plan verbatim', () => {
  const p = plan();
  assert.deepEqual(
    missingQueries(p, ['Q1_LIST_TABLES', 'Q2_TIMING_OVERLAP']).map((e) => e.query_id),
    ['Q3_READING_SPEED', 'Q4_GLOSSARY_TERMS', 'Q5_GLOSSARY_DRIFT', 'Q6_SEMANTIC_CANDIDATES'],
  );
  assert.equal(missingQueries(p, QUERY_ORDER).length, 0);

  const instruction = buildInstruction(p, DB);
  for (const entry of p) {
    assert.ok(instruction.includes(JSON.stringify(entry.args)), `${entry.label} must appear verbatim in the instruction`);
  }
  assert.match(instruction, /mcp-clickhouse/);
  assert.match(instruction, /Query plan complete: Q1-Q6 executed\./);
});
