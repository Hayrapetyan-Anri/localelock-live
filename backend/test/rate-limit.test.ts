import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RESET_LIMITS, RUN_LIMITS, callerKey, enforce, resetRateLimits } from '../src/http/rateLimit.js';
import { ApiError } from '../src/http/errors.js';
import type { HttpRequest } from '../src/http/router.js';

function req(ip: string): HttpRequest {
  return { method: 'POST', path: '/runs', query: {}, headers: { 'x-forwarded-for': ip }, body: null, baseUrl: null };
}

beforeEach(() => resetRateLimits());

test('caller identity comes from the forwarded client IP', () => {
  assert.equal(callerKey(req('203.0.113.7, 70.132.1.1')), '203.0.113.7');
  assert.equal(callerKey({ ...req('x'), headers: {} }), 'unknown');
});

test('a caller is cut off after the per-caller limit, with a retryable 429', () => {
  const rule = RUN_LIMITS.perCaller;
  for (let i = 0; i < rule.limit; i++) enforce(req('198.51.100.1'), 'runs', [rule]);
  try {
    enforce(req('198.51.100.1'), 'runs', [rule]);
    assert.fail('expected the next call to be refused');
  } catch (err) {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 429);
    assert.equal(err.code, 'RATE_LIMITED');
    assert.match(err.message, /public, cost-capped deployment/);
    assert.ok((err.details as { retry_after_ms: number }).retry_after_ms > 0);
  }
});

test('limits are per caller, so one heavy user cannot lock everyone out', () => {
  const rule = RUN_LIMITS.perCaller;
  for (let i = 0; i < rule.limit; i++) enforce(req('198.51.100.2'), 'runs', [rule]);
  assert.doesNotThrow(() => enforce(req('198.51.100.3'), 'runs', [rule]), 'a different caller still gets through');
});

test('the global cap bounds total spend across every caller', () => {
  const rule = { name: 'release-gate runs (all callers)', limit: 3, windowMs: 60_000 };
  for (let i = 0; i < rule.limit; i++) enforce(req(`10.0.0.${i}`), 'runs', [rule]);
  assert.throws(() => enforce(req('10.0.0.99'), 'runs', [rule]), /Too many/);
});

test('reset has its own budget, separate from gate runs', () => {
  for (let i = 0; i < RESET_LIMITS.perCaller.limit; i++) enforce(req('192.0.2.5'), 'reset', [RESET_LIMITS.perCaller]);
  assert.throws(() => enforce(req('192.0.2.5'), 'reset', [RESET_LIMITS.perCaller]), /Too many demo resets/);
  assert.doesNotThrow(() => enforce(req('192.0.2.5'), 'runs', [RUN_LIMITS.perCaller]), 'gate runs are a separate bucket');
});
