import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowStore } from '../lib/workflow-state.mjs';
import { JobManager } from '../lib/jobs.mjs';

const moduleUrl = new URL('../lib/workflow-state.mjs', import.meta.url).href;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function terminal(manager, id) {
  let job;
  do { job = await manager.wait(id); } while (['queued', 'running'].includes(job.status));
  return job;
}
function crashed(code) {
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', code], { stdio: 'pipe' }), error => error.status === 17);
}


const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const checkArgv = [process.execPath, '-e', 'process.exit(0)'];
function fixture(t, { maxAttempts = 3 } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'paperthin-state-'));
  const cwd = path.join(directory, 'repo'); mkdirSync(cwd);
  git(cwd, 'init', '-q', '-b', 'main'); git(cwd, 'config', 'user.name', 'Workflow Test'); git(cwd, 'config', 'user.email', 'test@example.invalid');
  mkdirSync(path.join(cwd, 'src')); writeFileSync(path.join(cwd, 'src/a.txt'), 'a\n'); writeFileSync(path.join(cwd, 'src/b.txt'), 'b\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'Fixture base');
  const planPath = path.join(directory, 'plan.md'); writeFileSync(planPath, '# Approved scope\nImplement isolated tasks.\n');
  const store = new WorkflowStore({ cwd, maxAttempts });
  t.after(async () => { await store.close(); rmSync(directory, { recursive: true, force: true }); });
  const run = store.start({ planPath });
  return { store, runId: run.runId, planPath, cwd, directory };
}
function bind(store, runId, attempt) {
  const route = { runtime: attempt.phase === 'implement' ? 'codex' : 'claude', model: attempt.phase === 'plan_review' ? 'fable' : attempt.phase === 'implement' ? 'sol' : 'opus', phase: attempt.phase };
  const job = { id: `job-${attempt.attemptId}`, status: 'completed', exitCode: 0, runtimeError: false, modelVerified: true, reportedModels: [route.model], mismatchedModels: [], permissionDenials: [], metadata: { route } };
  store.bindAttempt(runId, attempt.attemptId, job);
  return job;
}
function review(store, runId, { phase = 'plan_review', taskId, verdict = 'approve', mutate = value => value } = {}) {
  const attempt = store.prepareAttempt(runId, { phase, ...(taskId ? { taskId } : {}) });
  const job = bind(store, runId, attempt);
  job.reviewResult = { phase, planSha256: attempt.planSha256, baseSha: attempt.baseSha, candidateSha: attempt.candidateSha, verdict,
    findings: verdict === 'approve' ? [] : [{ severity: 'blocking', message: 'Revise the specified behavior.' }] };
  return { attempt, job, result: store.settleAttempt(runId, attempt.attemptId, mutate(job)) };
}
async function implement(store, runId, taskId, files) {
  const attempt = store.prepareAttempt(runId, { phase: 'implement', taskId });
  const job = bind(store, runId, attempt);
  for (const [file, content] of Object.entries(files)) { mkdirSync(path.dirname(path.join(attempt.cwd, file)), { recursive: true }); writeFileSync(path.join(attempt.cwd, file), content); }
  git(attempt.cwd, 'add', '--', ...Object.keys(files)); git(attempt.cwd, 'commit', '-qm', `Implement ${taskId}`);
  assert.equal(store.settleAttempt(runId, attempt.attemptId, job).status, 'succeeded');
  const task = store.freezeTask(runId, taskId);
  assert.equal((await store.recordChecks(runId, { taskId, argv: checkArgv })).status, 'passed');
  return task;
}

test('real Git workflow gates planning, implementation, checks, independent review and final verification', async t => {
  const { store, runId, cwd } = fixture(t);
  const originalSha = git(cwd, 'rev-parse', 'HEAD');
  const task = store.addTask(runId, { taskId: 'feature', files: ['src/a.txt'] });
  assert.notEqual(task.worktree, cwd);
  assert.throws(() => store.prepareAttempt(runId, { phase: 'implement', taskId: 'feature' }), /plan approval/);
  assert.equal(review(store, runId).result.status, 'succeeded');
  assert.throws(() => store.prepareAttempt(runId, { phase: 'code_review', taskId: 'feature' }), /Candidate SHA/);
  const candidate = await implement(store, runId, 'feature', { 'src/a.txt': 'implemented\n' });
  assert.throws(() => store.integrate(runId), /code review approval/);
  const reviewed = review(store, runId, { phase: 'code_review', taskId: 'feature' });
  assert.equal(reviewed.result.status, 'succeeded');
  assert.deepEqual(store.settleAttempt(runId, reviewed.attempt.attemptId, reviewed.job), reviewed.result);
  const integration = store.integrate(runId);
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), originalSha);
  assert.equal(readFileSync(path.join(integration.worktree, 'src/a.txt'), 'utf8'), 'implemented\n');
  assert.equal(git(integration.worktree, 'merge-base', '--is-ancestor', candidate.candidateSha, 'HEAD'), '');
  assert.throws(() => store.complete(runId), /passing checks/);
  assert.equal((await store.recordChecks(runId, { argv: checkArgv })).status, 'passed');
  assert.throws(() => store.complete(runId), /final integration code review/);
  assert.equal(review(store, runId, { phase: 'code_review' }).result.status, 'succeeded');
  assert.equal(store.complete(runId).status, 'completed');
  const persisted = JSON.parse(readFileSync(store.file, 'utf8')).runs[runId];
  assert.equal(persisted.approvals.length, 3); assert.equal(persisted.integration.finalCheckIds.length, 1);
});

