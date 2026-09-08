import { useEffect, useRef, useState } from 'react';
import { Button } from './ui';

export function DemoKeyDialog({ error, onSubmit, onCancel, busy }: { error: string | null; onSubmit: (key: string) => void; onCancel: () => void; busy: boolean }) {
  const [key, setKey] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="demo-key-title">
      <form
        className="ll-card flex w-[420px] flex-col gap-3 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(key);
        }}
      >
        <div id="demo-key-title" className="text-[18px] font-bold text-text">
          Demo admin key required
        </div>
        <p className="m-0 text-[13px] text-muted">The API answered 401 for reset. Enter the X-Demo-Key; it is kept in this browser only.</p>
        <input
          ref={inputRef}
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className="ll-mono h-10 rounded-lg border border-border bg-bg px-3 text-[14px] text-text outline-none focus:border-accent"
          placeholder="X-Demo-Key"
          aria-label="Demo admin key"
        />
        {error && (
          <div className="text-[12.5px] font-semibold text-held" role="alert">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!key.trim()}>
            Reset demo
          </Button>
        </div>
      </form>
    </div>
  );
}
