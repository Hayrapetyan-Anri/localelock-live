import { phaseLabel } from '../lib/format';
import type { ReleaseRun, ReleaseState } from '../types';
import { RunStepper } from './RunStepper';
import { Button, Spinner } from './ui';

export interface BannerModel {
  state: ReleaseState;
  blockerCount: number;
  phase: string | null;
  message: string | null;
  hint: string | null;
  runId: string | null;
  origin: 'seed_baseline' | 'release_gate' | null;
  version: number;
}

export function bannerModel(
  run: ReleaseRun | null,
  fallback: { state: ReleaseState; blocker_count: number; version: number; origin: 'seed_baseline' | 'release_gate' } | null,
): BannerModel {
  if (run) {
    return {
      state: run.release_state,
      blockerCount: run.blocker_count,
      phase: run.phase,
      message: run.error?.message ?? null,
      hint: run.error?.hint ?? null,
      runId: run.run_id,
      origin: run.origin,
      version: run.version,
    };
  }
  if (fallback) {
    return { state: fallback.state, blockerCount: fallback.blocker_count, phase: null, message: null, hint: null, runId: null, origin: fallback.origin, version: fallback.version };
  }
  return { state: 'HELD', blockerCount: 0, phase: null, message: null, hint: null, runId: null, origin: null, version: 7 };
}

export function StatusBanner({ model, run, onRetry, retrying }: { model: BannerModel; run: ReleaseRun | null; onRetry?: () => void; retrying?: boolean }) {
  const plural = (n: number) => `${n} blocker${n === 1 ? '' : 's'}`;
  const styles: Record<ReleaseState, { wrap: string; text: string; label: string; sub: string }> = {
    HELD: {
      wrap: 'border-held/50 bg-held/10',
      text: 'text-held',
      label: `RELEASE HELD - ${plural(model.blockerCount)}`,
      sub: model.origin === 'seed_baseline' ? 'Intake baseline - run the live release gate' : `Persisted release run · ${model.runId ?? ''}`.trim(),
    },
    RUNNING: {
      wrap: 'border-running/50 bg-running/10',
      text: 'text-running',
      label: 'RUNNING',
      sub: model.phase ? `Phase: ${phaseLabel(model.phase)}` : 'Starting',
    },
    READY: {
      wrap: 'border-ready/50 bg-ready/10 ll-glow',
      text: 'text-ready',
      label: `READY TO RELEASE - ${plural(model.blockerCount)}`,
      sub: `Recheck run · ${model.runId ?? ''} · approved v${model.version}`.trim(),
    },
    FAILED: {
      wrap: 'border-held/50 bg-held/10',
      text: 'text-held',
      label: 'FAILED',
      sub: `${model.phase && model.message ? '' : ''}${model.message ?? 'The release gate run failed'}${model.hint ? ` · ${model.hint}` : ''}`,
    },
  };
  const s = styles[model.state];
  return (
    <section role="status" aria-live="polite" className={`ll-card grid grid-cols-[minmax(0,1fr)_minmax(0,440px)] items-center gap-5 border px-5 py-2.5 ${s.wrap}`}>
      <div className="min-w-0">
        <div className="text-[10.5px] font-semibold tracking-[0.12em] text-muted uppercase">Release status · The Last Tram · es · v{model.version}</div>
        <div className={`flex items-center gap-3 text-[40px] leading-[1.08] font-extrabold tracking-tight ${s.text}`}>
          {model.state === 'RUNNING' && <Spinner className="h-6 w-6 border-[3px]" />}
          <span className={model.state === 'RUNNING' ? 'll-pulse' : ''}>{s.label}</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="truncate text-[12.5px] text-muted" title={s.sub}>
            {s.sub}
          </div>
          {model.state === 'FAILED' && onRetry && (
            <Button variant="danger" size="sm" onClick={onRetry} loading={retrying}>
              Retry
            </Button>
          )}
        </div>
      </div>
      <RunStepper run={run} />
    </section>
  );
}