test('changed plan invalidates old approvals and cannot be reviewed through stale attempt evidence', async t => {
  const { store, runId, planPath } = fixture(t);
  review(store, runId); store.addTask(runId, { taskId: 'a', files: ['src/a.txt'] });
  const firstApproval = store.get(runId).approvals[0];
  writeFileSync(planPath, '# Different plan\n');
  assert.throws(() => store.prepareAttempt(runId, { phase: 'implement', taskId: 'a' }), /Plan changed/);
  const updated = store.snapshotPlan(runId);
  assert.notEqual(updated.plan.sha256, firstApproval.planSha256);
  assert.equal(updated.plan.approvalId, null); assert.deepEqual(updated.approvals[0], firstApproval);
  assert.throws(() => store.prepareAttempt(runId, { phase: 'implement', taskId: 'a' }), /plan approval/);
  const attempt = store.prepareAttempt(runId, { phase: 'plan_review' }); const job = bind(store, runId, attempt);
  job.reviewResult = { phase: 'plan_review', planSha256: firstApproval.planSha256, baseSha: null, candidateSha: null, verdict: 'approve', findings: [] };
  assert.equal(store.settleAttempt(runId, attempt.attemptId, job).status, 'failed');
  assert.equal(store.get(runId).plan.approvalId, null);
});

test('process success, verified-model evidence and structured approval are distinct gates', async t => {
  const { store, runId } = fixture(t, { maxAttempts: 5 });
  for (const change of [job => { delete job.reviewResult; }, job => { job.modelVerified = false; }, job => { job.runtimeError = true; }, job => { job.permissionDenials = [{}]; }]) {
    const result = review(store, runId, { mutate: job => { change(job); return job; } }).result;
    assert.equal(result.status, 'failed'); assert.equal(store.get(runId).plan.approvalId, null);
    assert.throws(() => store.prepareAttempt(runId, { phase: 'plan_review' }), /explicit recovery/);
    store.recoverTask(runId, { reason: 'Inspected saved mock process evidence and confirmed no live job remains.' });
  }
  assert.equal(review(store, runId).result.status, 'succeeded');
});

test('candidate must be clean, stay inside ownership, and have matching recorded checks', async t => {
  const { store, runId } = fixture(t); review(store, runId);
  const task = store.addTask(runId, { taskId: 'a', files: ['src/a.txt'] });
  const attempt = store.prepareAttempt(runId, { phase: 'implement', taskId: 'a' }); const job = bind(store, runId, attempt);
  writeFileSync(path.join(task.worktree, 'src/a.txt'), 'a1\n');
  store.settleAttempt(runId, attempt.attemptId, job);
  assert.throws(() => store.freezeTask(runId, 'a'), /uncommitted/);
  git(task.worktree, 'add', 'src/a.txt'); git(task.worktree, 'commit', '-qm', 'Owned change'); store.freezeTask(runId, 'a');
  assert.throws(() => store.prepareAttempt(runId, { phase: 'code_review', taskId: 'a' }), /passing checks/);
  await store.recordChecks(runId, { taskId: 'a', argv: checkArgv });
  writeFileSync(path.join(task.worktree, 'src/b.txt'), 'outside\n'); git(task.worktree, 'add', 'src/b.txt'); git(task.worktree, 'commit', '-qm', 'Wrong ownership');
  assert.throws(() => store.prepareAttempt(runId, { phase: 'code_review', taskId: 'a' }), /Candidate SHA changed/);
  assert.throws(() => store.freezeTask(runId, 'a'), /outside the task ownership/);
});

test('approval arriving after candidate SHA changes is blocked and cannot integrate', async t => {
  const { store, runId } = fixture(t); review(store, runId);
  store.addTask(runId, { taskId: 'a', files: ['src/a.txt'] });
  const task = await implement(store, runId, 'a', { 'src/a.txt': 'candidate one\n' });
  const attempt = store.prepareAttempt(runId, { phase: 'code_review', taskId: 'a' }); const job = bind(store, runId, attempt);
  job.reviewResult = { phase: 'code_review', planSha256: attempt.planSha256, baseSha: attempt.baseSha, candidateSha: attempt.candidateSha, verdict: 'approve', findings: [] };
  writeFileSync(path.join(task.worktree, 'src/a.txt'), 'candidate two\n'); git(task.worktree, 'add', 'src/a.txt'); git(task.worktree, 'commit', '-qm', 'Late change');
  assert.equal(store.settleAttempt(runId, attempt.attemptId, job).status, 'failed');
  assert.equal(store.get(runId).tasks.a.approvalId, null);
  assert.throws(() => store.integrate(runId), /Candidate SHA changed/);
});

