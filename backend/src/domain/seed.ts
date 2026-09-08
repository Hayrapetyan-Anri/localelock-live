import {
  BASELINE_RUN_ID,
  COLLECTION_NAMES,
  HERO_LOCALE,
  HERO_VERSION,
  INSERT_BATCH_SIZE,
  PRNG_SEED,
  RESET_COOLDOWN_MS,
  RULE_PRIORITY,
  SEED_VERSION,
  SYNTHETIC_DISCLAIMER,
  SYNTHETIC_ROW_COLLECTIONS,
  TITLE_ID,
  type DatasetStats,
  type Finding,
  type GlossaryTerm,
  type LocalizationEvent,
  type ReleaseRun,
  type RuleId,
  type SourceTargetPair,
  type SubtitleCue,
} from './constants.js';
import { baselineRun, heroCuesForVersion, heroEvents, heroGlossary, heroPairsForVersion, heroReleaseAt } from './hero.js';
import { withEvidenceJson } from './rules.js';
import {
  TABLE_NAMES,
  countWhere,
  deleteWhere,
  ensureSchema,
  insertRows,
  query,
  queryOne,
  tableCounts,
  truncateAll,
  type TableName,
} from '../db/clickhouse.js';
import {
  eventToRow,
  findingToRow,
  metaToRow,
  rowToMeta,
  runToRow,
  type DemoMetaDoc,
  type RunDoc,
} from '../db/rows.js';
import { getConfig } from '../config.js';
import { seededEventId, seededFindingId, seededRunId } from '../db/ids.js';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(min: number, maxInclusive: number): number {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

export const SYNTHETIC_TITLE_COUNT = 44;
export const SYNTHETIC_LOCALES = ['fr', 'de', 'pt-BR'] as const;
export const SYNTHETIC_VERSIONS = 4;
export const SYNTHETIC_CUES_PER_VERSION = 180;

const TITLE_NAMES = [
  'Harbor Lights', 'Quiet Orbit', 'Paper Lanterns', 'The Salt Road', 'Winter Kitchen', 'Glass Meridian', 'Copper Weather',
  'Blue Interval', 'The Cartographer', 'Small Hours', 'North of Nothing', 'A Borrowed Coast', 'Static Gardens', 'The Ferry Clerk',
  'Long Exposure', 'Tin Sky', 'Distant Signal', 'Late Harvest', 'The Empty Chair', 'Lantern Hill', 'Slow Water', 'Radio Silence',
  'Fieldnotes', 'The Night Baker', 'Second Skin', 'Low Tide Ballad', 'Clockwork Orchard', 'The Last Ferry', 'Hollow Moon',
  'Concrete Choir', 'Amber Frequency', 'The Understudy', 'Half Light', 'Iron Lullaby', 'Salt and Static', 'Pale Harbor',
  'The Lighthouse Keeper', 'Wintering', 'Unsent Letters', 'Fog Bank', 'Quiet Engines', 'The Signal Room', 'Shorelines', 'Little Empire',
];

const EN_WORDS = ['the', 'we', 'you', 'they', 'wait', 'listen', 'tonight', 'tomorrow', 'harbor', 'signal', 'light', 'road', 'again', 'never', 'always', 'home', 'door', 'quiet', 'engine', 'letter', 'promise', 'morning', 'north', 'water', 'answer', 'call', 'stay', 'leave', 'remember', 'forget'];
const LOCALE_WORDS: Record<(typeof SYNTHETIC_LOCALES)[number], string[]> = {
  fr: ['le', 'nous', 'vous', 'ils', 'attends', 'écoute', 'ce soir', 'demain', 'port', 'signal', 'lumière', 'route', 'encore', 'jamais', 'toujours', 'maison', 'porte', 'calme', 'moteur', 'lettre', 'promesse', 'matin', 'nord', 'eau', 'réponse', 'appel', 'reste', 'pars', 'souviens-toi', 'oublie'],
  de: ['die', 'wir', 'ihr', 'sie', 'warte', 'hör zu', 'heute Nacht', 'morgen', 'Hafen', 'Signal', 'Licht', 'Straße', 'wieder', 'nie', 'immer', 'Zuhause', 'Tür', 'still', 'Motor', 'Brief', 'Versprechen', 'Morgen', 'Norden', 'Wasser', 'Antwort', 'Anruf', 'bleib', 'geh', 'erinnere dich', 'vergiss'],
  'pt-BR': ['o', 'nós', 'você', 'eles', 'espera', 'escuta', 'hoje à noite', 'amanhã', 'porto', 'sinal', 'luz', 'estrada', 'de novo', 'nunca', 'sempre', 'casa', 'porta', 'quieto', 'motor', 'carta', 'promessa', 'manhã', 'norte', 'água', 'resposta', 'chamada', 'fica', 'vai', 'lembre-se', 'esqueça'],
};
const GLOSSARY_SEEDS: Array<[string, Record<(typeof SYNTHETIC_LOCALES)[number], string>]> = [
  ['the harbor master', { fr: 'le capitaine du port', de: 'der Hafenmeister', 'pt-BR': 'o capitão do porto' }],
  ['signal room', { fr: 'salle des signaux', de: 'Signalraum', 'pt-BR': 'sala de sinais' }],
  ['night ferry', { fr: 'ferry de nuit', de: 'Nachtfähre', 'pt-BR': 'balsa noturna' }],
];

export function syntheticTitleId(i: number): string {
  return `tt_syn_${String(i + 1).padStart(3, '0')}`;
}

function sentence(rng: Rng, words: string[], min: number, max: number): string {
  const n = rng.int(min, max);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(rng.pick(words));
  const s = parts.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1) + rng.pick(['.', '.', '.', '?', '!']);
}

