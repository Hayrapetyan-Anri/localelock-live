import { linkClick } from '../lib/router';
import { Wordmark } from '../components/Header';

export function NotFoundPage({ path }: { path: string }) {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-4 bg-bg p-8 text-center">
      <Wordmark />
      <div className="text-[28px] font-bold text-text">No page at {path}</div>
      <p className="m-0 text-muted">LocaleLock Live has two routes: the release dashboard and the judge page.</p>
      <div className="flex gap-3">
        <a href="/" onClick={linkClick('/')} className="rounded-lg border border-accent bg-accent px-4 py-2 font-semibold text-[#06121f] no-underline">
          Open release dashboard
        </a>
        <a href="/judge" onClick={linkClick('/judge')} className="rounded-lg border border-border bg-raised px-4 py-2 font-semibold text-text no-underline">
          Judge page
        </a>
      </div>
    </main>
  );
}
