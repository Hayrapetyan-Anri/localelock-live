import { useCountdown } from '../hooks/useCountdown';
import { fmtCountdown } from '../lib/format';
import { linkClick } from '../lib/router';
import { HERO_LOCALE_NAME, HERO_VERSION, SYNTHETIC_DISCLAIMER, TITLE_NAME, type DemoState } from '../types';
import { Chip } from './ui';

export function Wordmark() {
  return (
    <a href="/" onClick={linkClick('/')} className="flex items-center gap-2 no-underline" aria-label="LocaleLock Live home">
      <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="7" fill="#16213A" stroke="#24304A" />
        <rect x="7" y="14" width="18" height="12" rx="3" fill="#38BDF8" />
        <path d="M11 14v-3a5 5 0 0 1 10 0v3" fill="none" stroke="#38BDF8" strokeWidth="3" />
        <circle cx="16" cy="20" r="2.2" fill="#0B1220" />
      </svg>
      <span className="text-[15px] font-bold tracking-tight text-text">
        LocaleLock <span className="text-accent">Live</span>
      </span>
    </a>
  );
}

export function Header({ state }: { state: DemoState | null }) {
  const remaining = useCountdown(state?.delivery.release_at ?? null, state?.now ?? null);
  const titleName = state?.title.name ?? TITLE_NAME;
  const localeName = state?.delivery.locale_name ?? HERO_LOCALE_NAME;
  const version = state?.delivery.version ?? HERO_VERSION;
  const late = remaining !== null && remaining <= 0;
  const urgent = remaining !== null && remaining > 0 && remaining < 30 * 60_000;

  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-border bg-surface/80 px-4 backdrop-blur">
      <Wordmark />
      <div className="hidden h-6 w-px bg-border lg:block" aria-hidden />
      <div className="flex min-w-0 items-center gap-2 text-[14px]">
        <span className="truncate font-semibold text-text">{titleName}</span>
        <span className="text-muted">·</span>
        <span className="truncate text-text">{localeName}</span>
        <span className="text-muted">·</span>
        <span className="ll-mono rounded-md border border-border bg-raised px-1.5 py-[1px] text-[12.5px] font-semibold text-text">v{version}</span>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <div
          className="ll-tnum flex items-center gap-2 rounded-lg border border-border bg-raised px-3 py-1 text-[13px]"
          title={state ? `Release window opens ${new Date(state.delivery.release_at).toLocaleString()}` : undefined}
        >
          <span className="text-muted">{late ? 'Release window' : 'Release in'}</span>
          <span className={`ll-mono font-semibold ${late ? 'text-running' : urgent ? 'text-held' : 'text-text'}`}>
            {remaining === null ? '-' : late ? 'open' : fmtCountdown(remaining)}
          </span>
        </div>
        <Chip tone="warning" title={SYNTHETIC_DISCLAIMER} className="max-w-[360px] !whitespace-normal !leading-[14px]">
          <span aria-hidden>◈</span> {SYNTHETIC_DISCLAIMER}
        </Chip>
        <a href="/judge" onClick={linkClick('/judge')} className="text-[12.5px] font-semibold text-accent hover:underline">
          /judge
        </a>
      </div>
    </header>
  );
}