test('declared dependencies block start and bring approved ancestor code into a dedicated worktree', async t => {
  const { store, runId } = fixture(t); review(store, runId);
  store.addTask(runId, { taskId: 'a', files: ['src/a.txt'] });
  const dependent = store.addTask(runId, { taskId: 'b', files: ['src/b.txt'], dependsOn: ['a'] });
  assert.throws(() => store.prepareAttempt(runId, { phase: 'implement', taskId: 'b' }), /Candidate SHA/);
  await implement(store, runId, 'a', { 'src/a.txt': 'dependency behavior\n' });
  assert.throws(() => store.prepareAttempt(runId, { phase: 'implement', taskId: 'b' }), /code review approval/);
  review(store, runId, { phase: 'code_review', taskId: 'a' });
  const second = await implement(store, runId, 'b', { 'src/b.txt': 'uses dependency\n' });
  assert.equal(readFileSync(path.join(dependent.worktree, 'src/a.txt'), 'utf8'), 'dependency behavior\n');
  assert.notEqual(second.baseSha, store.get(runId).baseSha);
  review(store, runId, { phase: 'code_review', taskId: 'b' });
  assert.equal(store.integrate(runId).status, 'integrated');
});

test('ownership paths reject overlap, traversal, broad roots and simultaneous writers across runs', async t => {
  const { store, runId, planPath } = fixture(t); review(store, runId);
  store.addTask(runId, { taskId: 'a', files: ['src/a.txt'] });
  for (const files of [['src'], ['../other'], ['.'], ['.git/config'], ['src/*']]) assert.throws(() => store.addTask(runId, { taskId: 'bad', files }), /ownership|Ownership|Declare/);
  assert.throws(() => store.addTask(runId, { taskId: 'bad', files: ['src/b.txt'], dependsOn: ['missing'] }), /Unknown workflow task/);
  const second = store.start({ planPath }); review(store, second.runId); store.addTask(second.runId, { taskId: 'a', files: ['src/a.txt'] });
  const active = store.prepareAttempt(runId, { phase: 'implement', taskId: 'a' });
  assert.throws(() => store.prepareAttempt(second.runId, { phase: 'implement', taskId: 'a' }), /overlapping file paths/);
  assert.throws(() => store.prepareAttempt(runId, { phase: 'implement', taskId: 'a' }), /still owns/);
  store.abortAttempt(runId, active.attemptId, { reason: 'Queue was full before launch; no process was created.' });
  assert.equal(store.get(runId).tasks.a.status, 'blocked');
});

test('failed and cancelled partial work requires explicit inspection and stays bounded', async t => {
  const { store, runId } = fixture(t, { maxAttempts: 2 }); review(store, runId);
  const task = store.addTask(runId, { taskId: 'a', files: ['src/a.txt'] });
  for (const status of ['failed', 'cancelled']) {
    const attempt = store.prepareAttempt(runId, { phase: 'implement', taskId: 'a' }); const job = bind(store, runId, attempt);
    writeFileSync(path.join(task.worktree, 'src/a.txt'), `${status} partial work\n`);
    assert.equal(store.settleAttempt(runId, attempt.attemptId, { ...job, status, exitCode: 1 }).status, 'failed');
    assert.throws(() => store.prepareAttempt(runId, { phase: 'implement', taskId: 'a' }), /explicit recovery/);
    const recovery = store.recoverTask(runId, { taskId: 'a', reason: 'Inspected partial changes and saved logs; continue repairing these files.' });
    assert.match(recovery.worktreeStatus, /src\/a.txt/);
    assert.equal(readFileSync(path.join(task.worktree, 'src/a.txt'), 'utf8'), `${status} partial work\n`);
  }
  assert.throws(() => store.prepareAttempt(runId, { phase: 'implement', taskId: 'a' }), /Attempt limit/);
});

