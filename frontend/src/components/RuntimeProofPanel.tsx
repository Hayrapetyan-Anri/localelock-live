import { useEffect, useState } from 'react';
import { fmtDuration, fmtInt, safeJson } from '../lib/format';
import type { CatalogRisk, HealthResponse, LocaleRisk, ReleaseRun, ToolTraceEntry } from '../types';
import { Chip, Disclosure, KeyValue, SectionLabel } from './ui';

const COLLAPSE_KEY = 'localelock.proofCollapsed';

function readCollapsed(): boolean {
  try {
    const v = window.localStorage.getItem(COLLAPSE_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
  }
  return window.innerWidth < 1280;
}

function TraceRow({ entry }: { entry: ToolTraceEntry }) {
  const fallback = entry.initiator === 'app_fallback';
  return (
    <li className={`rounded-md border px-2 py-1.5 ${entry.ok ? 'border-border bg-raised' : 'border-held/50 bg-held/10'}`}>
      <div className="flex items-center gap-1.5">
        <span className="ll-mono w-5 shrink-0 text-[10.5px] text-muted">{entry.step}</span>
        <Chip tone="accent" mono>
          {entry.tool}
        </Chip>
        {entry.query_id && (
          <Chip tone={entry.matched_expected ? 'muted' : 'warning'} mono title={entry.matched_expected ? 'Matched the expected deterministic query exactly' : 'Did not match the expected query exactly'}>
            {entry.query_id}
            {entry.matched_expected ? '' : ' ≠'}
          </Chip>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          {fallback ? (
            <Chip tone="warning" title="The app executed the exact expected query itself because the agent skipped or altered it">
              ⚠ app fallback
            </Chip>
          ) : (
            <Chip tone="gemini" title="Gemini (via Google ADK) initiated this MCP call">
              ADK agent
            </Chip>
          )}
        </span>
      </div>
      <div className="mt-1 text-[12px] leading-snug text-text" title={entry.query_summary}>
        {entry.query_summary}
      </div>
      <div className="ll-mono mt-0.5 flex flex-wrap items-center gap-x-2 text-[10.5px] text-muted">
        <span>{entry.collection ?? entry.database}</span>
        <span>· {fmtDuration(entry.duration_ms)}</span>
        <span>· {fmtInt(entry.row_count)} row{entry.row_count === 1 ? '' : 's'}</span>
        {!entry.ok && <span className="text-held">· error: {entry.error ?? 'unknown'}</span>}
      </div>
      <Disclosure summary={<span>sanitized query JSON</span>} className="mt-1">
        <pre className="ll-pre max-h-[220px]">{safeJson(entry.query)}</pre>
      </Disclosure>
      <Disclosure summary={<span>rows preview ({Math.min(entry.rows_preview.length, 10)} of {fmtInt(entry.row_count)})</span>}>
        <pre className="ll-pre max-h-[220px]">{entry.rows_preview.length ? safeJson(entry.rows_preview) : '[]  // no rows returned'}</pre>
      </Disclosure>
    </li>
  );
}

export function RuntimeProofPanel({
  gateRun,
  recheckRun,
  health,
  datasetRows,
  catalog,
}: {
  gateRun: ReleaseRun | null;
  recheckRun: ReleaseRun | null;
  health: HealthResponse | null;
  datasetRows: number | null;
  catalog: CatalogRisk | null;
}) {
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed());
  const [tab, setTab] = useState<'gate' | 'recheck'>('gate');
  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
    }
  }, [collapsed]);
  useEffect(() => {
    setTab(recheckRun ? 'recheck' : 'gate');
  }, [recheckRun?.run_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = tab === 'recheck' && recheckRun ? recheckRun : gateRun;
  const agent = run?.agent ?? null;
  const trace = run?.trace ?? [];
  const mcpVersion = trace[0]?.server_version ?? health?.mcp.version ?? null;
  const rows = run?.dataset.synthetic_rows_total ?? datasetRows ?? health?.clickhouse.synthetic_rows_total ?? null;
  const baseline = run?.origin === 'seed_baseline';
  const fallbacks = trace.filter((t) => t.initiator === 'app_fallback').length;

  if (collapsed) {
    return (
      <aside className="ll-card flex w-11 shrink-0 flex-col items-center gap-3 py-3" aria-label="Runtime proof (collapsed)">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="ll-btn rounded-md border border-border bg-raised px-1.5 py-1 text-[12px] text-accent hover:border-accent/60"
          title="Expand runtime proof"
          aria-label="Expand runtime proof panel"
        >
          ‹
        </button>
        <span className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase [writing-mode:vertical-rl]">Runtime proof · {trace.length} MCP calls</span>
      </aside>
    );
  }

  return (
    <aside className="ll-card flex min-h-0 w-[400px] shrink-0 flex-col" aria-label="Runtime proof">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <SectionLabel>Runtime proof</SectionLabel>
        {recheckRun && (
          <div className="ml-1 flex rounded-md border border-border bg-raised p-0.5 text-[11px] font-semibold" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'gate'} onClick={() => setTab('gate')} className={`ll-btn rounded px-2 py-0.5 ${tab === 'gate' ? 'bg-accent/20 text-accent' : 'text-muted'}`}>
              Gate run
            </button>
            <button type="button" role="tab" aria-selected={tab === 'recheck'} onClick={() => setTab('recheck')} className={`ll-btn rounded px-2 py-0.5 ${tab === 'recheck' ? 'bg-ready/20 text-ready' : 'text-muted'}`}>
              Recheck
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="ll-btn ml-auto rounded-md border border-border bg-raised px-1.5 py-0.5 text-[12px] text-muted hover:text-text"
          title="Collapse runtime proof"
          aria-label="Collapse runtime proof panel"
        >
          ›
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3">
        <div className="grid gap-1.5">
          <div className="ll-raised px-2.5 py-1.5">
            <div className="flex items-center gap-1.5">
              <Chip tone="gemini">Google ADK{agent?.adk_version ? ` ${agent.adk_version}` : health?.adk.version ? ` ${health.adk.version}` : ''}</Chip>
              <Chip tone="gemini">Gemini</Chip>
              <span className="ll-mono ml-auto text-[10.5px] text-muted">{agent ? `${agent.llm_turns} LLM turns · ${agent.total_tool_calls} tool calls` : ''}</span>
            </div>
            {agent ? (
              <div className="mt-1 grid gap-0.5">
                <KeyValue k="model" v={agent.model} mono />
                <KeyValue k="backend" v={agent.backend} mono />
                <KeyValue k="project" v={agent.project ?? '-'} mono />
                <KeyValue k="agent" v={`${agent.agent_name} · session ${agent.session_id.slice(0, 8)}`} mono />
                {agent.warnings.length > 0 && (
                  <div className="mt-0.5 rounded border border-running/40 bg-running/10 px-1.5 py-1 text-[11px] text-running">
                    {agent.warnings.map((w, i) => (
                      <div key={i}>⚠ {w}</div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-1 text-[12px] text-muted">
                {baseline ? 'Intake baseline - run the live gate to see the ADK session.' : run ? 'Agent session not started yet.' : 'No run loaded.'}
                {health?.gemini && (
                  <div className="ll-mono mt-0.5 text-[11px]">
                    configured: {health.gemini.model} · {health.gemini.backend ?? 'not configured'}
                    {health.gemini.project ? ` · ${health.gemini.project}` : ''}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="ll-raised px-2.5 py-1.5">
            <div className="flex items-center gap-1.5">
              <Chip tone="accent">MCP</Chip>
              <span className="ll-mono text-[12px] font-semibold text-text">mcp-clickhouse {mcpVersion ?? '?'} · read-only</span>
            </div>
            <div className="mt-0.5 text-[11px] text-muted">
              {health?.mcp.tools_allowed?.length ? `tools: ${health.mcp.tools_allowed.join(', ')}` : 'tools: list_databases, list_tables, run_query'}
              {fallbacks > 0 && <span className="text-running"> · {fallbacks} app-fallback call{fallbacks === 1 ? '' : 's'}</span>}
            </div>
          </div>
          <div className="ll-raised flex items-center gap-2 px-2.5 py-1.5">
            <Chip tone="warning">Synthetic</Chip>
            <span className="ll-tnum text-[12px] text-text">
              {rows !== null ? `${fmtInt(rows)} synthetic cue/version/QC rows` : 'dataset size unavailable'}
            </span>
          </div>

          {catalog && (
            <div className="ll-raised px-2.5 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <Chip tone="accent">ClickHouse</Chip>
                <span className="ll-tnum text-[11.5px] text-muted">
                  scanned <span className="font-semibold text-text">{fmtInt(catalog.scanned_rows)}</span> rows in{' '}
                  <span className="font-semibold text-text">{catalog.elapsed_ms} ms</span>
                </span>
              </div>
              <div className="mt-1 text-[11px] text-muted">
                Catalog-wide QC pressure across {catalog.totals.titles} titles · {catalog.totals.locales} locales
              </div>
              <table className="ll-tnum mt-1 w-full text-[11.5px]">
                <tbody>
                  {catalog.by_locale.map((l: LocaleRisk) => (
                    <tr key={l.locale} className={l.locale === catalog.hero.locale ? 'text-text' : 'text-muted'}>
                      <td className="py-[1px] pr-2 font-semibold">{l.locale}</td>
                      <td className="py-[1px] pr-2 text-right">{fmtInt(l.cues)}</td>
                      <td className="py-[1px] pr-2 text-right">{fmtInt(l.reading_speed_risks + l.overlap_risks)} at risk</td>
                      <td className="py-[1px] text-right font-semibold">{l.risk_pct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <SectionLabel>MCP tool trace</SectionLabel>
            <span className="ll-mono text-[11px] text-muted">{trace.length} call{trace.length === 1 ? '' : 's'}</span>
          </div>
          {trace.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-2.5 py-3 text-center text-[12px] text-muted">
              {baseline ? 'Intake baseline - no MCP trace. Run the live gate.' : run && run.phase !== 'complete' && run.phase !== 'failed' ? 'Waiting for the first MCP call…' : 'No tool calls recorded.'}
            </div>
          ) : (
            <ol className="grid gap-1.5">
              {trace.map((t) => (
                <TraceRow key={`${t.step}-${t.started_at}`} entry={t} />
              ))}
            </ol>
          )}
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <SectionLabel>Gemini semantic review</SectionLabel>
            {run?.semantic_review && <span className="ll-mono text-[11px] text-muted">{fmtDuration(run.semantic_review.latency_ms)}</span>}
          </div>
          {run?.semantic_review ? (
            <div className="grid gap-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip tone={run.semantic_review.output.verdict === 'MEANING_PRESERVED' ? 'ready' : 'held'} mono>
                  {run.semantic_review.output.verdict}
                </Chip>
                <Chip tone="muted">
                  {run.semantic_review.model} · {run.semantic_review.backend}
                </Chip>
                <span className="text-[11px] text-muted">candidates: {run.semantic_candidates ?? 0}</span>
              </div>
              <Disclosure summary={<span>input - the exact and only evidence Gemini received</span>} defaultOpen>
                <pre className="ll-pre max-h-[200px]">{safeJson(run.semantic_review.input)}</pre>
              </Disclosure>
              <Disclosure summary={<span>structured output</span>} defaultOpen>
                <pre className="ll-pre max-h-[200px]">{safeJson(run.semantic_review.output)}</pre>
              </Disclosure>
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-border px-2.5 py-3 text-center text-[12px] text-muted">
              {run?.semantic_candidates === 0
                ? 'No changed source/target pair - semantic escalation not required.'
                : baseline
                  ? 'Pending live Gemini review.'
                  : 'No semantic review yet.'}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
