import { API_BASE, describeApiError, type ApiRequestError } from '../lib/api';
import { Button } from './ui';

export function ErrorState({ error, onRetry, retrying = false, compact = false }: { error: ApiRequestError; onRetry: () => void; retrying?: boolean; compact?: boolean }) {
  const p = describeApiError(error);
  return (
    <div role="alert" className={`ll-card mx-auto flex max-w-[640px] flex-col items-start gap-2 border-held/50 ${compact ? 'p-4' : 'p-6'}`}>
      <div className="text-[11px] font-semibold tracking-[0.12em] text-held uppercase">API error · {error.code}{error.status ? ` · HTTP ${error.status}` : ''}</div>
      <div className={`${compact ? 'text-[18px]' : 'text-[24px]'} leading-tight font-bold text-text`}>{p.title}</div>
      <p className="m-0 text-[13.5px] text-text/90">{p.message}</p>
      <p className="ll-mono m-0 text-[11.5px] text-muted">API base: {API_BASE}. Nothing is shown from fixtures - the page only renders live API data.</p>
      <Button variant="danger" onClick={onRetry} loading={retrying}>
        Retry
      </Button>
    </div>
  );
}

export function LoadingState({ label = 'Loading demo state…' }: { label?: string }) {
  return (
    <div className="flex flex-1 items-center justify-center text-[14px] text-muted" role="status" aria-live="polite">
      <span className="ll-spin mr-3 inline-block h-4 w-4 rounded-full border-2 border-accent border-r-transparent" aria-hidden />
      {label}
    </div>
  );
}
