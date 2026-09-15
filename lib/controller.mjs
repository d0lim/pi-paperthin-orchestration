import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildManagedLaunch as buildLaunch, interpretJob, routeTask as selectRoute } from './routing.mjs';

const TERMINAL = new Set(['completed', 'failed', 'timed_out', 'cancelled']);

/** Bind executor-owned results to the persistent workflow; never accept a pasted approval. */
export function submitWorkflowJob({ params, store, jobs, configCwd, routeTask = selectRoute, buildManagedLaunch = buildLaunch }) {
  if (!['implement', 'review'].includes(params.task)) throw new Error('Managed workflow accepts implement or review tasks.');
  if (!params.runId || !params.phase) throw new Error('Implementation and review require runId and phase. Use workflow_run first.');
  const route = routeTask({ ...params, configCwd });
  if (route.requiresBillingAuthorization) throw new Error('Fable headless usage credits require routing.allowFableHeadless authorization.');
  const prepared = store.prepareAttempt(params.runId, { phase: params.phase, taskId: params.taskId, runtime: route.runtime, model: route.model });
  let job;
  try {
    if (params.cwd && path.resolve(params.cwd) !== path.resolve(prepared.cwd)) throw new Error('cwd must match the workflow-owned checkout.');
    const reviewTarget = params.task === 'review'
      ? { planSha256: prepared.planSha256, baseSha: prepared.baseSha ?? null, candidateSha: prepared.candidateSha ?? null } : undefined;
    let workflowContext;
    if (prepared.planSnapshotPath) {
      const plan = readFileSync(prepared.planSnapshotPath, 'utf8');
      if (createHash('sha256').update(plan).digest('hex') !== prepared.planSha256) throw new Error('Stored plan snapshot hash changed.');
      if (Buffer.byteLength(plan) > 256 * 1024) throw new Error('Plan snapshot exceeds the 256 KiB handoff limit. Split the plan before dispatch.');
      workflowContext = { runId: params.runId, taskId: params.taskId ?? null, attemptId: prepared.attemptId,
        phase: params.phase, cwd: prepared.cwd, planSha256: prepared.planSha256,
        baseSha: prepared.baseSha, candidateSha: prepared.candidateSha,
        files: prepared.files ?? [], checks: prepared.checks ?? [], planSnapshot: plan };
    }
    const launch = buildManagedLaunch({ ...params, cwd: prepared.cwd, configCwd, reviewTarget, workflowContext });
    if (launch.route.runtime !== route.runtime || launch.route.provider !== route.provider || launch.route.model !== route.model || launch.route.profile !== route.profile || launch.route.effort !== route.effort) throw new Error('Route changed after preparation. Inspect configuration before retrying.');
    const workflow = { runId: params.runId, taskId: params.taskId ?? null, phase: params.phase, attemptId: prepared.attemptId };
    job = jobs.submit({ launch, label: params.label, metadata: { route: launch.route, sources: launch.sources, reviewTarget, workflow } });
    store.bindAttempt(params.runId, prepared.attemptId, { jobId: job.id, runtime: route.runtime, model: route.model, paths: job.paths });
    return { id: job.id, status: job.status, route: launch.route, paths: job.paths, workflow,
      next: 'workflow_jobs get/wait collects the actual result and updates workflow_run. Process completion is not approval.' };
  } catch (error) {
    if (job) {
      try { jobs.cancel(job.id); } catch { /* Preserve the primary error and owned job identity. */ }
      error.jobId = job.id;
      // A launched process may still be closing. Retain its reservation until recovery.
    } else {
      store.abortAttempt(params.runId, prepared.attemptId, { reason: error.message });
    }
    throw error;
  }
}

export function collectWorkflowJob(job, store) {
  const result = interpretJob(job);
  const binding = job.metadata?.workflow;
  if (binding && TERMINAL.has(job.status)) {
    if (!store) throw new Error('Owned workflow store is required to collect this job.');
    const state = store.settleAttempt(binding.runId, binding.attemptId, result);
    return { ...result, workflow: { ...binding, status: state.status } };
  }
  return result;
}
