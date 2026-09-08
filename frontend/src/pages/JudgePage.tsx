import { useCallback, useEffect, useState } from 'react';
import { ErrorState } from '../components/ErrorState';
import { Wordmark } from '../components/Header';
import { Button, Chip, SectionLabel, type Tone } from '../components/ui';
import { api, API_BASE, toApiError, type ApiRequestError } from '../lib/api';
import { fmtDuration, fmtInt } from '../lib/format';
import { linkClick } from '../lib/router';
import { SYNTHETIC_DISCLAIMER, type HealthResponse, type JudgeStatus } from '../types';

const ONE_SENTENCE =
  'LocaleLock Live is the release-control tower for multilingual film and video: when a late subtitle delivery or a source-dialogue revision arrives, it decides whether a title can release in a locale, explains the exact blockers, lets a producer approve corrections, exports a corrected SRT, and proves the corrected release is ready.';

const ARCHITECTURE: string[] = [
  'The catalog view ranks every delivery by the same deterministic rules, over the whole 128k-row dataset, and reports ClickHouse\'s own rows_read and elapsed.',
  'A vendor-delivery or source-revision event on The Last Tram / Spanish v7 triggers a release-gate run.',
  'Google ADK (LlmAgent + InMemoryRunner) with Gemini 2.5 Flash on the Gemini Enterprise Agent Platform (formerly Vertex AI Agent Builder) orchestrates the run.',
  'The agent calls the official mcp-clickhouse server over stdio with CLICKHOUSE_ALLOW_WRITE_ACCESS=false: list_tables and run_query.',
  'ClickHouse returns deterministic evidence rows - a window-function overlap scan, a reading-speed projection, a glossary-drift join, and changed-source pairs.',
  'Gemini receives only the narrowed source/target pair (cue 231) and returns a structured semantic verdict.',
  'The producer reviews four evidence cards and approves each repair; the semantic correction is explicitly human-approved.',
  'The app deterministically exports the corrected SRT (sha256 patch hash) and ingests v8 into ClickHouse.',
  'A second MCP release run rechecks v8: the timing, reading-speed and glossary queries return zero rows, so 4 blockers become 0 - READY TO RELEASE.',
  'The run ends in a Release decision receipt: versioned, hashed, human-approved, and verified by the recheck.',
];

const TEST_STEPS: string[] = [
  'Open / - the catalog view scans every delivery in ClickHouse and shows how many rows it read and how long that took. The Last Tram / Spanish / v7 is the one with a release window open.',
  'Click Open release gate. The header shows The Last Tram · Spanish (Latin America) · v7 and the banner reads RELEASE HELD - 4 blockers (seeded intake baseline). The delivered subtitle file is downloadable from the incoming-event strip.',
  'Click Run release gate. The stepper walks event received → querying ClickHouse → deterministic QC → Gemini semantic review → producer decision; the right panel fills with the live MCP trace.',
  'Review the four evidence cards: cue 118/119 overlap 420 ms, cue 204 at 24.6 CPS, Mara Voss vs Maria Voss, and the Gemini-flagged reversal on cue 231.',
  'Toggle Approve repair on all four cards, then click Export corrected SRT and recheck.',
  'Watch "Approved v8 ingested · patch …" appear, then the recheck run poll until the banner reads READY TO RELEASE - 0 blockers.',
  'The Release decision receipt appears: title, source revision, approved v8, SHA-256 of the exported file, who approved which repair, and the recheck result. Copy receipt puts the whole record on the clipboard.',
  'Reload the page: the READY state comes back from ClickHouse. Use Reset demo in the footer to return to HELD/4 and repeat.',
];

function okTone(ok: boolean | null | undefined, pending: boolean): Tone {
  if (pending) return 'running';
  if (ok === true) return 'ready';
  if (ok === false) return 'held';
  return 'muted';
}

function okText(ok: boolean | null | undefined, pending: boolean): string {
  if (pending) return 'CHECKING';
  if (ok === true) return 'OK';
  if (ok === false) return 'FAIL';
  return 'UNKNOWN';
}

