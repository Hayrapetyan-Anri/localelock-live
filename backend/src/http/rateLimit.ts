import { ApiError } from './errors.js';
import type { HttpRequest } from './router.js';

export interface RateLimitRule {
  name: string;
  limit: number;
  windowMs: number;
}

export const RUN_LIMITS = {
  perCaller: { name: 'release-gate runs', limit: Number(process.env.RUN_LIMIT_PER_CALLER ?? 5), windowMs: 10 * 60_000 },
  global: { name: 'release-gate runs (all callers)', limit: Number(process.env.RUN_LIMIT_GLOBAL ?? 40), windowMs: 60 * 60_000 },
} satisfies Record<string, RateLimitRule>;

export const RESET_LIMITS = {
  perCaller: { name: 'demo resets', limit: Number(process.env.RESET_LIMIT_PER_CALLER ?? 10), windowMs: 10 * 60_000 },
} satisfies Record<string, RateLimitRule>;

const buckets = new Map<string, number[]>();

export function callerKey(req: HttpRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  const ip = fwd ? fwd.split(',')[0]!.trim() : (req.headers['x-real-ip'] ?? '');
  return ip || 'unknown';
}

function hit(key: string, rule: RateLimitRule, now: number): { ok: boolean; retryAfterMs: number } {
  const cutoff = now - rule.windowMs;
  const seen = (buckets.get(key) ?? []).filter((t) => t > cutoff);
  if (seen.length >= rule.limit) {
    const retryAfterMs = Math.max(1000, seen[0]! + rule.windowMs - now);
    buckets.set(key, seen);
    return { ok: false, retryAfterMs };
  }
  seen.push(now);
  buckets.set(key, seen);
  if (buckets.size > 500) {
    for (const [k, v] of buckets) if (v.every((t) => t <= cutoff)) buckets.delete(k);
  }
  return { ok: true, retryAfterMs: 0 };
}

export function enforce(req: HttpRequest, scope: string, rules: RateLimitRule[]): void {
  const now = Date.now();
  const caller = callerKey(req);
  for (const rule of rules) {
    const key = rule.name.includes('all callers') ? `${scope}:global` : `${scope}:${caller}`;
    const { ok, retryAfterMs } = hit(key, rule, now);
    if (!ok) {
      const seconds = Math.ceil(retryAfterMs / 1000);
      throw new ApiError(
        429,
        'RATE_LIMITED',
        `Too many ${rule.name} from this demo. This is a public, cost-capped deployment - try again in ${seconds < 60 ? `${seconds} s` : `${Math.ceil(seconds / 60)} min`}, or run it locally from the repository.`,
        { retry_after_ms: retryAfterMs, limit: rule.limit, window_ms: rule.windowMs },
      );
    }
  }
}

export function resetRateLimits(): void {
  buckets.clear();
}
