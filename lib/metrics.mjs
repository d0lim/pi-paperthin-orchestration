const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'totalTokens', 'costUsd'];

function nonnegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function measured() { return { reportedTotal: null, reportedJobs: 0, unknownJobs: 0 }; }

function addMeasured(metric, value) {
  if (nonnegative(value)) {
    metric.reportedTotal = (metric.reportedTotal ?? 0) + value;
    metric.reportedJobs += 1;
  } else metric.unknownJobs += 1;
}

function summary() {
  return {
    jobs: 0, statuses: {}, runtimeErrors: 0, modelVerifiedJobs: 0,
    wallTime: { reportedTotalMs: null, reportedJobs: 0, unknownJobs: 0 },
    usage: Object.fromEntries(USAGE_FIELDS.map(key => [key, measured()])),
  };
}

function elapsed(job, now) {
  if (!job.startedAt) return null;
  const start = Date.parse(job.startedAt);
  const end = job.finishedAt ? Date.parse(job.finishedAt) : job.status === 'running' ? now : NaN;
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

function add(target, job, now) {
  target.jobs += 1;
  const status = typeof job.status === 'string' && job.status ? job.status : 'unknown';
  Object.defineProperty(target.statuses, status, { value: (Object.hasOwn(target.statuses, status) ? target.statuses[status] : 0) + 1, enumerable: true, configurable: true });
  if (job.runtimeError === true) target.runtimeErrors += 1;
  if (job.modelVerified === true) target.modelVerifiedJobs += 1;
  const duration = elapsed(job, now);
  if (duration === null) target.wallTime.unknownJobs += 1;
  else {
    target.wallTime.reportedTotalMs = (target.wallTime.reportedTotalMs ?? 0) + duration;
    target.wallTime.reportedJobs += 1;
  }
  for (const field of USAGE_FIELDS) addMeasured(target.usage[field], job.usage?.[field]);
}

function group(map, key, labels) {
  if (!map.has(key)) map.set(key, { ...labels, ...summary() });
  return map.get(key);
}

/** Sums reported job observations only; missing model usage is never priced or treated as zero. */
export function summarizeJobs(jobs, { now = Date.now() } = {}) {
  if (!Array.isArray(jobs) || jobs.some(job => !job || typeof job !== 'object' || Array.isArray(job))) throw new TypeError('jobs must be an array of interpreted job objects.');
  if (!Number.isFinite(now)) throw new TypeError('now must be a finite timestamp in milliseconds.');
  const total = summary();
  const phases = new Map();
  const profiles = new Map();
  const pairs = new Map();
  for (const job of jobs) {
    const route = job.metadata?.route;
    const phase = typeof route?.phase === 'string' && route.phase ? route.phase : 'unknown';
    const profile = typeof route?.profile === 'string' && route.profile ? route.profile : 'unknown';
    add(total, job, now);
    add(group(phases, phase, { phase }), job, now);
    add(group(profiles, profile, { profile }), job, now);
    add(group(pairs, JSON.stringify([phase, profile]), { phase, profile }), job, now);
  }
  return { total, byPhase: [...phases.values()], byProfile: [...profiles.values()], byPhaseProfile: [...pairs.values()] };
}
