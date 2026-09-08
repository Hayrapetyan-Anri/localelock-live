import type {
  ApiError,
  ApprovalRequest,
  CatalogRisk,
  DeliveryRisk,
  ApprovalResponse,
  CreateRunRequest,
  CreateRunResponse,
  DemoState,
  HealthResponse,
  JudgeStatus,
  RecheckResponse,
  ReleaseRun,
  ResetResponse,
} from '../types';

export const API_BASE: string = (() => {
  const raw = (import.meta.env.VITE_API_BASE as string | undefined)?.trim();
  if (raw) return raw.replace(/\/+$/, '');
  return '/api';
})();

export type ApiErrorCode = ApiError['error']['code'] | 'NETWORK' | 'BAD_RESPONSE';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;
  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function toApiError(e: unknown): ApiRequestError {
  if (e instanceof ApiRequestError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new ApiRequestError(0, 'NETWORK', message || 'Unknown error');
}

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

async function request<T>(method: 'GET' | 'POST', path: string, opts: RequestOptions = {}): Promise<T> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const retryable = method === 'GET';
  let res: Response;
  let attempt = 0;
  for (;;) {
    try {
      res = await fetch(url, { method, headers, body, signal: opts.signal, cache: 'no-store' });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      if (retryable && attempt === 0) {
        attempt += 1;
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      throw new ApiRequestError(0, 'NETWORK', `Could not reach the API at ${url}. Is the backend running?`);
    }
    if (retryable && attempt === 0 && (res.status === 502 || res.status === 503 || res.status === 504)) {
      attempt += 1;
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    break;
  }
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    if (json && typeof json === 'object' && 'error' in json) {
      const err = (json as ApiError).error;
      if (err && typeof err === 'object' && typeof err.message === 'string') {
        throw new ApiRequestError(res.status, err.code ?? 'INTERNAL', err.message, err.details);
      }
    }
    const fallbackCode: ApiErrorCode =
      res.status === 404 ? 'NOT_FOUND' : res.status === 401 ? 'UNAUTHORIZED' : res.status === 429 ? 'RATE_LIMITED' : 'INTERNAL';
    throw new ApiRequestError(res.status, fallbackCode, `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} from ${path}`);
  }
  if (json === null || typeof json !== 'object') {
    throw new ApiRequestError(res.status, 'BAD_RESPONSE', `The API returned a non-JSON response for ${path}.`);
  }
  return json as T;
}

const enc = (s: string) => encodeURIComponent(s);

export const api = {
  demoState: (signal?: AbortSignal) => request<DemoState>('GET', '/demo/state', { signal }),
  getRun: (runId: string, signal?: AbortSignal) => request<ReleaseRun>('GET', `/runs/${enc(runId)}`, { signal }),
  createRun: (body: CreateRunRequest = {}) => request<CreateRunResponse>('POST', '/runs', { body }),
  approvals: (runId: string, body: ApprovalRequest) =>
    request<ApprovalResponse>('POST', `/runs/${enc(runId)}/approvals`, { body }),
  recheck: (runId: string) => request<RecheckResponse>('POST', `/runs/${enc(runId)}/recheck`, { body: {} }),
  reset: (demoKey?: string) =>
    request<ResetResponse>('POST', '/admin/reset', {
      body: {},
      headers: demoKey ? { 'X-Demo-Key': demoKey } : undefined,
    }),
  health: (deep: boolean, signal?: AbortSignal) =>
    request<HealthResponse>('GET', deep ? '/health?deep=1' : '/health', { signal }),
  judgeStatus: (signal?: AbortSignal) => request<JudgeStatus>('GET', '/judge/status', { signal }),
  catalogRisk: (signal?: AbortSignal) => request<CatalogRisk>('GET', '/catalog/risk', { signal }),
  deliveryRisk: (title_id: string, locale: string, version: number, signal?: AbortSignal) =>
    request<DeliveryRisk>('GET', `/catalog/deliveries/${enc(title_id)}/${enc(locale)}/${version}/cues`, { signal }),
  exportSrtUrl: (runId: string, relative?: string) => `${API_BASE}${relative ?? `/runs/${enc(runId)}/export.srt`}`,
};

export interface ErrorPresentation {
  title: string;
  message: string;
  retryable: boolean;
}

export function describeApiError(e: unknown): ErrorPresentation {
  const err = toApiError(e);
  const detail = err.message && err.message !== err.code ? err.message : '';
  const withDetail = (lead: string) => (detail ? `${lead} ${detail}` : lead);
  switch (err.code) {
    case 'NETWORK':
      return { title: 'API unreachable', message: withDetail('The request never reached the API.'), retryable: true };
    case 'BAD_RESPONSE':
      return { title: 'Unexpected response', message: withDetail('The API answered with something that is not JSON.'), retryable: true };
    case 'NOT_FOUND':
      return { title: 'Not found', message: withDetail('The run or resource does not exist any more.'), retryable: true };
    case 'BAD_REQUEST':
      return { title: 'Request rejected', message: withDetail('The API rejected the request as invalid.'), retryable: true };
    case 'RUN_NOT_COMPLETE':
      return { title: 'Run still in progress', message: withDetail('The release gate has not finished yet; wait for it to complete before approving.'), retryable: true };
    case 'RUN_NOT_HELD':
      return { title: 'Nothing to approve', message: withDetail('This run is not in a HELD state, so there are no repairs to approve.'), retryable: true };
    case 'DECISIONS_INCOMPLETE':
      return { title: 'Decisions incomplete', message: withDetail('Every open finding needs a decision before export.'), retryable: true };
    case 'REJECTED':
      return { title: 'Repair rejected', message: withDetail('A repair was rejected, so the release stays HELD and nothing was ingested.'), retryable: false };
    case 'APPROVAL_IN_PROGRESS':
      return { title: 'Approval already in progress', message: withDetail('Another approval for this run is being processed; the page will pick up its result.'), retryable: true };
    case 'NOT_APPROVED':
      return { title: 'Not approved yet', message: withDetail('This run has no approval, so a recheck cannot start.'), retryable: true };
    case 'UNAUTHORIZED':
      return { title: 'Demo key required', message: withDetail('This action needs the demo admin key (X-Demo-Key).'), retryable: true };
    case 'RATE_LIMITED':
      return { title: 'Cooling down', message: withDetail('Reset is rate-limited; try again in a few seconds.'), retryable: true };
    case 'GEMINI_NOT_CONFIGURED':
      return { title: 'Gemini not configured', message: withDetail('The API has no Vertex AI credentials (or API key), so the agent cannot run.'), retryable: true };
    case 'INTERNAL':
    default:
      return { title: 'API error', message: withDetail(`The API reported an internal error${err.status ? ` (HTTP ${err.status})` : ''}.`), retryable: true };
  }
}

const DEMO_KEY_STORAGE = 'localelock.demoKey';

export function readStoredDemoKey(): string | null {
  try {
    return window.localStorage.getItem(DEMO_KEY_STORAGE);
  } catch {
    return null;
  }
}

export function storeDemoKey(key: string | null): void {
  try {
    if (key) window.localStorage.setItem(DEMO_KEY_STORAGE, key);
    else window.localStorage.removeItem(DEMO_KEY_STORAGE);
  } catch {
  }
}
