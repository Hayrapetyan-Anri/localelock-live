import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiRequestError, readStoredDemoKey, storeDemoKey, toApiError } from '../lib/api';
import type { ApprovalRequest, DemoState, HealthResponse, ReleaseRun, RunPhase,
  CatalogRisk,
} from '../types';

export const POLL_INTERVAL_MS = 1200;
const REVIEWER = 'Producer (demo)';

export type ActionKind = 'idle' | 'starting_run' | 'approving' | 'rechecking' | 'resetting';

export interface ActionFailure {
  error: ApiRequestError;
  retry: () => void;
  context: ActionKind | 'polling';
}

export interface DemoController {
  state: DemoState | null;
  gateRun: ReleaseRun | null;
  recheckRun: ReleaseRun | null;
  activeRun: ReleaseRun | null;
  loading: boolean;
  loadError: ApiRequestError | null;
  reload: () => void;
  polling: boolean;
  action: ActionKind;
  actionError: ActionFailure | null;
  clearActionError: () => void;
  approvals: Record<string, boolean>;
  setApproval: (findingId: string, value: boolean) => void;
  allApproved: boolean;
  canApprove: boolean;
  runGate: () => void;
  exportAndRecheck: () => void;
  reset: () => void;
  needsDemoKey: boolean;
  demoKeyError: string | null;
  submitDemoKey: (key: string) => void;
  cancelDemoKey: () => void;
  health: HealthResponse | null;
  catalog: CatalogRisk | null;
}

export function isTerminalPhase(phase: RunPhase): boolean {
  return phase === 'complete' || phase === 'failed';
}

