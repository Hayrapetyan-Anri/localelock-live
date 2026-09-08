import { fmtDeltaMs, fmtTimecode, repairKindLabel, ruleLabel } from '../lib/format';
import type { Finding, ProposedRepair, Severity } from '../types';
import { GlossaryDriftView, ReadingSpeedView, SemanticView, TimingOverlapView } from './EvidenceViews';
import { Chip, Toggle, type Tone } from './ui';

const severityTone: Record<Severity, Tone> = {
  blocker: 'held',
  high: 'held',
  medium: 'warning',
  low: 'muted',
  info: 'muted',
};

function RepairBlock({ repair }: { repair: ProposedRepair }) {
  const isTime = repair.kind !== 'replace_text';
  const delta = repair.after.end_ms - repair.before.end_ms;
  const verification = Object.entries(repair.verification);
  return (
    <div className="rounded-md border border-border bg-bg/50 px-2.5 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[10.5px] font-semibold tracking-wide text-muted uppercase">Repair · {repairKindLabel(repair.kind)}</span>
        {repair.origin === 'gemini_suggestion' ? <Chip tone="gemini">Gemini suggestion</Chip> : <Chip tone="muted">deterministic</Chip>}
        <Chip tone="warning" className="ml-auto">
          requires producer approval
        </Chip>
      </div>
      <div className="mt-1 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 text-[12.5px]">
        {isTime ? (
          <div className="ll-mono truncate text-text/80" title={`before: ${fmtTimecode(repair.before.start_ms)} → ${fmtTimecode(repair.before.end_ms)}`}>
            {fmtTimecode(repair.before.start_ms)} → <span className="text-held line-through decoration-held/60">{fmtTimecode(repair.before.end_ms)}</span>
          </div>
        ) : (
          <div className="truncate text-held line-through decoration-held/60" title={repair.before.text}>
            “{repair.before.text}”
          </div>
        )}
        <span aria-hidden className="text-[15px] text-muted">
          →
        </span>
        {isTime ? (
          <div className="ll-mono truncate text-text" title={`after: ${fmtTimecode(repair.after.start_ms)} → ${fmtTimecode(repair.after.end_ms)}`}>
            {fmtTimecode(repair.after.start_ms)} → <span className="font-semibold text-ready">{fmtTimecode(repair.after.end_ms)}</span>
            <span className="ml-1 text-[11px] text-muted">({fmtDeltaMs(delta)})</span>
          </div>
        ) : (
          <div className="truncate font-semibold text-ready" title={repair.after.text}>
            “{repair.after.text}”
          </div>
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-x-3 text-[11px] text-muted">
        <span className="min-w-0 truncate" title={repair.summary}>
          {repair.summary}
        </span>
        {verification.length > 0 && (
          <span className="ll-mono ml-auto shrink-0 whitespace-nowrap" title="Post-repair verification values">
            ✓ {verification.map(([k, v]) => `${k}=${String(v)}`).join(' · ')}
          </span>
        )}
      </div>
    </div>
  );
}

export function EvidenceCard({
  finding,
  approved,
  onApprove,
  approvable,
  approvedVersion,
}: {
  finding: Finding;
  approved: boolean;
  onApprove: (v: boolean) => void;
  approvable: boolean;
  approvedVersion: number | null;
}) {
  const ev = finding.evidence;
  const isSemantic = ev.rule === 'SEMANTIC_REVERSAL';
  const pendingReview = isSemantic && (finding.source === 'deterministic_query' || ev.review.output.confidence === 0);
  const recorded = finding.status !== 'open';
  const showGreen = approved || finding.status === 'approved';
  const border = showGreen ? 'border-ready/60' : isSemantic ? 'border-gemini/40' : 'border-border';

  return (
    <article
      className={`ll-card relative flex min-h-0 flex-col overflow-hidden border ${border} ${showGreen ? 'bg-[#10201b]' : ''}`}
      aria-label={`${ruleLabel(finding.rule_id)} finding for cue ${finding.cue_id}`}
    >
      {showGreen && <div aria-hidden className="absolute inset-y-0 left-0 w-1 bg-ready" />}
      <header className="flex items-center gap-2 px-3.5 pt-2 pb-1">
        <span className="ll-mono text-[11px] font-bold text-muted">#{finding.priority}</span>
        <Chip tone={isSemantic ? 'gemini' : 'accent'}>{ruleLabel(finding.rule_id)}</Chip>
        <Chip tone="neutral" mono>
          Cue {finding.cue_id} · v{finding.version}
        </Chip>
        <span className="ml-auto flex items-center gap-1.5">
          {finding.evidence_ref.query_id && (
            <Chip tone="muted" mono title={`Evidence from MCP trace step ${finding.evidence_ref.trace_step ?? '-'}`}>
              {finding.evidence_ref.query_id.split('_')[0]}
            </Chip>
          )}
          <Chip tone={severityTone[finding.severity]}>{finding.is_blocker ? (finding.severity === 'blocker' ? 'BLOCKER' : `BLOCKER · ${finding.severity}`) : finding.severity}</Chip>
        </span>
      </header>
      {isSemantic && (
        <div className="mx-3.5 mb-1 flex items-center gap-2 rounded-md border border-gemini/50 bg-gemini/10 px-2 py-[2px] text-[11.5px] font-semibold text-gemini">
          <span aria-hidden>✦</span> Gemini semantic escalation - Gemini saw only this narrowed pair; the producer decides
        </div>
      )}
      <h3 className="mx-3.5 mb-1.5 line-clamp-2 text-[15px] leading-tight font-semibold text-text" title={finding.headline}>
        {finding.headline}
      </h3>
      <div className="relative min-h-0 flex-1">
        <div className="ll-scroll h-full overflow-y-auto px-3.5 pb-2">
          <div className="flex flex-col gap-2">
            {ev.rule === 'TIMING_OVERLAP' && <TimingOverlapView ev={ev} repair={finding.proposed_repair} />}
            {ev.rule === 'READING_SPEED' && <ReadingSpeedView ev={ev} repair={finding.proposed_repair} />}
            {ev.rule === 'GLOSSARY_DRIFT' && <GlossaryDriftView ev={ev} />}
            {ev.rule === 'SEMANTIC_REVERSAL' && <SemanticView ev={ev} pending={pendingReview} />}
            {finding.proposed_repair ? (
              <RepairBlock repair={finding.proposed_repair} />
            ) : (
              <div className="rounded-md border border-border bg-bg/50 px-2.5 py-1.5 text-[12px] text-muted">No repair proposed for this finding.</div>
            )}
          </div>
        </div>
        <div aria-hidden className={`pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t ${showGreen ? 'from-[#10201b]' : 'from-surface'} to-transparent`} />
      </div>
      <footer className="flex items-center gap-3 border-t border-border/70 px-3.5 py-1.5">
        <Toggle
          checked={approved || finding.status === 'approved'}
          onChange={onApprove}
          disabled={!approvable || recorded}
          labelOn="Approved"
          labelOff="Approve repair"
          id={`approve-${finding.finding_id}`}
        />
        <span className={`truncate text-[12px] ${showGreen ? 'font-semibold text-ready' : 'text-muted'}`}>
          {finding.status === 'approved'
            ? `Approved · repaired in v${approvedVersion ?? finding.version + 1}`
            : finding.status === 'rejected'
              ? 'Rejected - release stays HELD'
              : finding.status === 'resolved'
                ? 'Resolved'
                : approved
                  ? 'Approved for export'
                  : approvable
                    ? isSemantic
                      ? 'Human approval required for the Gemini correction'
                      : 'Awaiting producer approval'
                    : 'Run the live release gate to approve repairs'}
        </span>
      </footer>
    </article>
  );
}
