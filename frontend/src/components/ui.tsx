import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type Tone = 'held' | 'ready' | 'running' | 'gemini' | 'accent' | 'muted' | 'warning' | 'neutral';

const chipTone: Record<Tone, string> = {
  held: 'bg-held/15 text-held border-held/40',
  ready: 'bg-ready/15 text-ready border-ready/40',
  running: 'bg-running/15 text-running border-running/40',
  warning: 'bg-running/15 text-running border-running/50',
  gemini: 'bg-gemini/15 text-gemini border-gemini/40',
  accent: 'bg-accent/12 text-accent border-accent/40',
  muted: 'bg-raised text-muted border-border',
  neutral: 'bg-raised text-text border-border',
};

export function Chip({
  tone = 'neutral',
  children,
  className = '',
  title,
  mono = false,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
  mono?: boolean;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-[1px] text-[11px] font-semibold leading-[16px] tracking-wide whitespace-nowrap ${chipTone[tone]} ${mono ? 'll-mono' : ''} ${className}`}
    >
      {children}
    </span>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`ll-spin inline-block h-3.5 w-3.5 rounded-full border-2 border-current border-r-transparent ${className}`}
    />
  );
}

type ButtonVariant = 'primary' | 'success' | 'ghost' | 'danger';

const buttonVariant: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-[#06121f] border-accent hover:bg-[#5cc9f7] disabled:bg-accent/35 disabled:border-accent/10 disabled:text-[#06121f]/70',
  success:
    'bg-ready text-[#04140a] border-ready hover:bg-[#3ad374] disabled:bg-ready/30 disabled:border-ready/10 disabled:text-[#04140a]/70',
  danger: 'bg-held/15 text-held border-held/50 hover:bg-held/25 disabled:opacity-50',
  ghost: 'bg-raised text-text border-border hover:border-muted/60 hover:bg-[#1b2742] disabled:opacity-50',
};

export function Button({
  variant = 'ghost',
  loading = false,
  size = 'md',
  children,
  className = '',
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  loading?: boolean;
  size?: 'sm' | 'md' | 'lg';
}) {
  const sizes = {
    sm: 'h-7 px-2.5 text-[12px] rounded-md',
    md: 'h-9 px-3.5 text-[13px] rounded-lg',
    lg: 'h-11 px-5 text-[15px] rounded-lg',
  }[size];
  return (
    <button
      type="button"
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={`ll-btn inline-flex items-center justify-center gap-2 border font-semibold whitespace-nowrap select-none ${sizes} ${buttonVariant[variant]} ${className}`}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled = false,
  labelOn,
  labelOff,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  labelOn: string;
  labelOff: string;
  id?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`ll-btn group inline-flex h-8 items-center gap-2 rounded-full border pr-3 pl-1 text-[12.5px] font-semibold ${
        checked ? 'border-ready/60 bg-ready/15 text-ready' : 'border-border bg-raised text-text hover:border-muted/70'
      } disabled:opacity-60`}
    >
      <span
        aria-hidden
        className={`relative inline-block h-5 w-9 rounded-full transition-colors duration-100 ${checked ? 'bg-ready' : 'bg-[#2b3852]'}`}
      >
        <span
          className={`absolute top-0.5 left-0 h-4 w-4 rounded-full bg-white shadow transition-transform duration-100 ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
        />
      </span>
      {checked ? labelOn : labelOff}
    </button>
  );
}

export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className = '',
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="ll-btn flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left text-[12px] text-muted hover:text-text"
      >
        <span aria-hidden className={`inline-block w-3 text-[10px] transition-transform duration-100 ${open ? 'rotate-90' : ''}`}>
          ▶
        </span>
        <span className="min-w-0 flex-1">{summary}</span>
      </button>
      {open && <div className="ll-rise mt-1.5">{children}</div>}
    </div>
  );
}

export function SectionLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`text-[11px] font-semibold tracking-[0.08em] text-muted uppercase ${className}`}>{children}</div>;
}

export function KeyValue({ k, v, mono = false }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[12px]">
      <span className="text-muted">{k}</span>
      <span className={`truncate text-right text-text ${mono ? 'll-mono' : ''}`}>{v}</span>
    </div>
  );
}