interface SynthTitle {
  title_id: string;
  name: string;
}

export function syntheticTitles(): SynthTitle[] {
  return Array.from({ length: SYNTHETIC_TITLE_COUNT }, (_, i) => ({ title_id: syntheticTitleId(i), name: TITLE_NAMES[i % TITLE_NAMES.length] }));
}

class Batcher<T> {
  private buf: T[] = [];
  count = 0;
  constructor(private readonly write: (docs: T[]) => Promise<void>) {}
  async push(doc: T): Promise<void> {
    this.buf.push(doc);
    if (this.buf.length >= INSERT_BATCH_SIZE) await this.flush();
  }
  async flush(): Promise<void> {
    if (this.buf.length === 0) return;
    const docs = this.buf;
    this.buf = [];
    await this.write(docs);
    this.count += docs.length;
  }
}

function writer<T>(table: TableName, map?: (doc: T) => Record<string, unknown>) {
  return async (docs: T[]) => {
    await insertRows(table, map ? docs.map(map) : (docs as unknown as Array<Record<string, unknown>>));
  };
}

export interface SeedLog {
  (msg: string): void;
}

async function generateSynthetic(T0: Date, log: SeedLog): Promise<Record<string, number>> {
  const rng = new Rng(PRNG_SEED);
  const cues = new Batcher(writer<SubtitleCue>('subtitle_cues'));
  const pairs = new Batcher(writer<SourceTargetPair>('source_target_pairs', (p) => ({ ...p, previous_source_text: p.previous_source_text ?? '' })));
  const glossary = new Batcher(writer<GlossaryTerm>('glossary_terms', (g) => ({ ...g, note: g.note ?? '' })));
  const events = new Batcher(writer<LocalizationEvent>('localization_events', eventToRow));
  const runs = new Batcher(writer<RunDoc>('release_runs', (r) => runToRow(r)));
  const findings = new Batcher(writer<Finding>('qc_findings', (f) => findingToRow(f)));

  const day = 86_400_000;
  const at = (daysAgo: number, jitterMin = 0) => new Date(T0.getTime() - daysAgo * day - jitterMin * 60_000).toISOString();
  const titles = syntheticTitles();
  let runSeq = 0;
  let findingSeq = 0;

  for (const [ti, title] of titles.entries()) {
    for (const locale of SYNTHETIC_LOCALES) {
      const key = `${title.title_id}_${locale}`;
      for (const [term, targets] of GLOSSARY_SEEDS) {
        await glossary.push({ title_id: title.title_id, locale, source_term: term, approved_target_term: targets[locale], note: 'synthetic' });
      }
      const timings: Array<{ start_ms: number; end_ms: number }> = [];
      let cursor = rng.int(400, 1_500);
      for (let i = 0; i < SYNTHETIC_CUES_PER_VERSION; i++) {
        const dur = rng.int(1_400, 3_000);
        timings.push({ start_ms: cursor, end_ms: cursor + dur });
        cursor += dur + rng.int(120, 900);
      }
      const targetWords = LOCALE_WORDS[locale];
      const texts: string[] = [];
      for (let i = 0; i < SYNTHETIC_CUES_PER_VERSION; i++) texts.push(sentence(rng, targetWords, 2, 5));
      for (let v = 1; v <= SYNTHETIC_VERSIONS; v++) {
        const rev = v <= 2 ? 'r1' : 'r2';
        for (let i = 0; i < SYNTHETIC_CUES_PER_VERSION; i++) {
          const t = timings[i];
          const text = v === SYNTHETIC_VERSIONS || !rng.chance(0.04) ? texts[i] : sentence(rng, targetWords, 2, 5);
          await cues.push({ title_id: title.title_id, locale, cue_id: i + 1, version: v, start_ms: t.start_ms, end_ms: t.end_ms, text, source_revision: rev });
        }
      }
      for (let i = 0; i < SYNTHETIC_CUES_PER_VERSION; i++) {
        await pairs.push({
          title_id: title.title_id,
          cue_id: i + 1,
          source_text: sentence(rng, EN_WORDS, 2, 6),
          target_text: texts[i],
          locale,
          source_revision: rng.chance(0.05) ? 'r2' : 'r1',
          target_version: SYNTHETIC_VERSIONS,
        });
      }
      const base = 40 + ti;
      const ev = (suffix: string, e: Omit<LocalizationEvent, 'event_id' | 'title_id' | 'locale'>) =>
        events.push({ event_id: seededEventId(`${key}_${suffix}`), title_id: title.title_id, locale, ...e });
      await ev('script_locked', { event_type: 'script_locked', source_revision: 'r1', target_version: null, occurred_at: at(base), summary: `English script locked (r1) for ${title.name}`, actor: 'Post-production (fictional)' });
      for (let v = 1; v <= SYNTHETIC_VERSIONS; v++) {
        await ev(`delivery_v${v}`, { event_type: 'vendor_delivery', source_revision: v <= 2 ? 'r1' : 'r2', target_version: v, occurred_at: at(base - 6 * v, rng.int(0, 600)), summary: `${locale} v${v} delivered`, actor: 'Synthetic vendor (fictional)' });
      }
      await ev('revision_r2', { event_type: 'source_revision', source_revision: 'r2', target_version: null, occurred_at: at(base - 13, rng.int(0, 600)), summary: 'Source r2: line polish', actor: 'Script supervisor (fictional)' });
      await ev('release_scheduled', { event_type: 'release_scheduled', source_revision: 'r2', target_version: null, occurred_at: at(base - 20), summary: `Release window for ${title.name} / ${locale}`, actor: 'Release planning (fictional)' });
      const runCount = rng.int(4, 5);
      for (let r = 0; r < runCount; r++) {
        runSeq++;
        const version = Math.min(SYNTHETIC_VERSIONS, r + 1);
        const started = new Date(T0.getTime() - (base - 6 * version) * day + rng.int(5, 240) * 60_000);
        const nFind = rng.int(4, 9);
        const blockers = rng.chance(0.55) ? nFind : rng.int(0, 2);
        const run_id = seededRunId(`syn_${String(runSeq).padStart(4, '0')}`);
        const duration = rng.int(2_800, 9_000);
        const ended = new Date(started.getTime() + duration);
        const runDoc: RunDoc = {
          run_id,
          title_id: title.title_id,
          locale,
          version,
          trigger: rng.chance(0.7) ? 'vendor_delivery' : 'source_revision',
          trigger_event_id: seededEventId(`${key}_delivery_v${version}`),
          parent_run_id: null,
          recheck_run_id: null,
          started_at: started.toISOString(),
          ended_at: ended.toISOString(),
          duration_ms: duration,
          phase: 'complete',
          phases: [],
          release_state: blockers > 0 ? 'HELD' : 'READY',
          blocker_count: blockers,
          finding_count: nFind,
          trace: [],
          agent: null,
          semantic_review: null,
          semantic_candidates: 0,
          approval: null,
          error: null,
          origin: 'seed_baseline',
          dataset: { synthetic_rows_total: 0, disclaimer: SYNTHETIC_DISCLAIMER },
        };
        await runs.push(runDoc);
        await ev(`gate_run_${r}`, { event_type: 'release_gate_run', source_revision: version <= 2 ? 'r1' : 'r2', target_version: version, occurred_at: ended.toISOString(), summary: `Release gate: ${runDoc.release_state} - ${blockers} blockers`, run_id });
        for (let f = 0; f < nFind; f++) {
          findingSeq++;
          const rule: RuleId = rng.pick(['TIMING_OVERLAP', 'READING_SPEED', 'GLOSSARY_DRIFT'] as const);
          const cue_id = rng.int(1, SYNTHETIC_CUES_PER_VERSION);
          const t = timings[cue_id - 1];
          const isBlocker = f < blockers;
          const finding = makeSyntheticFinding(rng, rule, run_id, title.title_id, locale, version, cue_id, t, texts[cue_id - 1], isBlocker, ended.toISOString(), seededFindingId(`syn_${String(findingSeq).padStart(5, '0')}`));
          await findings.push(withEvidenceJson(finding));
        }
      }
    }
    if ((ti + 1) % 11 === 0) log(`  synthetic titles ${ti + 1}/${titles.length} (cues so far ≈ ${cues.count})`);
  }
  await Promise.all([cues.flush(), pairs.flush(), glossary.flush(), events.flush(), runs.flush(), findings.flush()]);
  return { subtitle_cues: cues.count, source_target_pairs: pairs.count, glossary_terms: glossary.count, localization_events: events.count, release_runs: runs.count, qc_findings: findings.count };
}