test('fresh controller blocks orphaned attempts without touching saved process IDs', async t => {
  const { store, runId, cwd } = fixture(t); await store.close();
  const moduleUrl = new URL('../lib/workflow-state.mjs', import.meta.url).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `import { WorkflowStore } from ${JSON.stringify(moduleUrl)}; const store = new WorkflowStore({cwd: ${JSON.stringify(cwd)}}); store.prepareAttempt(${JSON.stringify(runId)}, {phase:'plan_review'});`]);
  const restored = new WorkflowStore({ cwd });
  try {
    const run = restored.get(runId); assert.equal(run.attempts[0].status, 'blocked'); assert.equal(run.attempts[0].reason, 'orphaned_session');
    assert.equal(run.status, 'blocked'); assert.throws(() => restored.prepareAttempt(runId, { phase: 'plan_review' }), /explicit recovery/);
    restored.recoverTask(runId, { reason: 'Inspected previous controller exit and confirmed there is no child process.' });
    assert.equal(review(restored, runId).result.status, 'succeeded');
  } finally { await restored.close(); }
});

test('live controller cannot be stolen, and close persists blocked attempts for next session', async t => {
  const { store, runId, cwd } = fixture(t);
  assert.throws(() => new WorkflowStore({ cwd }), /Another live controller/);
  store.prepareAttempt(runId, { phase: 'plan_review' }); await store.close();
  const restored = new WorkflowStore({ cwd });
  try { assert.equal(restored.get(runId).attempts[0].reason, 'controller_closed'); assert.equal(restored.get(runId).status, 'blocked'); }
  finally { await restored.close(); }
});

test('check execution captures failures and rejects a zero-exit check that changes reviewed files', async t => {
  const { store, runId } = fixture(t); review(store, runId);
  store.addTask(runId, { taskId: 'a', files: ['src/a.txt'] }); await implement(store, runId, 'a', { 'src/a.txt': 'candidate\n' });
  const failure = await store.recordChecks(runId, { taskId: 'a', argv: [process.execPath, '-e', 'console.error("failure evidence");process.exit(1)'] });
  assert.equal(failure.status, 'failed'); assert.match(failure.stderr, /failure evidence/);
  assert.throws(() => store.prepareAttempt(runId, { phase: 'code_review', taskId: 'a' }), /passing checks/);
  const mutating = await store.recordChecks(runId, { taskId: 'a', argv: [process.execPath, '-e', 'require("node:fs").writeFileSync("src/a.txt", "changed by check")'] });
  assert.equal(mutating.exitCode, 0); assert.equal(mutating.status, 'failed');
});

test('review changes_requested opens an implementation correction and fresh code approval', async t => {
  const { store, runId } = fixture(t); review(store, runId);
  store.addTask(runId, { taskId: 'a', files: ['src/a.txt'] }); await implement(store, runId, 'a', { 'src/a.txt': 'first\n' });
  assert.equal(review(store, runId, { phase: 'code_review', taskId: 'a', verdict: 'changes_requested' }).result.status, 'changes_requested');
  assert.throws(() => store.integrate(runId), /code review approval/);
  await implement(store, runId, 'a', { 'src/a.txt': 'corrected\n' });
  assert.equal(review(store, runId, { phase: 'code_review', taskId: 'a' }).result.status, 'succeeded');
  assert.equal(store.get(runId).approvals.length, 3);
});

test('root checkout and final integration SHA cannot silently change after review', async t => {
  const { store, runId, cwd } = fixture(t); review(store, runId);
  store.addTask(runId, { taskId: 'a', files: ['src/a.txt'] }); await implement(store, runId, 'a', { 'src/a.txt': 'candidate\n' }); review(store, runId, { phase: 'code_review', taskId: 'a' });
  const integration = store.integrate(runId); await store.recordChecks(runId, { argv: checkArgv });
  writeFileSync(path.join(integration.worktree, 'src/a.txt'), 'changed after final check\n'); git(integration.worktree, 'add', 'src/a.txt'); git(integration.worktree, 'commit', '-qm', 'Unreviewed integration change');
  assert.throws(() => store.complete(runId), /Integration candidate changed/);
  writeFileSync(path.join(cwd, 'src/b.txt'), 'new root base\n'); git(cwd, 'add', 'src/b.txt'); git(cwd, 'commit', '-qm', 'Advanced root');
  assert.throws(() => store.integrate(runId), /checkout advanced/);
});

test('snapshotting a revised plan archives prior integration and allows new approvals and integration', async t => {
  const { store, runId, planPath } = fixture(t); review(store, runId);
  store.addTask(runId, { taskId: 'a', files: ['src/a.txt'] }); await implement(store, runId, 'a', { 'src/a.txt': 'candidate\n' }); review(store, runId, { phase: 'code_review', taskId: 'a' });
  const first = store.integrate(runId);
  writeFileSync(planPath, '# Revised scope\nKeep verified behavior.\n');
  const revised = store.snapshotPlan(runId);
  assert.equal(revised.integration, null); assert.equal(revised.integrationHistory[0].worktree, first.worktree);
  assert.equal(review(store, runId).result.status, 'succeeded');
  store.freezeTask(runId, 'a'); await store.recordChecks(runId, { taskId: 'a', argv: checkArgv }); review(store, runId, { phase: 'code_review', taskId: 'a' });
  const second = store.integrate(runId);
  assert.notEqual(second.worktree, first.worktree);
  await store.recordChecks(runId, { argv: checkArgv }); review(store, runId, { phase: 'code_review' });
  assert.equal(store.complete(runId).status, 'completed');
});

