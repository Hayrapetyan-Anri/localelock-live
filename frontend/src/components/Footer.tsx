import { API_BASE } from '../lib/api';
import { linkClick } from '../lib/router';
import { SYNTHETIC_DISCLAIMER } from '../types';
import { Button } from './ui';

export function Footer({ onReset, resetting, disabled }: { onReset: () => void; resetting: boolean; disabled: boolean }) {
  return (
    <footer className="flex h-8 shrink-0 items-center gap-4 border-t border-border px-4 text-[11.5px] text-muted">
      <span className="truncate">{SYNTHETIC_DISCLAIMER}</span>
      <span className="ll-mono ml-auto hidden xl:inline">API {API_BASE}</span>
      <a href="/judge" onClick={linkClick('/judge')} className="font-semibold text-accent hover:underline">
        Judge page
      </a>
      <Button size="sm" variant="ghost" onClick={onReset} loading={resetting} disabled={disabled} title="POST /admin/reset - restores the seeded HELD/4 baseline">
        Reset demo
      </Button>
    </footer>
  );
}