function makeSyntheticFinding(
  rng: Rng,
  rule: RuleId,
  run_id: string,
  title_id: string,
  locale: string,
  version: number,
  cue_id: number,
  t: { start_ms: number; end_ms: number },
  text: string,
  is_blocker: boolean,
  created_at: string,
  finding_id: string,
): Finding {
  const common = {
    finding_id,
    run_id,
    title_id,
    locale,
    version,
    cue_id,
    rule_id: rule,
    severity: is_blocker ? ('blocker' as const) : ('low' as const),
    is_blocker,
    source: 'deterministic_query' as const,
    confidence: 1,
    proposed_repair: null,
    evidence_ref: { trace_step: null, query_id: null },
    status: is_blocker ? ('resolved' as const) : ('approved' as const),
    created_at,
    priority: RULE_PRIORITY[rule],
  };
  if (rule === 'TIMING_OVERLAP') {
    const overlap = rng.int(40, 900);
    return {
      ...common,
      headline: `Cue ${cue_id} overlaps cue ${cue_id + 1} by ${overlap} ms`,
      detail: 'Synthetic historical finding.',
      evidence: { rule, cue_id, next_cue_id: cue_id + 1, cue_start_ms: t.start_ms, cue_end_ms: t.end_ms + overlap, next_start_ms: t.end_ms, overlap_ms: overlap, min_gap_ms: 80 },
    };
  }
  if (rule === 'READING_SPEED') {
    const cps = Math.round((20.5 + rng.float() * 8) * 10) / 10;
    const chars = Array.from(text).length;
    return {
      ...common,
      headline: `Cue ${cue_id} reads at ${cps} CPS, above the 20 CPS limit`,
      detail: 'Synthetic historical finding.',
      evidence: { rule, cue_id, text, chars, duration_ms: Math.round((chars / cps) * 1000), cps, limit_cps: 20 },
    };
  }
  const g = rng.pick(GLOSSARY_SEEDS);
  const approved = g[1][locale as (typeof SYNTHETIC_LOCALES)[number]];
  return {
    ...common,
    headline: `Glossary says "${approved}", delivery says "${approved.slice(0, -1)}"`,
    detail: 'Synthetic historical finding.',
    evidence: { rule: 'GLOSSARY_DRIFT', cue_id, source_term: g[0], approved_target_term: approved, found_term: approved.slice(0, -1), edit_distance: 1, source_text: `... ${g[0]} ...`, target_text: text },
  };
}

