import type { ActionFailure, ActionKind } from '../hooks/useDemo';
import { api, describeApiError } from '../lib/api';
import { fmtInt, shortHash } from '../lib/format';
import type { ReleaseRun } from '../types';
import { Button, Chip } from './ui';

export function ActionBar({
  gateRun,
  recheckRun,
  approvedCount,
  openCount,
  allApproved,
  canApprove,
  action,
  polling,
  error,
  onExport,
  onDismissError,
}: {
  gateRun: ReleaseRun | null;
  recheckRun: ReleaseRun | null;
  approvedCount: number;
  openCount: number;
  allApproved: boolean;
  canApprove: boolean;
  action: ActionKind;
  polling: boolean;
  error: ActionFailure | null;
  onExport: () => void;
  onDismissError: () => void;
}) {
  const approval = gateRun?.approval ?? null;
  const recheckRunning = !!recheckRun && recheckRun.phase !== 'complete' && recheckRun.phase !== 'failed';
  const recheckReady = recheckRun?.phase === 'complete' && recheckRun.release_state === 'READY';
  const recheckFailed = recheckRun?.phase === 'failed';
  const busy = action === 'approving' || action === 'rechecking';

  let buttonLabel = 'Export corrected SRT and recheck';
  let buttonDisabled = !(canApprove && allApproved);
  if (action === 'approving') buttonLabel = 'Ingesting approved version…';
  else if (action === 'rechecking') buttonLabel = 'Starting recheck…';
  else if (approval && recheckRunning) {
    buttonLabel = 'Recheck running…';
    buttonDisabled = true;
  } else if (approval && recheckReady) {
    buttonLabel = 'Recheck complete';
    buttonDisabled = true;
  } else if (approval && (recheckFailed || !recheckRun)) {
    buttonLabel = recheckFailed ? 'Retry recheck' : 'Run recheck';
    buttonDisabled = false;
  }

  const presented = error ? describeApiError(error.error) : null;

  return (
    <section className="ll-card flex flex-col gap-2 px-4 py-2" aria-label="Producer actions">
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          {approval ? (
            <div className="ll-rise flex flex-wrap items-center gap-2 text-[13px]">
              <Chip tone="ready">Approved v{approval.approved_version} ingested</Chip>
              <span className="ll-mono text-text">
                patch <span className="font-semibold text-ready">{shortHash(approval.patch_hash)}</span>
              </span>
              <span className="text-muted">
                · {fmtInt(approval.srt.cue_count)} cues · {fmtInt(approval.srt.bytes)} bytes · {approval.ingested.subtitle_cues} cues + {approval.ingested.source_target_pairs} pairs written
              </span>
              <a
                href={api.exportSrtUrl(approval.run_id, approval.srt.url)}
                download={approval.srt.filename}
                target="_blank"
                rel="noreferrer"
                className="ll-btn inline-flex h-7 items-center gap-1.5 rounded-md border border-accent/50 bg-accent/10 px-2.5 text-[12px] font-semibold text-accent no-underline hover:bg-accent/20"
              >
                <span aria-hidden>⤓</span> Download SRT
              </a>
              <span className="ll-mono truncate text-[11px] text-muted" title={approval.srt.filename}>
                {approval.srt.filename}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-3 text-[13px]">
              <span className="ll-tnum font-semibold text-text">
                {approvedCount} of {openCount} repairs approved
              </span>
              <span className="text-muted">
                {canApprove
                  ? allApproved
                    ? 'All repairs approved - export writes v8 deterministically, then a real MCP recheck runs.'
                    : 'Approve every repair to enable export. The semantic correction needs your explicit approval.'
                  : gateRun?.origin === 'seed_baseline'
                    ? 'Run the live release gate first; approvals apply to a live run.'
                    : gateRun?.release_state === 'RUNNING'
                      ? 'Waiting for the release gate to finish…'
                      : 'Nothing to approve.'}
              </span>
            </div>
          )}
          {recheckReady && (
            <div className="mt-1 text-[12.5px] text-ready">
              Recheck {recheckRun.run_id} finished with {recheckRun.finding_count} findings · {recheckRun.blocker_count} blockers - v{recheckRun.version} is READY.
            </div>
          )}
        </div>
        <Button
          variant="success"
          size="lg"
          onClick={onExport}
          disabled={buttonDisabled || busy || (polling && !approval)}
          loading={busy}
          className="min-w-[280px]"
        >
          {buttonLabel}
        </Button>
      </div>
      {presented && error && (
        <div role="alert" className="ll-rise flex items-center gap-3 rounded-md border border-held/50 bg-held/10 px-3 py-2 text-[12.5px]">
          <span className="font-semibold text-held">{presented.title}</span>
          <span className="min-w-0 flex-1 truncate text-text" title={presented.message}>
            {presented.message}
          </span>
          <span className="ll-mono text-[11px] text-muted">{error.error.code}</span>
          {presented.retryable && (
            <Button size="sm" variant="danger" onClick={error.retry}>
              Retry
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onDismissError}>
            Dismiss
          </Button>
        </div>
      )}
    </section>
  );
}
