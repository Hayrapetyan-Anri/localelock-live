import { fmtDuration } from '../lib/format';
import { RUN_PHASE_ORDER, type ReleaseRun, type RunPhase } from '../types';

type StepState = 'done' | 'active' | 'pending' | 'failed';

const SHORT: Record<RunPhase, string> = {
  event_received: 'Event received',
  querying_clickhouse: 'ClickHouse via MCP',
  deterministic_qc: 'Deterministic QC',
  gemini_semantic_review: 'Gemini review',
  producer_decision: 'Producer decision',
  complete: 'Complete',
  failed: 'Failed',
};

export function RunStepper({ run }: { run: ReleaseRun | null }) {
  const steps: RunPhase[] = RUN_PHASE_ORDER.filter((p) => p !== 'complete');
  const records = new Map<RunPhase, ReleaseRun['phases'][number]>();
  run?.phases.forEach((p) => records.set(p.phase, p));
  const currentIdx = run ? steps.indexOf(run.phase) : -1;
  const finished = run?.phase === 'complete';
  const failedPhase = run?.phase === 'failed' ? run.error?.phase ?? null : null;

  const stateOf = (phase: RunPhase, i: number): StepState => {
    if (!run) return 'pending';
    if (failedPhase === phase) return 'failed';
    if (finished) return 'done';
    if (run.phase === 'failed') return records.get(phase)?.ended_at ? 'done' : 'pending';
    if (i < currentIdx) return 'done';
    if (i === currentIdx) return 'active';
    return 'pending';
  };

  return (
    <div className="flex min-w-0 flex-col gap-1" aria-label="Run progress">
      <div className="flex items-center justify-between gap-2 text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">
        <span>Release-gate run</span>
        <span className="ll-mono truncate normal-case tracking-normal" title={run?.run_id}>
          {run ? `${run.run_id} · ${run.trigger.replace(/_/g, ' ')}` : 'no run yet'}
          {run?.duration_ms != null ? ` · ${fmtDuration(run.duration_ms)}` : ''}
        </span>
      </div>
      <ol className="grid grid-cols-5 gap-1" aria-label="Phases">
        {steps.map((phase, i) => {
          const s = stateOf(phase, i);
          const rec = records.get(phase);
          const tone =
            s === 'done'
              ? run?.origin === 'seed_baseline'
                ? 'text-muted border-border bg-raised'
                : 'text-ready border-ready/50 bg-ready/10'
              : s === 'active'
                ? 'text-running border-running/60 bg-running/10'
                : s === 'failed'
                  ? 'text-held border-held/60 bg-held/10'
                  : 'text-muted border-border bg-raised';
          const seeded = run?.origin === 'seed_baseline';
          const glyph = s === 'done' ? (seeded ? '·' : '✓') : s === 'active' ? '●' : s === 'failed' ? '✕' : String(i + 1);
          const timing =
            s === 'active'
              ? 'running…'
              : rec?.duration_ms != null
                ? fmtDuration(rec.duration_ms)
                : s === 'done'
                  ? seeded
                    ? 'seeded'
                    : 'done'
                  : s === 'failed'
                    ? 'failed'
                    : '';
          return (
            <li key={phase} className={`min-w-0 rounded-md border px-1.5 py-1 ${tone}`} aria-current={s === 'active' ? 'step' : undefined}>
              <div className="flex items-center gap-1 text-[11px] font-semibold">
                <span aria-hidden className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-current text-[8.5px] ${s === 'active' ? 'll-pulse' : ''}`}>
                  {glyph}
                </span>
                <span className="truncate" title={SHORT[phase]}>
                  {SHORT[phase]}
                </span>
              </div>
              <div className="ll-mono truncate pl-[18px] text-[10px] opacity-80">{timing || ' '}</div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