async function insertHero(T0: Date, model: string, backend: 'vertex-ai' | 'gemini-api'): Promise<Record<string, number>> {
  const cues: SubtitleCue[] = [];
  const pairs: SourceTargetPair[] = [];
  for (let v = 1; v <= HERO_VERSION; v++) {
    cues.push(...heroCuesForVersion(v));
    pairs.push(...heroPairsForVersion(v));
  }
  await insertRows('subtitle_cues', cues as unknown as Array<Record<string, unknown>>);
  await insertRows('source_target_pairs', pairs.map((p) => ({ ...p, previous_source_text: p.previous_source_text ?? '' })));
  await insertRows('glossary_terms', heroGlossary().map((g) => ({ ...g, note: g.note ?? '' })));
  const events = heroEvents(T0);
  await insertRows('localization_events', events.map(eventToRow));
  const base = baselineRun(T0, { model, backend, synthetic_rows_total: 0 });
  await insertRows('release_runs', [runToRow(base.run as RunDoc)]);
  await insertRows('qc_findings', base.findings.map((f) => findingToRow(f)));
  return {
    subtitle_cues: cues.length,
    source_target_pairs: pairs.length,
    glossary_terms: heroGlossary().length,
    localization_events: events.length,
    release_runs: 1,
    qc_findings: base.findings.length,
  };
}

