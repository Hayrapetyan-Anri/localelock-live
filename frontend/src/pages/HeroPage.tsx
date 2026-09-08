import { useMemo } from 'react';
import { ActionBar } from '../components/ActionBar';
import { DecisionReceipt } from '../components/DecisionReceipt';
import { DemoKeyDialog } from '../components/DemoKeyDialog';
import { ErrorState, LoadingState } from '../components/ErrorState';
import { EvidenceCard } from '../components/EvidenceCard';
import { Footer } from '../components/Footer';
import { Header } from '../components/Header';
import { IncomingEventCard } from '../components/IncomingEventCard';
import { RuntimeProofPanel } from '../components/RuntimeProofPanel';
import { bannerModel, StatusBanner } from '../components/StatusBanner';
import { useDemo } from '../hooks/useDemo';
import type { Finding } from '../types';

const RULE_ORDER: Record<string, number> = { TIMING_OVERLAP: 1, READING_SPEED: 2, GLOSSARY_DRIFT: 3, SEMANTIC_REVERSAL: 4 };

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => a.priority - b.priority || (RULE_ORDER[a.rule_id] ?? 9) - (RULE_ORDER[b.rule_id] ?? 9) || a.cue_id - b.cue_id);
}

export function HeroPage() {
  const demo = useDemo();
  const { state, gateRun, recheckRun, activeRun } = demo;

  const findings = useMemo(() => sortFindings(gateRun?.findings ?? []), [gateRun]);
  const openFindings = findings.filter((f) => f.status === 'open');
  const approvedCount = openFindings.filter((f) => demo.approvals[f.finding_id]).length;
  const runningRun = activeRun && activeRun.phase !== 'complete' && activeRun.phase !== 'failed' ? activeRun : null;
  const gateRunning = !!runningRun;
  const banner = bannerModel(activeRun, state?.release ?? null);
  const cleared = !!gateRun?.approval && recheckRun?.phase === 'complete' && recheckRun.release_state === 'READY';

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <Header state={state} />
      {demo.loading && !state ? (
        <LoadingState />
      ) : demo.loadError && !state ? (
        <main className="flex flex-1 items-center justify-center p-6">
          <ErrorState error={demo.loadError} onRetry={demo.reload} retrying={demo.loading} />
        </main>
      ) : state ? (
        <main className="flex min-h-0 flex-1 gap-2.5 p-2.5">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5">
            <StatusBanner
              model={banner}
              run={activeRun}
              onRetry={banner.state === 'FAILED' ? (activeRun && recheckRun && activeRun.run_id === recheckRun.run_id ? demo.exportAndRecheck : demo.runGate) : undefined}
              retrying={demo.action !== 'idle'}
            />
            <IncomingEventCard state={state} onRun={demo.runGate} running={gateRunning} starting={demo.action === 'starting_run'} disabled={demo.action !== 'idle'} />
            {cleared ? (
              <div className="ll-scroll min-h-0 flex-1 overflow-y-auto">
                <DecisionReceipt gateRun={gateRun!} recheckRun={recheckRun!} state={state} />
              </div>
            ) : (
            <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-2.5" aria-label="Evidence cards">
              {findings.length > 0 ? (
                findings.slice(0, 4).map((f) => (
                  <EvidenceCard
                    key={f.finding_id}
                    finding={f}
                    approved={demo.approvals[f.finding_id] === true}
                    onApprove={(v) => demo.setApproval(f.finding_id, v)}
                    approvable={demo.canApprove}
                    approvedVersion={gateRun?.approval?.approved_version ?? state.approved_version}
                  />
                ))
              ) : (
                <div className="ll-card col-span-2 row-span-2 flex flex-col items-center justify-center gap-2 border-dashed text-center">
                  {gateRunning ? (
                    <>
                      <div className="text-[20px] font-semibold text-running">Release gate running</div>
                      <div className="text-[13px] text-muted">Findings appear here as soon as the deterministic QC phase writes them.</div>
                    </>
                  ) : activeRun?.release_state === 'READY' ? (
                    <>
                      <div className="text-[20px] font-semibold text-ready">0 findings - nothing to repair</div>
                      <div className="text-[13px] text-muted">The recheck ran the same MCP query plan against v{activeRun.version} and found no blockers.</div>
                      <div className="text-[12.5px] text-muted">Reset the demo from the footer to run the whole decision again.</div>
                    </>
                  ) : (
                    <>
                      <div className="text-[20px] font-semibold text-text">No findings loaded</div>
                      <div className="text-[13px] text-muted">Run the release gate to evaluate The Last Tram v{state.delivery.version}.</div>
                    </>
                  )}
                </div>
              )}
            </div>
            )}
            <ActionBar
              gateRun={gateRun}
              recheckRun={recheckRun}
              approvedCount={approvedCount}
              openCount={openFindings.length}
              allApproved={demo.allApproved}
              canApprove={demo.canApprove}
              action={demo.action}
              polling={demo.polling}
              error={demo.actionError && demo.actionError.context !== 'resetting' ? demo.actionError : null}
              onExport={demo.exportAndRecheck}
              onDismissError={demo.clearActionError}
            />
            {demo.actionError?.context === 'resetting' && (
              <div className="shrink-0">
                <ErrorState error={demo.actionError.error} onRetry={demo.actionError.retry} retrying={demo.action === 'resetting'} compact />
              </div>
            )}
          </div>
          <RuntimeProofPanel gateRun={gateRun} recheckRun={recheckRun} health={demo.health} datasetRows={state.dataset.synthetic_rows_total} catalog={demo.catalog} />
        </main>
      ) : null}
      <Footer onReset={demo.reset} resetting={demo.action === 'resetting'} disabled={demo.action !== 'idle' && demo.action !== 'resetting'} />
      {demo.needsDemoKey && <DemoKeyDialog error={demo.demoKeyError} onSubmit={demo.submitDemoKey} onCancel={demo.cancelDemoKey} busy={demo.action === 'resetting'} />}
    </div>
  );
}