export function isRecheckRun(run: ReleaseRun): boolean {
  return run.trigger === 'recheck_after_approval' || run.parent_run_id !== null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function useDemo(): DemoController {
  const [state, setState] = useState<DemoState | null>(null);
  const [gateRun, setGateRunState] = useState<ReleaseRun | null>(null);
  const [recheckRun, setRecheckRunState] = useState<ReleaseRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<ApiRequestError | null>(null);
  const [polling, setPolling] = useState(false);
  const [action, setAction] = useState<ActionKind>('idle');
  const [actionError, setActionError] = useState<ActionFailure | null>(null);
  const [approvals, setApprovals] = useState<Record<string, boolean>>({});
  const [needsDemoKey, setNeedsDemoKey] = useState(false);
  const [demoKeyError, setDemoKeyError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [catalog, setCatalog] = useState<CatalogRisk | null>(null);

  const gateRef = useRef<ReleaseRun | null>(null);
  const recheckRef = useRef<ReleaseRun | null>(null);
  const genRef = useRef(0);
  const mountedRef = useRef(true);

  const setGateRun = useCallback((run: ReleaseRun | null) => {
    gateRef.current = run;
    setGateRunState(run);
  }, []);
  const setRecheckRun = useCallback((run: ReleaseRun | null) => {
    recheckRef.current = run;
    setRecheckRunState(run);
  }, []);

  const placeRun = useCallback(
    (run: ReleaseRun) => {
      if (isRecheckRun(run)) setRecheckRun(run);
      else setGateRun(run);
    },
    [setGateRun, setRecheckRun],
  );

  const pollRun = useCallback(
    async (runId: string): Promise<ReleaseRun | null> => {
      const gen = genRef.current;
      setPolling(true);
      let failures = 0;
      try {
        for (;;) {
          let run: ReleaseRun;
          try {
            run = await api.getRun(runId);
            failures = 0;
          } catch (e) {
            failures += 1;
            if (failures >= 4) throw e;
            await sleep(POLL_INTERVAL_MS);
            if (gen !== genRef.current) return null;
            continue;
          }
          if (gen !== genRef.current) return null;
          placeRun(run);
          if (isTerminalPhase(run.phase)) return run;
          await sleep(POLL_INTERVAL_MS);
          if (gen !== genRef.current) return null;
        }
      } finally {
        if (gen === genRef.current && mountedRef.current) setPolling(false);
      }
    },
    [placeRun],
  );

  const refreshState = useCallback(async () => {
    const gen = genRef.current;
    try {
      const st = await api.demoState();
      if (gen !== genRef.current) return;
      setState(st);
      const lr = st.latest_run;
      if (lr) {
        if (isRecheckRun(lr)) {
          if (recheckRef.current?.run_id === lr.run_id) setRecheckRun(lr);
        } else if (gateRef.current?.run_id === lr.run_id) {
          setGateRun(lr);
        }
      }
    } catch {
    }
  }, [setGateRun, setRecheckRun]);

  const applyLoadedState = useCallback(
    async (st: DemoState) => {
      setState(st);
      const lr = st.latest_run;
      let gate: ReleaseRun | null = null;
      let recheck: ReleaseRun | null = null;
      if (lr) {
        if (isRecheckRun(lr)) {
          recheck = lr;
          if (lr.parent_run_id) {
            try {
              gate = await api.getRun(lr.parent_run_id);
            } catch {
              gate = null;
            }
          }
        } else {
          gate = lr;
          if (lr.recheck_run_id) {
            try {
              recheck = await api.getRun(lr.recheck_run_id);
            } catch {
              recheck = null;
            }
          }
        }
      }
      setGateRun(gate);
      setRecheckRun(recheck);
      setApprovals({});
      const active = recheck ?? gate;
      if (active && !isTerminalPhase(active.phase)) {
        void pollRun(active.run_id).then((done) => {
          if (done) void refreshState();
        });
      }
    },
    [pollRun, refreshState, setGateRun, setRecheckRun],
  );

  const load = useCallback(async () => {
    genRef.current += 1;
    setLoading(true);
    setLoadError(null);
    setActionError(null);
    setPolling(false);
    try {
      const st = await api.demoState();
      await applyLoadedState(st);
    } catch (e) {
      setLoadError(toApiError(e));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [applyLoadedState]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    api
      .health(false)
      .then((h) => {
        if (mountedRef.current) setHealth(h);
      })
      .catch(() => undefined);
    api
      .catalogRisk()
      .then((c) => {
        if (mountedRef.current) setCatalog(c);
      })
      .catch(() => undefined);
    return () => {
      mountedRef.current = false;
      genRef.current += 1;
    };
  }, [load]);

  const fail = useCallback((e: unknown, context: ActionFailure['context'], retry: () => void) => {
    setActionError({ error: toApiError(e), context, retry });
  }, []);

  const runGate = useCallback(() => {
    if (action !== 'idle') return;
    setAction('starting_run');
    setActionError(null);
    void (async () => {
      const gen = genRef.current;
      try {
        const created = await api.createRun({ trigger: 'vendor_delivery' });
        if (gen !== genRef.current) return;
        setRecheckRun(null);
        setApprovals({});
        setAction('idle');
        const done = await pollRun(created.run_id);
        if (done) await refreshState();
      } catch (e) {
        if (gen !== genRef.current) return;
        setAction('idle');
        fail(e, 'starting_run', runGate);
      }
    })();
  }, [action, fail, pollRun, refreshState, setRecheckRun]);

  const exportAndRecheck = useCallback(() => {
    if (action !== 'idle') return;
    const startingRun = gateRef.current;
    if (!startingRun) return;
    setActionError(null);
    void (async () => {
      const gen = genRef.current;
      let run = startingRun;
      try {
        if (!run.approval) {
          setAction('approving');
          const body: ApprovalRequest = {
            reviewer: REVIEWER,
            decisions: run.findings
              .filter((f) => f.status === 'open')
              .map((f) => ({ finding_id: f.finding_id, decision: 'approve' as const })),
          };
          try {
            const resp = await api.approvals(run.run_id, body);
            if (gen !== genRef.current) return;
            run = resp.run.approval ? resp.run : { ...resp.run, approval: resp.approval };
            setGateRun(run);
          } catch (e) {
            const err = toApiError(e);
            if (err.code !== 'APPROVAL_IN_PROGRESS') throw err;
            for (let i = 0; i < 40; i += 1) {
              await sleep(POLL_INTERVAL_MS);
              if (gen !== genRef.current) return;
              const fresh = await api.getRun(run.run_id);
              if (gen !== genRef.current) return;
              setGateRun(fresh);
              if (fresh.approval) {
                run = fresh;
                break;
              }
            }
            if (!run.approval) throw err;
          }
        }
        setAction('rechecking');
        const rc = await api.recheck(run.run_id);
        if (gen !== genRef.current) return;
        setGateRun({ ...run, recheck_run_id: rc.run_id });
        setAction('idle');
        const done = await pollRun(rc.run_id);
        if (done) await refreshState();
      } catch (e) {
        if (gen !== genRef.current) return;
        setAction('idle');
        fail(e, run.approval ? 'rechecking' : 'approving', exportAndRecheck);
      }
    })();
  }, [action, fail, pollRun, refreshState, setGateRun]);

  const doReset = useCallback(
    async (key: string | undefined, fromPrompt: boolean) => {
      setAction('resetting');
      setActionError(null);
      try {
        const resp = await api.reset(key);
        genRef.current += 1;
        setPolling(false);
        setNeedsDemoKey(false);
        setDemoKeyError(null);
        if (key) storeDemoKey(key);
        await applyLoadedState(resp.state);
        setAction('idle');
      } catch (e) {
        const err = toApiError(e);
        setAction('idle');
        if (err.code === 'UNAUTHORIZED') {
          const stored = readStoredDemoKey();
          if (!key && stored) {
            await doReset(stored, false);
            return;
          }
          setDemoKeyError(fromPrompt || key ? 'That key was rejected. Try again.' : null);
          setNeedsDemoKey(true);
          return;
        }
        fail(err, 'resetting', () => void doReset(undefined, false));
      }
    },
    [applyLoadedState, fail],
  );

  const reset = useCallback(() => {
    if (action !== 'idle') return;
    void doReset(undefined, false);
  }, [action, doReset]);

  const submitDemoKey = useCallback(
    (key: string) => {
      const trimmed = key.trim();
      if (!trimmed) return;
      void doReset(trimmed, true);
    },
    [doReset],
  );

  const cancelDemoKey = useCallback(() => {
    setNeedsDemoKey(false);
    setDemoKeyError(null);
  }, []);

  const setApproval = useCallback((findingId: string, value: boolean) => {
    setApprovals((prev) => ({ ...prev, [findingId]: value }));
  }, []);

  const clearActionError = useCallback(() => setActionError(null), []);

  const openFindings = useMemo(() => (gateRun?.findings ?? []).filter((f) => f.status === 'open'), [gateRun]);
  const allApproved = openFindings.length > 0 && openFindings.every((f) => approvals[f.finding_id] === true);
  const canApprove =
    !!gateRun &&
    gateRun.origin === 'release_gate' &&
    gateRun.phase === 'complete' &&
    gateRun.release_state === 'HELD' &&
    !gateRun.approval;

  const activeRun = recheckRun ?? gateRun;

  return {
    state,
    gateRun,
    recheckRun,
    activeRun,
    loading,
    loadError,
    reload: () => void load(),
    polling,
    action,
    actionError,
    clearActionError,
    approvals,
    setApproval,
    allApproved,
    canApprove,
    runGate,
    exportAndRecheck,
    reset,
    needsDemoKey,
    demoKeyError,
    submitDemoKey,
    cancelDemoKey,
    health,
    catalog,
  };
}