export async function datasetStats(_opts: { exact?: boolean } = {}): Promise<DatasetStats> {
  const all = await tableCounts();
  const counts: Record<string, number> = {};
  for (const name of COLLECTION_NAMES) if (name !== 'demo_meta') counts[name] = all[name as TableName] ?? 0;
  const breadth = await queryOne<{ titles: string; locales: string }>(
    'SELECT uniqExact(title_id) AS titles, uniqExact(locale) AS locales FROM {db:Identifier}.subtitle_cues',
  );
  const synthetic_rows_total = SYNTHETIC_ROW_COLLECTIONS.reduce((sum, n) => sum + (counts[n] ?? 0), 0);
  return {
    synthetic_rows_total,
    counts,
    titles: Number(breadth?.titles ?? 0),
    locales: Number(breadth?.locales ?? 0),
    disclaimer: SYNTHETIC_DISCLAIMER,
    computed_at: new Date().toISOString(),
  };
}

export interface SeedResult {
  skipped: boolean;
  seed_version: string;
  duration_ms: number;
  stats: DatasetStats;
  inserted: Record<string, number>;
}

export async function seedDatabase(opts: { force?: boolean; log?: SeedLog } = {}): Promise<SeedResult> {
  const log = opts.log ?? (() => undefined);
  const started = Date.now();
  const cfg = await getConfig();
  await ensureSchema();
  const meta = await readMeta();
  if (!opts.force && meta && meta.seed_version === SEED_VERSION) {
    log(`seed ${SEED_VERSION} already present (seeded_at ${meta.seeded_at}); use --force to rebuild`);
    return { skipped: true, seed_version: SEED_VERSION, duration_ms: Date.now() - started, stats: meta.dataset_stats, inserted: {} };
  }
  log(`truncating ${TABLE_NAMES.length} tables in ${cfg.clickhouse.database} (${cfg.mode})`);
  await truncateAll();
  const T0 = new Date();
  const backend = cfg.gemini.backend ?? 'vertex-ai';
  log('inserting hero dataset (The Last Tram)');
  const hero = await insertHero(T0, cfg.gemini.model, backend);
  log('generating synthetic scale dataset');
  const synth = await generateSynthetic(T0, log);
  const inserted: Record<string, number> = {};
  for (const k of new Set([...Object.keys(hero), ...Object.keys(synth)])) inserted[k] = (hero[k] ?? 0) + (synth[k] ?? 0);
  const stats = await datasetStats({ exact: true });
  await stampDatasetTotal(stats.synthetic_rows_total);
  const duration_ms = Date.now() - started;
  const metaDoc: DemoMetaDoc = {
    id: 'demo',
    seeded_at: T0.toISOString(),
    seed_version: SEED_VERSION,
    last_reset_at: null,
    t0: T0.toISOString(),
    release_at: heroReleaseAt(T0).toISOString(),
    dataset_stats: stats,
    seed_duration_ms: duration_ms,
  };
  await insertRows('demo_meta', [metaToRow(metaDoc)]);
  log(`seed complete in ${duration_ms} ms - ${stats.synthetic_rows_total} rows`);
  return { skipped: false, seed_version: SEED_VERSION, duration_ms, stats, inserted };
}

export class ResetRateLimited extends Error {
  constructor(public readonly retry_after_ms: number) {
    super(`Reset is rate limited; retry in ${Math.ceil(retry_after_ms / 1000)} s`);
  }
}

export interface ResetResult {
  removed: Record<string, number>;
  t0: string;
  release_at: string;
  duration_ms: number;
}