test('manual integration edits need fresh frozen SHA, checks and integration review', async t => {
  const { store, runId } = fixture(t); review(store, runId);
  store.addTask(runId, { taskId: 'a', files: ['src/a.txt'] }); await implement(store, runId, 'a', { 'src/a.txt': 'candidate\n' }); review(store, runId, { phase: 'code_review', taskId: 'a' });
  const integration = store.integrate(runId); await store.recordChecks(runId, { argv: checkArgv }); review(store, runId, { phase: 'code_review' });
  writeFileSync(path.join(integration.worktree, 'src/b.txt'), 'integration-only behavior\n'); git(integration.worktree, 'add', 'src/b.txt'); git(integration.worktree, 'commit', '-qm', 'Integration resolution');
  assert.throws(() => store.complete(runId), /Integration candidate changed/);
  assert.equal(store.integrate(runId).approvalId, null);
  assert.throws(() => store.prepareAttempt(runId, { phase: 'code_review' }), /passing checks/);
  await store.recordChecks(runId, { argv: checkArgv });
  assert.throws(() => store.complete(runId), /final integration code review/);
  review(store, runId, { phase: 'code_review' });
  assert.equal(store.complete(runId).status, 'completed');
});

test('check timeout cleans up descendants in its owned process group', async t => {
  if (process.platform === 'win32') return t.skip('POSIX process-group fixture');
  const { store, runId, directory } = fixture(t); review(store, runId);
  store.addTask(runId, { taskId: 'a', files: ['src/a.txt'] }); await implement(store, runId, 'a', { 'src/a.txt': 'candidate\n' });
  const sentinel = path.join(directory, 'descendant-survived.txt');
  const descendant = `process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'survived'), 1200);setInterval(()=>{},1000);`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
  const result = await store.recordChecks(runId, { taskId: 'a', argv: [process.execPath, '-e', parent], timeoutMs: 150 });
  assert.equal(result.status, 'failed'); assert.equal(result.jobStatus, 'timed_out'); assert.match(result.error, /exceeded/);
  execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1300)']);
  assert.throws(() => readFileSync(sentinel), /ENOENT/);
});


test('Git ownership compares literal leading whitespace paths, including legitimately declared names', async t => {
  for (const [owned, changed, accepted] of [['src/a.txt', ' src/a.txt', false], ['src/a.txt', '\nsrc/a.txt', false], [' src/a.txt', ' src/a.txt', true]]) {
    await t.test(JSON.stringify({ owned, changed }), async t => {
      const { store, runId } = fixture(t); review(store, runId);
      const task = store.addTask(runId, { taskId: 'literal', files: [owned] });
      const attempt = store.prepareAttempt(runId, { taskId: 'literal', phase: 'implement' }); const job = bind(store, runId, attempt);
      mkdirSync(path.dirname(path.join(task.worktree, changed)), { recursive: true }); writeFileSync(path.join(task.worktree, changed), 'exact filename\n');
      git(task.worktree, 'add', '--', changed); git(task.worktree, 'commit', '-qm', 'Literal path'); store.settleAttempt(runId, attempt.attemptId, job);
      if (accepted) assert.equal(store.freezeTask(runId, 'literal').candidateSha, git(task.worktree, 'rev-parse', 'HEAD'));
      else assert.throws(() => store.freezeTask(runId, 'literal'), /outside the task ownership/);
    });
  }
});

test('a long candidate check preserves sibling deadlines and successful exits', async t => {
  const { store, runId, directory, cwd } = fixture(t); review(store, runId);
  store.addTask(runId, { taskId: 'a', files: ['src/a.txt'] }); await implement(store, runId, 'a', { 'src/a.txt': 'candidate\n' });
  const jobs = new JobManager({ directory: path.join(directory, 'siblings'), timeoutMs: 1000 }); t.after(() => jobs.dispose());
  const check = store.recordChecks(runId, { taskId: 'a', argv: [process.execPath, '-e', 'setTimeout(()=>{},2600)'] });
  assert.equal(store.get(runId).checks.at(-1).status, 'running');
  // Submit after synchronous Git preflight. The check itself must leave these
  // event-loop deadlines responsive, independent of repository command latency.
  const marker = path.join(directory, 'late-sibling.txt');
  const late = jobs.submit({ launch: { runtime: process.execPath, cwd, args: ['-e', `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'late'),1900);setInterval(()=>{},1000)`] } });
  const success = jobs.submit({ launch: { runtime: process.execPath, cwd, args: ['-e', 'setTimeout(()=>process.exit(0),40)'] } });
  const [timedOut, completed] = await Promise.all([terminal(jobs, late.id), terminal(jobs, success.id)]);
  assert.equal(timedOut.status, 'timed_out'); assert.equal(completed.status, 'completed');
  assert.equal(store.get(runId).checks.at(-1).status, 'running');
  assert.equal((await check).status, 'passed'); assert.equal(existsSync(marker), false);
});

