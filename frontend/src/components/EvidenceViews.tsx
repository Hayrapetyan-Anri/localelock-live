import { fmtInt, fmtPct, fmtTimecode } from '../lib/format';
import type {
  GlossaryDriftEvidence,
  ProposedRepair,
  ReadingSpeedEvidence,
  SemanticEvidence,
  TimingOverlapEvidence,
} from '../types';
import { Chip } from './ui';

export function TimingOverlapView({ ev, repair }: { ev: TimingOverlapEvidence; repair: ProposedRepair | null }) {
  const t0 = ev.cue_start_ms - 150;
  const t1 = Math.max(ev.cue_end_ms, ev.next_start_ms) + 700;
  const span = Math.max(1, t1 - t0);
  const pct = (ms: number) => `${Math.max(0, Math.min(100, ((ms - t0) / span) * 100))}%`;
  const width = (a: number, b: number) => `${Math.max(0, Math.min(100, ((b - a) / span) * 100))}%`;
  const afterEnd = repair?.after.end_ms ?? null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[12.5px]">
        <span className="text-muted">
          Cue {ev.cue_id} ends <span className="ll-mono font-semibold text-text">{fmtTimecode(ev.cue_end_ms)}</span>
        </span>
        <span className="text-muted">
          Cue {ev.next_cue_id} starts <span className="ll-mono font-semibold text-text">{fmtTimecode(ev.next_start_ms)}</span>
        </span>
        <span className="text-muted">
          overlap <span className="ll-mono text-[15px] font-extrabold text-held">{fmtInt(ev.overlap_ms)} ms</span> · min gap {ev.min_gap_ms} ms
        </span>
      </div>
      <div className="relative h-[54px] rounded-md border border-border bg-bg/60" role="img" aria-label={`Timeline: cue ${ev.cue_id} ends at ${fmtTimecode(ev.cue_end_ms)}, cue ${ev.next_cue_id} starts at ${fmtTimecode(ev.next_start_ms)}, overlap ${ev.overlap_ms} ms`}>
        <div className="absolute top-[7px] h-[16px] rounded-sm border border-accent/60 bg-accent/25" style={{ left: pct(ev.cue_start_ms), width: width(ev.cue_start_ms, ev.cue_end_ms) }}>
          <span className="ll-mono absolute left-1.5 top-[-1px] text-[10.5px] font-semibold text-accent">cue {ev.cue_id}</span>
        </div>
        <div
          className="absolute top-[31px] h-[16px] rounded-sm border border-muted/50 bg-[linear-gradient(90deg,rgba(138,151,173,0.35),rgba(138,151,173,0.05))]"
          style={{ left: pct(ev.next_start_ms), right: 0 }}
        >
          <span className="ll-mono absolute left-1.5 top-[-1px] text-[10.5px] font-semibold text-muted">cue {ev.next_cue_id} →</span>
        </div>
        <div
          className="absolute top-[3px] bottom-[3px] border-x border-held bg-[repeating-linear-gradient(135deg,rgba(255,77,94,0.45)_0_4px,rgba(255,77,94,0.12)_4px_8px)]"
          style={{ left: pct(ev.next_start_ms), width: width(ev.next_start_ms, ev.cue_end_ms) }}
        />
        <span
          className="ll-mono absolute top-[19px] -translate-x-1/2 rounded bg-held px-1 text-[10px] font-bold text-[#1a0508]"
          style={{ left: pct((ev.next_start_ms + ev.cue_end_ms) / 2) }}
        >
          {ev.overlap_ms} ms overlap
        </span>
        {afterEnd !== null && (
          <div className="absolute top-0 bottom-0 border-l-2 border-dashed border-ready" style={{ left: pct(afterEnd) }} title={`Proposed out-time ${fmtTimecode(afterEnd)}`}>
            <span className="ll-mono absolute bottom-[1px] left-[-64px] w-[60px] text-right text-[10px] font-semibold text-ready">
              → {fmtTimecode(afterEnd).slice(-6)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export function ReadingSpeedView({ ev, repair }: { ev: ReadingSpeedEvidence; repair: ProposedRepair | null }) {
  const max = Math.max(30, Math.ceil(ev.cps + 3));
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  const seconds = ev.duration_ms / 1000;
  const afterCps = typeof repair?.verification.cps === 'number' ? (repair.verification.cps as number) : null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2 text-[13px]">
        <span className="ll-mono text-[18px] font-bold text-text">{ev.chars}</span>
        <span className="text-muted">chars ÷</span>
        <span className="ll-mono text-[18px] font-bold text-text">{seconds.toFixed(1)}</span>
        <span className="text-muted">s =</span>
        <span className="ll-mono text-[22px] font-extrabold text-held">{ev.cps.toFixed(1)}</span>
        <span className="font-semibold text-held">CPS</span>
        <span className="text-muted">· limit</span>
        <span className="ll-mono font-semibold text-text">{ev.limit_cps.toFixed(1)}</span>
      </div>
      <div className="relative h-[30px] rounded-md border border-border bg-bg/60" role="img" aria-label={`${ev.cps} characters per second against a limit of ${ev.limit_cps}`}>
        <div className="absolute inset-y-[6px] left-0 rounded-r-sm bg-ready/60" style={{ width: pct(Math.min(ev.cps, ev.limit_cps)) }} />
        {ev.cps > ev.limit_cps && (
          <div className="absolute inset-y-[6px] rounded-r-sm bg-held" style={{ left: pct(ev.limit_cps), width: pct(ev.cps - ev.limit_cps) }} />
        )}
        <div className="absolute inset-y-0 border-l-2 border-text/80" style={{ left: pct(ev.limit_cps) }}>
          <span className="ll-mono absolute -top-[1px] left-1 text-[10px] font-semibold text-text/90">limit {ev.limit_cps}</span>
        </div>
        {afterCps !== null && (
          <div className="absolute inset-y-0 border-l-2 border-dashed border-ready" style={{ left: pct(afterCps) }}>
            <span className="ll-mono absolute bottom-[1px] right-1 text-[10px] font-semibold text-ready whitespace-nowrap">after {afterCps.toFixed(1)}</span>
          </div>
        )}
      </div>
      <blockquote className="m-0 truncate rounded-md border border-border bg-raised px-2 py-1 text-[12.5px] text-text" title={ev.text}>
        “{ev.text.replace(/\n/g, ' ⏎ ')}”
      </blockquote>
    </div>
  );
}

function Highlight({ text, term, tone }: { text: string; term: string; tone: 'held' | 'ready' }) {
  if (!term) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx < 0) return <>{text}</>;
  const cls = tone === 'held' ? 'bg-held/25 text-held line-through decoration-held/70' : 'bg-ready/20 text-ready';
  return (
    <>
      {text.slice(0, idx)}
      <mark className={`rounded px-0.5 font-semibold ${cls}`}>{text.slice(idx, idx + term.length)}</mark>
      {text.slice(idx + term.length)}
    </>
  );
}

export function GlossaryDriftView({ ev }: { ev: GlossaryDriftEvidence }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-[13px]">
        <span className="text-[11.5px] font-semibold tracking-wide text-muted uppercase">Glossary says</span>
        <span className="ll-mono rounded-md border border-ready/40 bg-ready/10 px-2 py-0.5 font-semibold text-ready">{ev.approved_target_term}</span>
        <span className="text-[11.5px] font-semibold tracking-wide text-muted uppercase">Delivery says</span>
        <span className="flex items-center gap-2">
          <span className="ll-mono rounded-md border border-held/40 bg-held/10 px-2 py-0.5 font-semibold text-held">{ev.found_term}</span>
          <Chip tone="muted" mono>
            edit distance {ev.edit_distance}
          </Chip>
        </span>
      </div>
      <div className="grid gap-1 text-[12.5px]">
        <div className="rounded-md border border-border bg-raised px-2 py-1">
          <span className="mr-2 text-[10.5px] font-semibold text-muted uppercase">es v7</span>
          <Highlight text={ev.target_text} term={ev.found_term} tone="held" />
        </div>
        <div className="rounded-md border border-border bg-raised px-2 py-1 text-muted">
          <span className="mr-2 text-[10.5px] font-semibold text-muted uppercase">en source</span>
          <Highlight text={ev.source_text} term={ev.source_term} tone="ready" />
        </div>
      </div>
    </div>
  );
}

export function SemanticView({ ev, pending }: { ev: SemanticEvidence; pending: boolean }) {
  const out = ev.review.output;
  const verdictTone = out.verdict === 'MEANING_REVERSED' ? 'held' : out.verdict === 'MEANING_SHIFTED' ? 'warning' : 'ready';
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-2 gap-1.5">
        <div className="rounded-md border border-border bg-raised px-2 py-1.5">
          <div className="mb-0.5 flex items-center justify-between text-[10.5px] font-semibold text-muted uppercase">
            <span>EN source · {ev.source_revision}</span>
          </div>
          <div className="text-[14px] font-semibold text-text">“{ev.source_text}”</div>
          {ev.previous_source_text && (
            <div className="mt-0.5 truncate text-[11.5px] text-muted" title={ev.previous_source_text}>
              was “{ev.previous_source_text}” before {ev.source_revision}
            </div>
          )}
        </div>
        <div className="rounded-md border border-held/40 bg-held/5 px-2 py-1.5">
          <div className="mb-0.5 text-[10.5px] font-semibold text-muted uppercase">ES target · v{ev.target_version}</div>
          <div className="text-[14px] font-semibold text-held">“{ev.target_text}”</div>
          <div className="mt-0.5 truncate text-[11.5px] text-muted">translated against an earlier source</div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        <Chip tone={verdictTone} mono>
          {pending ? 'PENDING' : out.verdict}
        </Chip>
        <Chip tone="muted">severity {out.severity}</Chip>
        <Chip tone="gemini" title="Model confidence reported in the structured output">
          confidence {pending ? '-' : fmtPct(out.confidence)}
        </Chip>
        {!pending && (
          <span className="ll-mono text-[11px] text-muted" title={ev.review.model}>
            {ev.review.model} · {ev.review.backend}
          </span>
        )}
      </div>
      <p className="m-0 line-clamp-2 text-[12.5px] text-text/90" title={out.explanation}>
        {out.explanation}
      </p>
      <p className="m-0 text-[11px] text-muted" title={ev.narrowing_rule}>
        Narrowed by: {ev.narrowing_rule}
      </p>
    </div>
  );
}
