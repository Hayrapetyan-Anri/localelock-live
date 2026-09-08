export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US');
}

export function fmtTimecode(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(Math.round(ms));
  const h = Math.floor(abs / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const s = Math.floor((abs % 60_000) / 1000);
  const milli = abs % 1000;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  const mmm = String(milli).padStart(3, '0');
  return h > 0 ? `${sign}${h}:${mm}:${ss}.${mmm}` : `${sign}${mm}:${ss}.${mmm}`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function fmtDeltaMs(ms: number): string {
  const sign = ms > 0 ? '+' : ms < 0 ? '−' : '';
  return `${sign}${fmtInt(Math.abs(ms))} ms`;
}

export function fmtCountdown(ms: number): string {
  if (ms <= 0) return '0s';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function fmtRelative(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '-';
  const diff = nowMs - t;
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60_000);
  let text: string;
  if (abs < 60_000) text = 'moments';
  else if (minutes < 60) text = `${minutes}m`;
  else if (minutes < 24 * 60) text = `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
  else {
    const days = Math.floor(minutes / (24 * 60));
    const hours = Math.floor((minutes % (24 * 60)) / 60);
    text = hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  return diff >= 0 ? `${text} ago` : `in ${text}`;
}

export function fmtClock(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '-';
  return new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function fmtDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '-';
  return new Date(t).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return '-';
  return `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%`;
}

export function shortHash(hash: string, n = 12): string {
  if (!hash) return '-';
  return hash.length > n ? `${hash.slice(0, n)}…` : hash;
}

export function safeJson(value: unknown, space = 2): string {
  try {
    return JSON.stringify(value, null, space) ?? 'null';
  } catch {
    return String(value);
  }
}

export function phaseLabel(phase: string): string {
  switch (phase) {
    case 'event_received':
      return 'Event received';
    case 'querying_clickhouse':
      return 'Querying ClickHouse (MCP)';
    case 'deterministic_qc':
      return 'Deterministic QC';
    case 'gemini_semantic_review':
      return 'Gemini semantic review';
    case 'producer_decision':
      return 'Producer decision';
    case 'complete':
      return 'Complete';
    case 'failed':
      return 'Failed';
    default:
      return phase;
  }
}

export function ruleLabel(rule: string): string {
  switch (rule) {
    case 'TIMING_OVERLAP':
      return 'Timing overlap';
    case 'READING_SPEED':
      return 'Reading speed';
    case 'GLOSSARY_DRIFT':
      return 'Glossary drift';
    case 'SEMANTIC_REVERSAL':
      return 'Semantic reversal';
    default:
      return rule;
  }
}

export function repairKindLabel(kind: string): string {
  switch (kind) {
    case 'trim_out_time':
      return 'Trim out-time';
    case 'extend_out_time':
      return 'Extend out-time';
    case 'replace_text':
      return 'Replace text';
    default:
      return kind;
  }
}
