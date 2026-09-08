import { getClient, databaseName, quoteLiteral as qLit } from '../db/clickhouse.js';
import { CPS_LIMIT, MIN_CUE_GAP_MS, HERO_LOCALE, HERO_VERSION, TITLE_NAME, TITLE_ID, type CatalogQueryStat, type CatalogRisk, type LocaleRisk } from './constants.js';
import { syntheticTitles } from './seed.js';

let titleNames: Map<string, string> | null = null;
function titleName(title_id: string): string {
  if (title_id === TITLE_ID) return TITLE_NAME;
  if (!titleNames) titleNames = new Map(syntheticTitles().map((t) => [t.title_id, t.name]));
  return titleNames.get(title_id) ?? title_id;
}

export type { CatalogQueryStat, CatalogRisk, LocaleRisk };

const CATALOG_TTL_MS = 60_000;
let cache: { at: number; value: CatalogRisk } | null = null;

export function invalidateCatalogCache(): void {
  cache = null;
}

interface JsonResult<T> {
  data: T[];
  statistics?: { elapsed: number; rows_read: number; bytes_read: number };
}

async function analytic<T>(label: string, sql: string): Promise<{ rows: T[]; stat: CatalogQueryStat }> {
  const client = await getClient();
  const rs = await client.query({ query: sql, format: 'JSON' });
  const body = (await rs.json()) as JsonResult<T>;
  return {
    rows: body.data ?? [],
    stat: {
      label,
      sql: sql.replace(/\s+/g, ' ').trim(),
      rows_read: body.statistics?.rows_read ?? 0,
      bytes_read: body.statistics?.bytes_read ?? 0,
      elapsed_ms: Math.round((body.statistics?.elapsed ?? 0) * 1000),
    },
  };
}

export interface DeliveryRiskCue {
  cue_id: number;
  start_ms: number;
  end_ms: number;
  text: string;
  chars: number;
  duration_ms: number;
  cps: number;
}

export async function deliveryRiskCues(title_id: string, locale: string, version: number): Promise<{ cues: DeliveryRiskCue[]; stat: CatalogQueryStat }> {
  const db = await databaseName();
  const res = await analytic<Record<string, string>>(
    `Cues over the reading-speed limit in ${title_id} / ${locale} / v${version}`,
    `SELECT cue_id, start_ms, end_ms, text,
            lengthUTF8(replaceAll(text, '\\n', '')) AS chars,
            end_ms - start_ms AS duration_ms,
            round(chars / (duration_ms / 1000), 1) AS cps
     FROM ${db}.subtitle_cues
     WHERE title_id = ${qLit(title_id)} AND locale = ${qLit(locale)} AND version = ${Number(version)} AND cps > ${CPS_LIMIT}
     ORDER BY cps DESC
     LIMIT 25`,
  );
  return {
    cues: res.rows.map((r) => ({
      cue_id: Number(r.cue_id),
      start_ms: Number(r.start_ms),
      end_ms: Number(r.end_ms),
      text: String(r.text),
      chars: Number(r.chars),
      duration_ms: Number(r.duration_ms),
      cps: Number(r.cps),
    })),
    stat: res.stat,
  };
}