test('running checks reserve their target, allow independent tasks, and cancel through AbortSignal', async t => {
  const { store, runId } = fixture(t); review(store, runId);
  store.addTask(runId, { taskId: 'a', files: ['src/a.txt'] }); await implement(store, runId, 'a', { 'src/a.txt': 'a\nchanged\n' });
  store.addTask(runId, { taskId: 'b', files: ['src/b.txt'] }); await implement(store, runId, 'b', { 'src/b.txt': 'b\nchanged\n' });
  const controller = new AbortController();
  const promise = store.recordChecks(runId, { taskId: 'a', argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], signal: controller.signal });
  const running = store.get(runId).checks.at(-1); assert.equal(running.status, 'running'); assert.ok(running.paths.stdout); assert.ok(running.jobId);
  assert.throws(() => store.freezeTask(runId, 'a'), /still owns/);
  assert.throws(() => store.snapshotPlan(runId), /still owns/);
  assert.throws(() => store.integrate(runId), /still owns/);
  assert.throws(() => store.prepareAttempt(runId, { taskId: 'a', phase: 'implement' }), /still owns/);
  assert.equal((await store.recordChecks(runId, { taskId: 'b', argv: checkArgv })).status, 'passed');
  controller.abort(); const result = await promise;
  assert.equal(result.status, 'failed'); assert.equal(result.jobStatus, 'cancelled');
  assert.equal(JSON.parse(readFileSync(result.paths.result)).status, 'cancelled');
  assert.equal((await store.recordChecks(runId, { taskId: 'a', argv: checkArgv })).status, 'passed');
});

