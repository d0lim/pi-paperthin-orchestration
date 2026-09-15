import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeJobs } from '../lib/metrics.mjs';

function job(phase, profile, extra = {}) {
  return { status: 'completed', metadata: { route: { phase, profile } }, startedAt: '2026-09-15T00:00:00Z', finishedAt: '2026-09-15T00:00:02Z', ...extra };
}

test('summaries group interpreted jobs by phase and profile without treating exit success as reviewed quality', () => {
  const summary = summarizeJobs([
    job('plan-review', 'fable', { runtimeError: true, usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, costUsd: 0.25 } }),
    job('implement', 'codex', { status: 'failed', modelVerified: true, usage: { inputTokens: 30, outputTokens: 10, cachedInputTokens: 12, totalTokens: 40 } }),
    job('code-review', 'opus', { usage: { inputTokens: 40, outputTokens: 0, totalTokens: 40, costUsd: 0 } }),
    job('code-review', 'opus', { status: 'cancelled', usage: null }),
  ]);
  assert.equal(summary.total.jobs, 4);
  assert.deepEqual(summary.total.statuses, { completed: 2, failed: 1, cancelled: 1 });
  assert.equal(summary.total.runtimeErrors, 1);
  assert.equal(summary.total.modelVerifiedJobs, 1);
  assert.deepEqual(summary.total.wallTime, { reportedTotalMs: 8000, reportedJobs: 4, unknownJobs: 0 });
  assert.deepEqual(summary.total.usage.costUsd, { reportedTotal: 0.25, reportedJobs: 2, unknownJobs: 2 });
  assert.deepEqual(summary.total.usage.cachedInputTokens, { reportedTotal: 12, reportedJobs: 1, unknownJobs: 3 });
  assert.equal(summary.byPhase.find(group => group.phase === 'code-review').jobs, 2);
  assert.equal(summary.byProfile.find(group => group.profile === 'opus').jobs, 2);
  assert.deepEqual(summary.byPhaseProfile.map(({ phase, profile, jobs }) => ({ phase, profile, jobs })), [
    { phase: 'plan-review', profile: 'fable', jobs: 1 }, { phase: 'implement', profile: 'codex', jobs: 1 }, { phase: 'code-review', profile: 'opus', jobs: 2 },
  ]);
  assert.equal(Object.hasOwn(summary.total, 'approved'), false);
});

test('unknown usage and cost stay unknown; explicit zeros remain reported values', () => {
  const summary = summarizeJobs([job('implement', 'codex'), job('implement', 'codex', { usage: { inputTokens: 0, outputTokens: NaN, totalTokens: -1, costUsd: '1.2' } })]);
  assert.deepEqual(summary.total.usage.inputTokens, { reportedTotal: 0, reportedJobs: 1, unknownJobs: 1 });
  for (const field of ['outputTokens', 'cachedInputTokens', 'totalTokens', 'costUsd']) {
    assert.deepEqual(summary.total.usage[field], { reportedTotal: null, reportedJobs: 0, unknownJobs: 2 });
  }
});

test('running wall time uses supplied observation time; queued and malformed timestamps stay unknown', () => {
  const summary = summarizeJobs([
    job('implement', 'codex', { status: 'running', finishedAt: undefined }),
    job('implement', 'codex', { status: 'queued', startedAt: undefined, finishedAt: undefined }),
    job('implement', 'codex', { startedAt: 'invalid' }),
    job('implement', 'codex', { finishedAt: '2026-09-14T00:00:00Z' }),
    job('implement', 'codex', { finishedAt: undefined }),
  ], { now: Date.parse('2026-09-15T00:00:03Z') });
  assert.deepEqual(summary.total.wallTime, { reportedTotalMs: 3000, reportedJobs: 1, unknownJobs: 4 });
});

test('missing routes and unsafe object property names are data and do not corrupt summary counters', () => {
  const summary = summarizeJobs([{ status: '__proto__' }, { status: 'constructor', metadata: { route: { phase: '__proto__', profile: 'constructor' } } }]);
  assert.equal(summary.total.statuses.__proto__, 1);
  assert.equal(summary.total.statuses.constructor, 1);
  assert.deepEqual(summary.byPhase.map(group => group.phase), ['unknown', '__proto__']);
  assert.equal(summary.byProfile[1].profile, 'constructor');
  assert.equal(Object.getPrototypeOf(summary.total.statuses), Object.prototype);
});

test('empty summaries have no observations and invalid collections fail clearly', () => {
  const summary = summarizeJobs([]);
  assert.equal(summary.total.jobs, 0);
  assert.deepEqual(summary.byPhase, []);
  assert.equal(summary.total.usage.costUsd.reportedTotal, null);
  for (const value of [null, {}, [null], [[]]]) assert.throws(() => summarizeJobs(value), /array/);
  assert.throws(() => summarizeJobs([], { now: NaN }), /timestamp/);
});