export async function catalogRisk(): Promise<CatalogRisk> {
  const cached = cache;
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.value;
  const db = await databaseName();

  const speedQ = analytic<{ locale: string; cues: string; versions: string; titles: string; reading_speed_risks: string }>(
    'Reading-speed pressure by locale, whole catalog',
    `SELECT locale,
            count() AS cues,
            uniqExact(title_id) AS titles,
            uniqExact(version) AS versions,
            countIf(lengthUTF8(replaceAll(text, '\\n', '')) / ((end_ms - start_ms) / 1000) > ${CPS_LIMIT}) AS reading_speed_risks
     FROM ${db}.subtitle_cues
     GROUP BY locale
     ORDER BY cues DESC`,
  );

  const overlapQ = analytic<{ locale: string; overlap_risks: string }>(
    'Cue collisions by locale, whole catalog',
    `SELECT locale, countIf(gap_ms < ${MIN_CUE_GAP_MS}) AS overlap_risks
     FROM (
       SELECT locale,
              leadInFrame(start_ms) OVER w - end_ms AS gap_ms,
              leadInFrame(cue_id) OVER w AS next_cue_id
       FROM ${db}.subtitle_cues
       WINDOW w AS (PARTITION BY title_id, locale, version ORDER BY start_ms ASC ROWS BETWEEN CURRENT ROW AND 1 FOLLOWING)
     )
     WHERE next_cue_id != 0
     GROUP BY locale`,
  );

  const deliveriesQ = analytic<{
    title_id: string;
    locale: string;
    version: string;
    cues: string;
    reading_speed_risks: string;
    max_cps: string;
  }>(
    'Riskiest deliveries across the catalog',
    `SELECT title_id, locale, version,
            count() AS cues,
            countIf(lengthUTF8(replaceAll(text, '\n', '')) / ((end_ms - start_ms) / 1000) > ${CPS_LIMIT}) AS reading_speed_risks,
            round(max(lengthUTF8(replaceAll(text, '\n', '')) / ((end_ms - start_ms) / 1000)), 1) AS max_cps
     FROM ${db}.subtitle_cues
     GROUP BY title_id, locale, version
     HAVING reading_speed_risks > 0
     ORDER BY reading_speed_risks DESC, max_cps DESC
     LIMIT 12`,
  );

  const heroRowQ = analytic<{
    title_id: string;
    locale: string;
    version: string;
    cues: string;
    reading_speed_risks: string;
    max_cps: string;
  }>(
    'The delivery with a release window open now',
    `SELECT title_id, locale, version,
            count() AS cues,
            countIf(lengthUTF8(replaceAll(text, '\n', '')) / ((end_ms - start_ms) / 1000) > ${CPS_LIMIT}) AS reading_speed_risks,
            round(max(lengthUTF8(replaceAll(text, '\n', '')) / ((end_ms - start_ms) / 1000)), 1) AS max_cps
     FROM ${db}.subtitle_cues
     WHERE title_id = '${TITLE_ID}' AND locale = '${HERO_LOCALE}' AND version = ${HERO_VERSION}
     GROUP BY title_id, locale, version`,
  );

  const totalsRowQ = analytic<{ titles: string; versions: string }>(
    'Catalog breadth',
    `SELECT uniqExact(title_id) AS titles, uniqExact(version) AS versions FROM ${db}.subtitle_cues`,
  );

  const [speed, overlap, deliveries, heroRow, totalsRow] = await Promise.all([speedQ, overlapQ, deliveriesQ, heroRowQ, totalsRowQ]);

  const overlapByLocale = new Map(overlap.rows.map((r) => [r.locale, Number(r.overlap_risks)]));
  const by_locale: LocaleRisk[] = speed.rows.map((r) => {
    const cues = Number(r.cues);
    const reading = Number(r.reading_speed_risks);
    const collisions = overlapByLocale.get(r.locale) ?? 0;
    return {
      locale: r.locale,
      cues,
      reading_speed_risks: reading,
      overlap_risks: collisions,
      risk_pct: cues > 0 ? Math.round(((reading + collisions) / cues) * 1000) / 10 : 0,
    };
  });

  const queries = [speed.stat, overlap.stat, deliveries.stat, heroRow.stat, totalsRow.stat];
  const value: CatalogRisk = {
    by_locale,
    totals: {
      titles: Number(totalsRow.rows[0]?.titles ?? 0),
      locales: by_locale.length,
      versions: Number(totalsRow.rows[0]?.versions ?? 0),
      cues_scanned: by_locale.reduce((sum, r) => sum + r.cues, 0),
      reading_speed_risks: by_locale.reduce((sum, r) => sum + r.reading_speed_risks, 0),
      overlap_risks: by_locale.reduce((sum, r) => sum + r.overlap_risks, 0),
    },
    deliveries: [...heroRow.rows, ...deliveries.rows.filter((r) => r.title_id !== TITLE_ID)]
      .slice(0, 9)
      .map((r) => ({
        title_id: r.title_id,
        title_name: titleName(r.title_id),
        locale: r.locale,
        version: Number(r.version),
        cues: Number(r.cues),
        reading_speed_risks: Number(r.reading_speed_risks),
        max_cps: Number(r.max_cps),
        is_hero: r.title_id === TITLE_ID && r.locale === HERO_LOCALE,
      })),
    queries,
    scanned_rows: queries.reduce((sum, q) => sum + q.rows_read, 0),
    elapsed_ms: queries.reduce((sum, q) => sum + q.elapsed_ms, 0),
    hero: { title_id: TITLE_ID, locale: HERO_LOCALE },
    computed_at: new Date().toISOString(),
  };
  cache = { at: Date.now(), value };
  return value;
}