export async function resetDemo(): Promise<ResetResult> {
  const started = Date.now();
  const cfg = await getConfig();
  await ensureSchema();
  const meta = await readMeta();
  if (!meta) throw new Error('Demo dataset is not seeded yet - run `npm run seed` (or POST /admin/seed) first');
  const now = new Date();

  const last = meta.last_reset_at ? new Date(meta.last_reset_at).getTime() : 0;
  const retryIn = last + RESET_COOLDOWN_MS - now.getTime();
  if (retryIn > 0) throw new ResetRateLimited(Math.max(1000, retryIn));
  await insertRows('demo_meta', [metaToRow({ ...meta, last_reset_at: now.toISOString() })]);

  const scope = { title_id: TITLE_ID, locale: HERO_LOCALE, baseline: BASELINE_RUN_ID, hero_version: HERO_VERSION };
  const liveRuns = await query<{ run_id: string }>(
    'SELECT run_id FROM {db:Identifier}.release_runs WHERE title_id = {title_id:String} AND locale = {locale:String} AND run_id != {baseline:String}',
    scope,
    { final: true },
  );
  const runIds = liveRuns.map((r) => r.run_id);
  const findingRunIds = [...runIds, BASELINE_RUN_ID];

  const removed: Record<string, number> = {};
  const countBefore = async (table: TableName, where: string, params: Record<string, unknown>): Promise<number> =>
    countWhere(table, where, params);

  removed.release_runs = await countBefore('release_runs', 'title_id = {title_id:String} AND locale = {locale:String} AND run_id != {baseline:String}', scope);
  removed.qc_findings = await countBefore('qc_findings', 'run_id IN {run_ids:Array(String)}', { run_ids: findingRunIds });
  removed.approvals = await countBefore('approvals', 'run_id IN {run_ids:Array(String)}', { run_ids: findingRunIds });
  removed.subtitle_cues = await countBefore('subtitle_cues', 'title_id = {title_id:String} AND locale = {locale:String} AND version > {hero_version:UInt16}', scope);
  removed.source_target_pairs = await countBefore('source_target_pairs', 'title_id = {title_id:String} AND locale = {locale:String} AND target_version > {hero_version:UInt16}', scope);

  await Promise.all([
    deleteWhere('release_runs', 'title_id = {title_id:String} AND locale = {locale:String} AND run_id != {baseline:String}', scope),
    deleteWhere('qc_findings', 'run_id IN {run_ids:Array(String)}', { run_ids: findingRunIds }),
    deleteWhere('approvals', 'run_id IN {run_ids:Array(String)}', { run_ids: findingRunIds }),
    deleteWhere('subtitle_cues', 'title_id = {title_id:String} AND locale = {locale:String} AND version > {hero_version:UInt16}', scope),
    deleteWhere('source_target_pairs', 'title_id = {title_id:String} AND locale = {locale:String} AND target_version > {hero_version:UInt16}', scope),
    deleteWhere('localization_events', 'title_id = {title_id:String} AND locale = {locale:String}', scope),
  ]);
  removed.localization_events = 0;

  const T0 = now;
  const base = baselineRun(T0, {
    model: cfg.gemini.model,
    backend: cfg.gemini.backend ?? 'vertex-ai',
    synthetic_rows_total: meta.dataset_stats?.synthetic_rows_total ?? 0,
  });
  await Promise.all([
    insertRows('localization_events', heroEvents(T0).map(eventToRow)),
    insertRows('release_runs', [runToRow(base.run as RunDoc)]),
    insertRows('qc_findings', base.findings.map((f) => findingToRow(f))),
  ]);
  const release_at = heroReleaseAt(T0).toISOString();
  await insertRows('demo_meta', [
    metaToRow({ ...meta, t0: T0.toISOString(), release_at, last_reset_at: now.toISOString() }),
  ]);
  return { removed, t0: T0.toISOString(), release_at, duration_ms: Date.now() - started };
}

export async function readMeta(): Promise<DemoMetaDoc | null> {
  const row = await queryOne<Record<string, unknown>>(
    "SELECT * FROM {db:Identifier}.demo_meta WHERE id = 'demo'",
    {},
    { final: true },
  );
  return row ? rowToMeta(row) : null;
}

async function stampDatasetTotal(total: number): Promise<void> {
  const runs = await query<Record<string, unknown>>('SELECT * FROM {db:Identifier}.release_runs', {}, { final: true });
  if (runs.length === 0) return;
  const rows = runs.map((row) => {
    const dataset = { ...(JSON.parse((row.dataset_json as string) || '{}') as Record<string, unknown>), synthetic_rows_total: total };
    return { ...row, dataset_json: JSON.stringify(dataset), updated_at: new Date().toISOString() };
  });
  await insertRows('release_runs', rows);
}

export type { ReleaseRun };
