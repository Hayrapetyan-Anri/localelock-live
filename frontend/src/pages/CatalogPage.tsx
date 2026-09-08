import { useEffect, useState } from 'react';
import { api, describeApiError } from '../lib/api';
import { fmtInt, fmtTimecode } from '../lib/format';
import { navigate } from '../lib/router';
import { Button, Chip, Spinner } from '../components/ui';
import { SYNTHETIC_DISCLAIMER, type CatalogRisk, type DeliveryRisk, type DemoState, type RiskyDelivery } from '../types';

const LANGUAGE: Record<string, string> = {
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  'pt-BR': 'Portuguese',
};

function countdown(minutes: number): string {
  if (minutes <= 0) return 'release window open';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `releases in ${h > 0 ? `${h}h ` : ''}${m}m`;
}

function RiskDetail({ d }: { d: RiskyDelivery }) {
  const [data, setData] = useState<DeliveryRisk | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .deliveryRisk(d.title_id, d.locale, d.version)
      .then((r) => alive && setData(r))
      .catch((e) => alive && setError(describeApiError(e).message));
    return () => {
      alive = false;
    };
  }, [d.title_id, d.locale, d.version]);

  if (error) return <div className="px-3 py-2 text-[12.5px] text-held">{error}</div>;
  if (!data)
    return (
      <div className="px-3 py-2 text-[12.5px] text-muted">
        <Spinner className="mr-2 inline-block" /> Reading the cues from ClickHouse…
      </div>
    );

  return (
    <div className="px-3 py-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted">
        <span>
          <span className="font-semibold text-text">{data.cues.length}</span> cue{data.cues.length === 1 ? '' : 's'} above the{' '}
          <span className="font-semibold text-text">20 CPS</span> reading-speed limit
        </span>
        <span className="ll-tnum">
          ClickHouse read {fmtInt(data.query.rows_read)} rows in {data.query.elapsed_ms} ms
        </span>
      </div>
      <div className="ll-scroll max-h-[190px] overflow-y-auto rounded-md border border-border/70">
        <table className="w-full text-[12px]">
          <thead className="sticky top-0 bg-raised">
            <tr className="text-[10px] tracking-wide text-muted uppercase">
              <th className="px-2 py-1 text-left font-semibold">Cue</th>
              <th className="px-2 py-1 text-left font-semibold">In</th>
              <th className="px-2 py-1 text-left font-semibold">Subtitle text</th>
              <th className="px-2 py-1 text-right font-semibold">Chars</th>
              <th className="px-2 py-1 text-right font-semibold">Secs</th>
              <th className="px-2 py-1 text-right font-semibold">CPS</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {data.cues.map((c) => (
              <tr key={c.cue_id}>
                <td className="ll-mono px-2 py-1 text-muted">{c.cue_id}</td>
                <td className="ll-mono px-2 py-1 text-muted">{fmtTimecode(c.start_ms)}</td>
                <td className="max-w-[420px] truncate px-2 py-1 text-text" title={c.text}>
                  {c.text}
                </td>
                <td className="ll-tnum px-2 py-1 text-right text-muted">{c.chars}</td>
                <td className="ll-tnum px-2 py-1 text-right text-muted">{(c.duration_ms / 1000).toFixed(1)}</td>
                <td className="ll-tnum px-2 py-1 text-right font-semibold text-running">{c.cps}</td>
              </tr>
            ))}
            {data.cues.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-3 text-center text-muted">
                  No cues above the limit in this delivery.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DeliveryRow({
  d,
  state,
  expanded,
  onToggle,
  onOpen,
}: {
  d: RiskyDelivery;
  state: DemoState | null;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const held = d.is_hero && state?.release.state === 'HELD';
  const ready = d.is_hero && state?.release.state === 'READY';
  const approvedVersion = state?.approved_version ?? null;
  return (
    <>
      <tr className={`cursor-pointer hover:bg-raised/60 ${d.is_hero ? 'bg-held/5' : ''} ${expanded ? 'bg-raised/60' : ''}`} onClick={onToggle}>
        <td className="px-3 py-2">
          <div className="flex items-center gap-2">
            <span aria-hidden className={`inline-block w-2 text-[10px] text-muted transition-transform ${expanded ? 'rotate-90' : ''}`}>
              ▸
            </span>
            {d.is_hero && <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full bg-held" />}
            <span className={d.is_hero ? 'font-semibold text-text' : 'text-muted'}>{d.title_name}</span>
          </div>
          <div className="ll-mono pl-4 text-[11px] text-muted sm:hidden">
            {LANGUAGE[d.locale] ?? d.locale} · v{ready && approvedVersion ? approvedVersion : d.version}
          </div>
        </td>
        <td className="hidden px-3 py-2 text-[12.5px] text-muted sm:table-cell">
          {LANGUAGE[d.locale] ?? d.locale} <span className="ll-mono text-[11px] opacity-70">{d.locale}</span>
        </td>
        <td className="ll-mono hidden px-3 py-2 text-[12.5px] text-muted sm:table-cell">
          v{ready && approvedVersion ? approvedVersion : d.version}
          {ready && approvedVersion ? <span className="ml-1 text-[11px] text-ready">approved</span> : null}
        </td>
        <td className="ll-tnum hidden px-3 py-2 text-right text-muted lg:table-cell">{fmtInt(d.cues)}</td>
        <td className="ll-tnum px-3 py-2 text-right">
          {ready ? (
            <span className="text-ready">0</span>
          ) : (
            <span className={d.reading_speed_risks > 0 ? 'text-running' : 'text-muted'}>{d.reading_speed_risks}</span>
          )}
        </td>
        <td className="ll-tnum hidden px-3 py-2 text-right text-muted lg:table-cell">{ready ? '-' : d.max_cps}</td>
        <td className="px-3 py-2 text-right">
          {d.is_hero ? (
            <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
              <span className="ll-tnum text-[12px] text-muted">{state ? countdown(state.delivery.minutes_to_release) : ''}</span>
              {held && <Chip tone="held">HELD · {state?.release.blocker_count} blockers</Chip>}
              {ready && <Chip tone="ready">READY · 0 blockers</Chip>}
              <Button
                size="sm"
                variant="primary"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen();
                }}
              >
                {ready ? 'View release decision' : 'Open release gate'}
              </Button>
            </div>
          ) : (
            <span className="inline-flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
              <span className="hidden text-[11.5px] text-muted sm:inline">No release date yet</span>
              <span className="ll-btn inline-flex h-7 items-center rounded-md border border-border px-2.5 text-[12px] font-semibold text-accent">
                {expanded ? 'Hide subtitles' : 'Inspect subtitles'}
              </span>
            </span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} className="border-t border-border/60 bg-bg/40 p-0">
            <RiskDetail d={d} />
          </td>
        </tr>
      )}
    </>
  );
}

export function CatalogPage() {
  const [catalog, setCatalog] = useState<CatalogRisk | null>(null);
  const [state, setState] = useState<DemoState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.catalogRisk(), api.demoState()])
      .then(([c, s]) => {
        if (!alive) return;
        setCatalog(c);
        setState(s);
      })
      .catch((e) => alive && setError(describeApiError(e).message));
    return () => {
      alive = false;
    };
  }, []);

  const open = () => navigate('/gate');

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[1180px] flex-col gap-3 px-6 py-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span aria-hidden className="text-[20px]">
            🔒
          </span>
          <span className="text-[17px] font-bold tracking-tight text-text">LocaleLock Live</span>
          <span className="text-[13px] text-muted">Release control for multilingual video</span>
        </div>
        <div className="flex items-center gap-2">
          <Chip tone="warning" title={SYNTHETIC_DISCLAIMER}>
            Synthetic data
          </Chip>
          <a className="text-[13px] font-semibold text-accent hover:underline" href="/judge">
            /judge
          </a>
        </div>
      </header>

      <div className="ll-card p-4">
        <h1 className="text-[25px] leading-tight font-bold text-text">Which subtitle deliveries are at risk?</h1>
        <p className="mt-1 max-w-[88ch] text-[13.5px] leading-snug text-muted">
          <span className="text-text">Each row below is one subtitle file</span> - one film or episode, translated into one language,
          at one delivery version. A vendor sends these before a release; broken timing or unreadable lines block the release in that
          country. This scans <span className="font-semibold text-text">every one of them</span> with the same rules the release gate
          uses, so a producer sees the risk before a deadline arrives.{' '}
          <span className="text-text">Click any row to read the exact subtitles behind its number.</span>
        </p>
        {catalog && (
          <div className="ll-raised mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-1 px-3 py-2 text-[12.5px]">
            <span className="text-muted">
              ClickHouse scanned <span className="ll-tnum font-semibold text-text">{fmtInt(catalog.scanned_rows)}</span> rows in{' '}
              <span className="ll-tnum font-semibold text-text">{catalog.elapsed_ms} ms</span>
            </span>
            <span className="text-muted">
              <span className="ll-tnum font-semibold text-text">{catalog.totals.titles}</span> titles ·{' '}
              <span className="ll-tnum font-semibold text-text">{catalog.totals.locales}</span> locales ·{' '}
              <span className="ll-tnum font-semibold text-text">{catalog.totals.versions}</span> versions
            </span>
            <span className="text-muted">
              <span className="ll-tnum font-semibold text-running">{fmtInt(catalog.totals.reading_speed_risks)}</span> cues above the
              reading-speed limit
            </span>
          </div>
        )}
      </div>

      {error && (
        <div className="ll-card border-held/60 p-4 text-[14px] text-held">
          {error}
          <div className="mt-2">
            <Button size="sm" onClick={() => window.location.reload()}>
              Retry
            </Button>
          </div>
        </div>
      )}

      <div className="ll-card overflow-hidden">
        <table className="w-full text-[13.5px]">
          <thead>
            <tr className="border-b border-border text-[10.5px] tracking-[0.08em] text-muted uppercase">
              <th className="px-3 py-2 text-left font-semibold">Film / episode</th>
              <th className="hidden px-3 py-2 text-left font-semibold sm:table-cell">Language</th>
              <th className="hidden px-3 py-2 text-left font-semibold sm:table-cell">Vendor delivery</th>
              <th className="hidden px-3 py-2 text-right font-semibold lg:table-cell">Subtitles</th>
              <th className="px-3 py-2 text-right font-semibold">Too fast to read</th>
              <th className="hidden px-3 py-2 text-right font-semibold lg:table-cell">Worst</th>
              <th className="px-3 py-2 text-right font-semibold">Release status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {catalog?.deliveries.map((d) => {
              const key = `${d.title_id}-${d.locale}-${d.version}`;
              return (
                <DeliveryRow
                  key={key}
                  d={d}
                  state={state}
                  expanded={openKey === key}
                  onToggle={() => setOpenKey(openKey === key ? null : key)}
                  onOpen={open}
                />
              );
            })}
            {!catalog && !error && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-muted">
                  <Spinner className="mr-2 inline-block" /> Scanning the catalog…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="ll-card flex flex-wrap items-start justify-between gap-4 p-3.5">
        <div className="max-w-[74ch]">
          <div className="mb-1 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
            Why only one row has a release gate
          </div>
          <p className="text-[12.5px] leading-snug text-muted">
            Every row here is inspectable: click it and you read the real subtitles that are too fast, straight from ClickHouse. What
            only one row has is a <span className="text-text">release date</span>. A release gate is what you run when a title is about
            to ship, and it does one extra thing the others cannot support - it compares each translated line against the original
            English and asks Gemini whether the meaning survived. That needs a genuine translation on both sides.{' '}
            <span className="font-semibold text-text">The Last Tram</span> is our own short film, written in English and translated into
            Spanish by hand, and its Spanish delivery ships in under two hours. So it is the one the agent takes all the way to a signed
            release decision. The other rows are generated catalog data: real numbers, but not real translations. {SYNTHETIC_DISCLAIMER}
          </p>
        </div>
        <Button variant="primary" size="lg" onClick={open} disabled={!catalog} className="shrink-0">
          {state?.release.state === 'READY' ? 'View the release decision →' : 'Open the held release →'}
        </Button>
      </div>
    </div>
  );
}
