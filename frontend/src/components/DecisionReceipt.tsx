import { useState } from 'react';
import { api } from '../lib/api';
import { fmtDateTime, shortHash } from '../lib/format';
import { Button, Chip } from './ui';
import type { DemoState, ReleaseRun } from '../types';

function Row({ k, v, mono = false }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/50 py-1 last:border-0">
      <span className="shrink-0 text-[11px] tracking-wide text-muted uppercase">{k}</span>
      <span className={`min-w-0 truncate text-right text-[12.5px] text-text ${mono ? 'll-mono' : ''}`}>{v}</span>
    </div>
  );
}

const RULE_LABEL: Record<string, string> = {
  TIMING_OVERLAP: 'Cue timing overlap',
  READING_SPEED: 'Reading speed',
  GLOSSARY_DRIFT: 'Glossary drift',
  SEMANTIC_REVERSAL: 'Semantic meaning (Gemini)',
};

export function DecisionReceipt({
  gateRun,
  recheckRun,
  state,
}: {
  gateRun: ReleaseRun;
  recheckRun: ReleaseRun;
  state: DemoState;
}) {
  const [copied, setCopied] = useState(false);
  const approval = gateRun.approval;
  if (!approval) return null;

  const receipt = {
    decision: 'CLEARED FOR RELEASE',
    title: state.title.name,
    title_id: gateRun.title_id,
    locale: `${state.delivery.locale_name} (${gateRun.locale})`,
    delivered_version: `v${gateRun.version}`,
    approved_version: `v${approval.approved_version}`,
    source_revision: state.title.latest_source_revision,
    approved_srt: approval.srt.filename,
    patch_sha256: approval.patch_hash,
    approved_by: approval.reviewer,
    approved_at: approval.approved_at,
    approvals: approval.decisions.map((d) => ({ rule: d.rule_id, cue: d.cue_id, decision: d.decision })),
    gate_run: gateRun.run_id,
    recheck_run: recheckRun.run_id,
    recheck_result: `${recheckRun.release_state} - ${recheckRun.blocker_count} blockers`,
    verified_at: recheckRun.ended_at,
    evidence: 'ClickHouse via the official mcp-clickhouse server (read-only); semantic review by Gemini via Google ADK',
    data_notice: state.dataset.disclaimer,
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(receipt, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
    }
  };

  return (
    <section className="ll-card border-ready/50 bg-[#0d1c16] p-3.5" aria-label="Release decision receipt">
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span aria-hidden className="text-[15px]">
            ✓
          </span>
          <h2 className="text-[15px] font-bold tracking-tight text-ready">Release decision receipt</h2>
          <Chip tone="ready">CLEARED FOR RELEASE</Chip>
        </div>
        <div className="flex items-center gap-2">
          <a
            className="ll-btn inline-flex h-7 items-center gap-1.5 rounded-md border border-ready/50 px-2.5 text-[12px] font-semibold text-ready hover:bg-ready/10"
            href={api.exportSrtUrl(gateRun.run_id, approval.srt.url)}
            download={approval.srt.filename}
          >
            <span aria-hidden>⤓</span> Approved SRT
          </a>
          <Button size="sm" onClick={copy}>
            {copied ? 'Copied' : 'Copy receipt'}
          </Button>
        </div>
      </header>

      <div className="grid gap-x-6 gap-y-0 sm:grid-cols-2">
        <div>
          <Row k="Title" v={`${state.title.name} · ${gateRun.locale}`} />
          <Row k="Checked against source" v={state.title.latest_source_revision} mono />
          <Row k="Delivered" v={`v${gateRun.version} · ${state.delivery.vendor.replace('Synthetic vendor: ', '')}`} />
          <Row k="Approved version" v={`v${approval.approved_version}`} mono />
          <Row k="File" v={approval.srt.filename} mono />
        </div>
        <div>
          <Row k="SHA-256" v={<span title={approval.patch_hash}>{shortHash(approval.patch_hash)}</span>} mono />
          <Row k="Approved by" v={approval.reviewer} />
          <Row k="Approved at" v={fmtDateTime(approval.approved_at)} />
          <Row k="Recheck" v={`${recheckRun.release_state} - ${recheckRun.blocker_count} blockers`} />
          <Row k="Verified at" v={recheckRun.ended_at ? fmtDateTime(recheckRun.ended_at) : '-'} />
        </div>
      </div>

      <div className="mt-2 border-t border-border/50 pt-2">
        <div className="mb-1 text-[11px] tracking-wide text-muted uppercase">Human approvals ({approval.decisions.length})</div>
        <ul className="grid gap-1 sm:grid-cols-2">
          {approval.decisions.map((d) => (
            <li key={d.finding_id} className="flex items-center gap-2 text-[12.5px]">
              <span aria-hidden className="text-ready">
                ✓
              </span>
              <span className="text-text">{RULE_LABEL[d.rule_id] ?? d.rule_id}</span>
              <span className="ll-mono text-[11.5px] text-muted">cue {d.cue_id}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-2 text-[11.5px] leading-snug text-muted">
        Evidence gathered from ClickHouse through the official <span className="ll-mono">mcp-clickhouse</span> server (read-only);
        semantic judgment by Gemini via Google ADK, approved by a human. Gate run{' '}
        <span className="ll-mono">{gateRun.run_id}</span>, recheck <span className="ll-mono">{recheckRun.run_id}</span>.
      </p>
    </section>
  );
}