test('close waits for check cleanup before a replacement can acquire the lease', async t => {
  const { store, runId, cwd, directory } = fixture(t); review(store, runId);
  store.addTask(runId, { taskId: 'a', files: ['src/a.txt'] }); await implement(store, runId, 'a', { 'src/a.txt': 'candidate\n' });
  const ready = path.join(directory, 'check-ready'); const marker = path.join(directory, 'closed-child-survived');
  const childCode = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'late'),1300);setInterval(()=>{},1000)`;
  const check = store.recordChecks(runId, { taskId: 'a', argv: [process.execPath, '-e', childCode] });
  for (let retry = 0; retry < 100 && !existsSync(ready); retry++) await delay(10);
  assert.equal(existsSync(ready), true);
  const closing = store.close(); assert.equal(existsSync(store.leaseFile), true);
  assert.throws(() => store.start({ planPath: 'unused' }), /closed/);
  assert.throws(() => new WorkflowStore({ cwd }), /Another live controller/);
  await closing; assert.equal((await check).jobStatus, 'cancelled'); assert.equal(existsSync(store.leaseFile), false);
  const restored = new WorkflowStore({ cwd });
  try { assert.equal(restored.get(runId).checks.at(-1).status, 'failed'); } finally { await restored.close(); }
  await delay(1400); assert.equal(existsSync(marker), false);
});

test('check output overflow keeps bounded evidence and cleans up an owned descendant', async t => {
  if (process.platform === 'win32') return t.skip('POSIX process-group fixture');
  const { store, runId, directory } = fixture(t); review(store, runId);
  store.addTask(runId, { taskId: 'a', files: ['src/a.txt'] }); await implement(store, runId, 'a', { 'src/a.txt': 'candidate\n' });
  const marker = path.join(directory, 'overflow-descendant-survived');
  const descendant = `process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'late'),1200);setInterval(()=>{},1000)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setTimeout(()=>process.stdout.write(Buffer.alloc(9*1024*1024,120)),100);setInterval(()=>{},1000)`;
  const result = await store.recordChecks(runId, { taskId: 'a', argv: [process.execPath, '-e', parent] });
  assert.equal(result.status, 'failed'); assert.match(result.error, /output exceeded/);
  assert.ok(Buffer.byteLength(result.stdout) <= 12000); assert.ok(statSync(result.paths.stdout).size + statSync(result.paths.stderr).size <= 8 * 1024 * 1024);
  await delay(1300); assert.equal(existsSync(marker), false);
});

test('restart retains an interrupted running check as blocked evidence without restarting it', async t => {
  const { store, runId, cwd, directory } = fixture(t); review(store, runId);
  store.addTask(runId, { taskId: 'a', files: ['src/a.txt'] }); await implement(store, runId, 'a', { 'src/a.txt': 'candidate\n' }); await store.close();
  const marker = path.join(directory, 'check-runs');
  // Crash after submit/bind, before settlement. The owned check exits by itself;
  // recovery must retain the ledger reservation after that process exits.
  crashed(`import { WorkflowStore } from ${JSON.stringify(moduleUrl)}; const store=new WorkflowStore({cwd:${JSON.stringify(cwd)}}); store.recordChecks(${JSON.stringify(runId)},{taskId:'a',argv:[process.execPath,'-e',${JSON.stringify(`require('node:fs').appendFileSync(${JSON.stringify(marker)},'run')`)}]}); process.exit(17);`);
  await delay(300);
  const restored = new WorkflowStore({ cwd });
  try {
    const check = restored.get(runId).checks.at(-1); assert.equal(check.status, 'blocked'); assert.equal(check.error, 'orphaned_session'); assert.ok(check.jobId); assert.ok(check.paths.result);
    assert.equal(readFileSync(marker, 'utf8'), 'run');
    await assert.rejects(restored.recordChecks(runId, { taskId: 'a', argv: checkArgv }), /recovery/);
    restored.recoverTask(runId, { taskId: 'a', phase: 'check', reason: 'Verified the saved process exited and inspected unchanged files and logs.' });
    assert.equal((await restored.recordChecks(runId, { taskId: 'a', argv: checkArgv })).status, 'passed');
    assert.equal(readFileSync(marker, 'utf8'), 'run');
  } finally { await restored.close(); }
});

test('interrupted task and integration creation recover before and after Git registration', async t => {
  for (const kind of ['task', 'integration']) for (const stage of ['before', 'after']) {
    await t.test(`${kind} ${stage}`, async t => {
      const { store, runId, cwd } = fixture(t); review(store, runId);
      if (kind === 'integration') {
        store.addTask(runId, { taskId: 'a', files: ['src/a.txt'] }); await implement(store, runId, 'a', { 'src/a.txt': 'candidate\n' }); review(store, runId, { phase: 'code_review', taskId: 'a' });
      }
      const original = git(cwd, 'rev-parse', 'HEAD'); await store.close();
      const action = kind === 'task' ? `store.addTask(${JSON.stringify(runId)},{taskId:'interrupted',files:['src/b.txt']})` : `store.integrate(${JSON.stringify(runId)})`;
      crashed(`import { WorkflowStore } from ${JSON.stringify(moduleUrl)}; class Crash extends WorkflowStore { _createWorktree(target) { ${stage === 'after' ? 'super._createWorktree(target);' : ''} process.exit(17); } } const store=new Crash({cwd:${JSON.stringify(cwd)}}); ${action};`);
      const restored = new WorkflowStore({ cwd });
      try {
        const run = restored.get(runId); const target = kind === 'task' ? run.tasks.interrupted : run.integration;
        assert.equal(target.setup.status, 'creating'); assert.equal(existsSync(target.worktree), stage === 'after');
        restored.recoverTask(runId, { ...(kind === 'task' ? { taskId: 'interrupted' } : {}), reason: 'Inspected interrupted creation; adopt only its registered exact clean base.' });
        const ready = kind === 'task' ? restored.get(runId).tasks.interrupted : restored.get(runId).integration;
        assert.equal(ready.setup.status, 'ready'); assert.equal(git(ready.worktree, 'rev-parse', 'HEAD'), run.baseSha);
        if (kind === 'integration') assert.equal(restored.integrate(runId).status, 'integrated');
        else assert.equal(restored.prepareAttempt(runId, { taskId: 'interrupted', phase: 'implement' }).status, 'prepared');
        assert.equal(git(cwd, 'rev-parse', 'HEAD'), original);
      } finally { await restored.close(); }
    });
  }
});

test('setup recovery refuses unrelated contents and a registered worktree with a changed base', async t => {
  for (const variant of ['unrelated', 'changed-base']) await t.test(variant, async t => {
    const { store, runId, cwd } = fixture(t); await store.close();
    crashed(`import { WorkflowStore } from ${JSON.stringify(moduleUrl)}; class Crash extends WorkflowStore { _createWorktree(target) { ${variant === 'changed-base' ? 'super._createWorktree(target);' : ''} process.exit(17); } } new Crash({cwd:${JSON.stringify(cwd)}}).addTask(${JSON.stringify(runId)},{taskId:'interrupted',files:['src/a.txt']});`);
    const state = JSON.parse(readFileSync(store.file)); const worktree = state.runs[runId].tasks.interrupted.worktree;
    if (variant === 'unrelated') mkdirSync(worktree, { recursive: true });
    const file = path.join(worktree, 'preserved.txt'); writeFileSync(file, 'must remain\n');
    if (variant === 'changed-base') { git(worktree, 'add', 'preserved.txt'); git(worktree, 'commit', '-qm', 'Unexpected setup edit'); }
    const restored = new WorkflowStore({ cwd });
    try {
      assert.throws(() => restored.recoverTask(runId, { taskId: 'interrupted', reason: 'Inspect conflicting setup state.' }), /git|recorded base/);
      assert.equal(readFileSync(file, 'utf8'), 'must remain\n'); assert.equal(restored.get(runId).tasks.interrupted.status, 'blocked');
    } finally { await restored.close(); }
  });
});

test('a controller crashing after claim publication leaves a recoverable owner-bearing guard', async t => {
  const { store, cwd } = fixture(t); await store.close();
  execFileSync(process.execPath, ['--input-type=module', '-e', `import { WorkflowStore } from ${JSON.stringify(moduleUrl)}; new WorkflowStore({cwd:${JSON.stringify(cwd)}});`]);
  crashed(`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const link=fs.linkSync;fs.linkSync=(src,dst)=>{link(src,dst);if(dst.includes('.claim-'))process.exit(17);};syncBuiltinESMExports();const { WorkflowStore }=await import(${JSON.stringify(moduleUrl)});new WorkflowStore({cwd:${JSON.stringify(cwd)}});`);
  const guards = readdirSync(store.directory).filter(name => name.includes('.claim-') && !name.endsWith('.tmp')); assert.equal(guards.length, 1);
  const raw = readFileSync(path.join(store.directory, guards[0]), 'utf8'); assert.ok(JSON.parse(raw).nonce); assert.ok(JSON.parse(raw).pid);
  const restored = new WorkflowStore({ cwd });
  try { assert.equal(readFileSync(path.join(store.directory, guards[0]), 'utf8'), raw); assert.throws(() => new WorkflowStore({ cwd }), /Another live controller/); }
  finally { await restored.close(); }
});

test('concurrent reclaimers cannot both acquire a dead controller lease', async t => {
  const { store, cwd } = fixture(t); await store.close();
  execFileSync(process.execPath, ['--input-type=module', '-e', `import { WorkflowStore } from ${JSON.stringify(moduleUrl)}; new WorkflowStore({cwd:${JSON.stringify(cwd)}});`]);
  const code = `import { WorkflowStore } from ${JSON.stringify(moduleUrl)};let store;try{store=new WorkflowStore({cwd:${JSON.stringify(cwd)}});console.log('owned');process.on('message',async()=>{await store.close();process.exit(0);});}catch(error){console.log('refused');process.exit(0);}`;
  const launch = () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore','pipe','pipe','ipc'] });
    const result = new Promise((resolve,reject) => { child.stdout.once('data', chunk => resolve(chunk.toString().trim())); child.once('error',reject); });
    const exited = new Promise(resolve => child.once('exit',resolve)); return { child, result, exited };
  };
  const contenders = [launch(), launch()];
  try { assert.deepEqual((await Promise.all(contenders.map(item => item.result))).sort(), ['owned','refused']); }
  finally { for (const item of contenders) if (item.child.connected) item.child.send('close'); await Promise.all(contenders.map(item => item.exited)); }
});

test('actual dependency merge conflict requires explicit resolution before recovery', async t => {
  const { store, runId } = fixture(t); review(store, runId);
  store.addTask(runId, { taskId: 'a', files: ['src/a.txt'] });
  const dependent = store.addTask(runId, { taskId: 'b', files: ['src/a.txt'], dependsOn: ['a'] });
  await implement(store, runId, 'a', { 'src/a.txt': 'upstream change\n' }); review(store, runId, { taskId: 'a', phase: 'code_review' });
  writeFileSync(path.join(dependent.worktree, 'src/a.txt'), 'independent conflicting change\n'); git(dependent.worktree, 'add', 'src/a.txt'); git(dependent.worktree, 'commit', '-qm', 'Existing dependent edit');
  assert.throws(() => store.prepareAttempt(runId, { taskId: 'b', phase: 'implement' }), /git/);
  assert.ok(git(dependent.worktree, 'rev-parse', '--verify', 'MERGE_HEAD')); assert.match(readFileSync(path.join(dependent.worktree, 'src/a.txt'), 'utf8'), /<<<<<<< HEAD/);
  assert.throws(() => store.recoverTask(runId, { taskId: 'b', reason: 'Inspected conflict.' }), /in-progress merge/);
  writeFileSync(path.join(dependent.worktree, 'src/a.txt'), 'resolved behavior\n'); git(dependent.worktree, 'add', 'src/a.txt'); git(dependent.worktree, 'commit', '-qm', 'Resolve dependency conflict');
  store.recoverTask(runId, { taskId: 'b', reason: 'Resolved and committed the actual dependency merge conflict.' });
  assert.equal(store.prepareAttempt(runId, { taskId: 'b', phase: 'implement' }).status, 'prepared');
  assert.equal(readFileSync(path.join(dependent.worktree, 'src/a.txt'), 'utf8'), 'resolved behavior\n');
});