function HealthChip({ label, ok, pending, detail, error }: { label: string; ok: boolean | null | undefined; pending: boolean; detail: string; error?: string | null }) {
  return (
    <div className={`ll-card flex min-w-0 flex-col gap-1 border p-3 ${ok === false ? 'border-held/50' : ok === true ? 'border-ready/40' : 'border-border'}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold text-text">{label}</span>
        <Chip tone={okTone(ok, pending)}>{okText(ok, pending)}</Chip>
      </div>
      <div className="ll-mono truncate text-[11.5px] text-muted" title={detail}>
        {detail}
      </div>
      {error && (
        <div className="text-[11.5px] text-held" title={error}>
          {error}
        </div>
      )}
    </div>
  );
}

export function JudgePage() {
  const [status, setStatus] = useState<JudgeStatus | null>(null);
  const [statusError, setStatusError] = useState<ApiRequestError | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<ApiRequestError | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      setStatus(await api.judgeStatus());
    } catch (e) {
      setStatusError(toApiError(e));
    } finally {
      setStatusLoading(false);
    }
  }, []);

  const loadHealth = useCallback(async () => {
    setHealthLoading(true);
    setHealthError(null);
    try {
      setHealth(await api.health(true));
    } catch (e) {
      setHealthError(toApiError(e));
    } finally {
      setHealthLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    void loadHealth();
  }, [loadStatus, loadHealth]);

  const architecture = status?.architecture?.length ? status.architecture : ARCHITECTURE;
  const testSteps = status?.test_steps?.length ? status.test_steps : TEST_STEPS;
  const repo = status?.links.repo ?? null;
  const releaseState = status?.state.release;

  return (
    <div className="min-h-full bg-bg">
      <header className="flex h-14 items-center gap-4 border-b border-border bg-surface/80 px-6">
        <Wordmark />
        <span className="text-[13px] text-muted">Judge page</span>
        <a href="/" onClick={linkClick('/')} className="ml-auto text-[12.5px] font-semibold text-accent hover:underline">
          ← Release dashboard
        </a>
      </header>
      <main className="mx-auto flex max-w-[1080px] flex-col gap-6 px-6 py-8">
        <section className="flex flex-col gap-4">
          <Chip tone="warning" className="w-fit !whitespace-normal !leading-[15px]">
            <span aria-hidden>◈</span> {SYNTHETIC_DISCLAIMER}
          </Chip>
          <h1 className="m-0 text-[30px] leading-[1.2] font-extrabold tracking-tight text-text">{ONE_SENTENCE}</h1>
          <div className="flex flex-wrap items-center gap-3">
            <a href="/" onClick={linkClick('/')} className="ll-btn inline-flex h-11 items-center gap-2 rounded-lg border border-accent bg-accent px-5 text-[15px] font-semibold text-[#06121f] no-underline hover:bg-[#5cc9f7]">
              ▶ Run verified demo
            </a>
            {releaseState && (
              <span className="text-[13px] text-muted">
                Current persisted state:{' '}
                <span className={`font-semibold ${releaseState.state === 'READY' ? 'text-ready' : releaseState.state === 'HELD' ? 'text-held' : 'text-running'}`}>
                  {releaseState.state} · {releaseState.blocker_count} blocker{releaseState.blocker_count === 1 ? '' : 's'}
                </span>{' '}
                · v{releaseState.version} · {releaseState.origin === 'seed_baseline' ? 'seeded baseline' : 'live release-gate run'}
              </span>
            )}
            {repo && (
              <a href={repo} target="_blank" rel="noreferrer" className="text-[13px] font-semibold text-accent hover:underline">
                Source repository ↗
              </a>
            )}
          </div>
          {statusError && !statusLoading && (
            <ErrorState error={statusError} onRetry={() => void loadStatus()} compact />
          )}
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <SectionLabel>Live runtime status · GET /health?deep=1</SectionLabel>
            <Button size="sm" variant="ghost" onClick={() => void loadHealth()} loading={healthLoading}>
              Re-check
            </Button>
          </div>
          {healthError && !healthLoading ? (
            <ErrorState error={healthError} onRetry={() => void loadHealth()} compact />
          ) : (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <HealthChip
                label="ClickHouse"
                ok={health?.clickhouse.ok}
                pending={healthLoading}
                detail={health ? `${health.clickhouse.database}${health.clickhouse.host_hint ? ` @ ${health.clickhouse.host_hint}` : ''} · ${fmtDuration(health.clickhouse.latency_ms)}` : 'checking…'}
                error={health?.clickhouse.error}
              />
              <HealthChip
                label="ClickHouse MCP (read-only)"
                ok={health?.mcp.ok}
                pending={healthLoading}
                detail={health ? `${health.mcp.server} ${health.mcp.version} · ${health.mcp.tools_allowed.join(', ')}` : 'checking…'}
                error={health?.mcp.error}
              />
              <HealthChip
                label="Gemini / Google ADK"
                ok={health ? (health.gemini.configured ? health.gemini.ok : false) : undefined}
                pending={healthLoading}
                detail={health ? `${health.gemini.model} · ${health.gemini.backend ?? 'not configured'}${health.gemini.project ? ` · ${health.gemini.project}` : ''} · ADK ${health.adk.version}` : 'checking…'}
                error={health ? (health.gemini.configured ? health.gemini.error : 'Gemini is not configured on this API') : null}
              />
              <HealthChip
                label="Synthetic dataset"
                ok={health ? health.clickhouse.synthetic_rows_total > 0 : undefined}
                pending={healthLoading}
                detail={health ? `${fmtInt(health.clickhouse.synthetic_rows_total)} cue/version/QC rows · ${Object.keys(health.clickhouse.counts).length} tables` : 'checking…'}
              />
            </div>
          )}
          {health && (
            <div className="ll-mono text-[11.5px] text-muted">
              {health.service} {health.version} · {health.runtime.mode}
              {health.runtime.region ? ` · ${health.runtime.region}` : ''} · node {health.runtime.node} · {health.agent_db_boundary}
            </div>
          )}
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="ll-card flex flex-col gap-3 p-5">
            <SectionLabel>Architecture (all real, no fixtures in the run path)</SectionLabel>
            <ol className="m-0 flex list-none flex-col gap-2 p-0">
              {architecture.map((step, i) => (
                <li key={i} className="flex gap-3 text-[13.5px] text-text">
                  <span className="ll-mono mt-[1px] inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-accent/50 bg-accent/10 text-[11px] font-bold text-accent">{i + 1}</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </section>
          <section className="ll-card flex flex-col gap-3 p-5">
            <SectionLabel>Test it yourself (about 90 seconds)</SectionLabel>
            <ol className="m-0 flex list-none flex-col gap-2 p-0">
              {testSteps.map((step, i) => (
                <li key={i} className="flex gap-3 text-[13.5px] text-text">
                  <span className="ll-mono mt-[1px] inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-ready/50 bg-ready/10 text-[11px] font-bold text-ready">{i + 1}</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <section className="ll-card flex flex-col gap-2 border-running/40 p-5">
          <SectionLabel className="!text-running">Synthetic data disclosure</SectionLabel>
          <p className="m-0 text-[13.5px] text-text">{SYNTHETIC_DISCLAIMER}</p>
          <p className="m-0 text-[13px] text-muted">
            The Last Tram is a fictional 12-minute short written for this demo; its English dialogue, Spanish subtitles, glossary and vendor events are authored by us. The remaining
            {status ? ` ${fmtInt(status.state.dataset.synthetic_rows_total)}` : ' 100,000+'} cue/version/QC rows are generated with a seeded PRNG under clearly fictional titles. Findings are
            computed only from real MCP tool results; Gemini receives only the narrowed source/target pair, and the READY/0 state is a persisted run created after real v8 ingestion.
          </p>
        </section>

        <footer className="flex flex-wrap items-center gap-4 text-[12px] text-muted">
          <span className="ll-mono">API {status?.links.api ?? API_BASE}</span>
          {status?.links.app && (
            <a href={status.links.app} className="text-accent hover:underline">
              app
            </a>
          )}
          {repo && (
            <a href={repo} target="_blank" rel="noreferrer" className="text-accent hover:underline">
              repository
            </a>
          )}
          <span className="ml-auto">MIT licensed · hackathon build</span>
        </footer>
      </main>
    </div>
  );
}
