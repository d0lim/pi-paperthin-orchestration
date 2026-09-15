import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { JobManager } from './jobs.mjs';

const ACTIVE = new Set(['prepared', 'running']);
const PHASES = new Set(['plan_review', 'implement', 'code_review']);
const CHECK_ACTIVE = new Set(['prepared', 'running']);
const JOB_TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
const clone = value => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
const id = (value, label) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) throw new Error(`${label} must contain 1–80 letters, numbers, underscores or hyphens.`);
  return value;
};
const required = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${label} is required.`);
  return value;
};
function gitRaw(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
}
const git = (cwd, ...args) => gitRaw(cwd, ...args).trim();
function succeeds(cwd, ...args) {
  return spawnSync('git', ['-C', cwd, ...args], { stdio: 'ignore', timeout: 30_000 }).status === 0;
}
function atomic(file, value, exclusive = false) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    if (exclusive) linkSync(temporary, file);
    else renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}
function scope(value) {
  required(value, 'file ownership path');
  if (path.isAbsolute(value) || value.includes('\\') || value.split('/').some(part => part === '..' || part === '.git') || /[*?\[\]]/.test(value)) throw new Error('Ownership paths must be repository-relative files or directories without traversal or globs.');
  const normalized = path.posix.normalize(value).replace(/\/$/, '');
  if (normalized === '.' || normalized === '' || normalized.startsWith('../')) throw new Error('Declare explicit files or directories, not the repository root.');
  return normalized;
}
const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** One controller owns this repository's durable workflow ledger. No saved PID is restarted or killed. */
export class WorkflowStore {
  constructor({ cwd, directory, maxAttempts = 3, sessionId = randomUUID() } = {}) {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new Error('maxAttempts must be an integer between 1 and 20.');
    this.cwd = realpathSync(git(required(cwd, 'cwd'), 'rev-parse', '--show-toplevel'));
    this.commonGitDir = realpathSync(git(this.cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    this.directory = path.resolve(directory ?? path.join(this.commonGitDir, 'paperthin', 'workflows'));
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.directory = realpathSync(this.directory);
    this.file = path.join(this.directory, 'state.json');
    this.leaseFile = path.join(this.directory, 'controller.json');
    this.sessionId = required(sessionId, 'sessionId');
    this.maxAttempts = maxAttempts;
    this.closed = false;
    this.closing = false;
    this.activeChecks = new Map();
    this.leaseNonce = randomUUID();
    this._claim();
    try {
      this._mutate(state => {
        for (const run of Object.values(state.runs)) {
          for (const attempt of run.attempts) {
            if (!ACTIVE.has(attempt.status)) continue;
            attempt.status = 'blocked'; attempt.reason = 'orphaned_session'; attempt.finishedAt = now();
            this._block(run, attempt, 'Previous controller ended before this attempt settled. Inspect its logs, process state and worktree, then explicitly recover.');
          }
          for (const check of run.checks) {
            if (!CHECK_ACTIVE.has(check.status)) continue;
            check.status = 'blocked'; check.error = 'orphaned_session'; check.finishedAt = now();
            this._block(run, { taskId: check.taskId, phase: 'check' }, 'Previous controller ended during a check. Inspect its preserved logs, process state and worktree before recovery.');
          }
          for (const task of Object.values(run.tasks)) if (task.setup?.status === 'creating') {
            task.status = 'blocked'; task.blocked = { phase: 'task_setup', reason: 'Worktree creation was interrupted. Explicit recovery will verify or finish the recorded setup.' };
          }
          if (run.integration?.setup?.status === 'creating' || run.integration?.status === 'integrating') {
            run.status = 'blocked'; run.blocked = { phase: 'integration', reason: 'Integration setup or merge was interrupted. Inspect preserved work and explicitly recover.' };
          }
        }
      });
    } catch (error) { this.close().catch(() => {}); throw error; }
  }

  _claim() {
    const owner = { pid: process.pid, sessionId: this.sessionId, nonce: this.leaseNonce, startedAt: now() };
    try { atomic(this.leaseFile, owner, true); return; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const previous = readFileSync(this.leaseFile, 'utf8');
    const assertDead = raw => {
      const value = JSON.parse(raw);
      let dead = false;
      // This is only a liveness probe; unknown owners and PID reuse fail closed.
      if (Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.sessionId === 'string') {
        try { process.kill(value.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
      }
      if (!dead) throw new Error('Another live controller owns this workflow store or its claim guard. Close that session before opening another.');
      return value;
    };
    assertDead(previous);
    let predecessor = previous;
    // Dead guards are immutable evidence. All contenders follow the same chain,
    // so none can unlink/reuse a dead lock while a different claimant owns it.
    for (let depth = 0; depth < 1024; depth += 1) {
      const guard = `${this.leaseFile}.claim-${hash(predecessor)}`;
      try { atomic(guard, owner, true); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        predecessor = readFileSync(guard, 'utf8'); assertDead(predecessor); continue;
      }
      try {
        if (readFileSync(this.leaseFile, 'utf8') !== previous) throw new Error('Controller ownership changed; retry opening the store.');
        atomic(this.leaseFile, owner);
        return;
      } finally {
        if (JSON.parse(readFileSync(guard, 'utf8')).nonce === owner.nonce) rmSync(guard);
      }
    }
    throw new Error('Controller claim history exceeded the recovery bound; inspect the preserved guards.');
  }

  _readState(allowClosing = false) {
    if (this.closed || (this.closing && !allowClosing)) throw new Error('Workflow store is closed.');
    const lease = JSON.parse(readFileSync(this.leaseFile, 'utf8'));
    if (lease.sessionId !== this.sessionId || lease.pid !== process.pid || lease.nonce !== this.leaseNonce) throw new Error('Workflow controller lease was lost.');
    const state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { version: 1, commonGitDir: this.commonGitDir, runs: {} };
    if (state.version !== 1 || state.commonGitDir !== this.commonGitDir) throw new Error('Workflow ledger belongs to another repository or schema.');
    return state;
  }

  _mutate(fn, allowClosing = false) {
    const state = this._readState(allowClosing);
    try { return clone(fn(state) ?? null); }
    finally { atomic(this.file, state); }
  }

  _run(state, runId) {
    const run = state.runs[runId];
    if (!run) throw new Error(`Unknown workflow run: ${runId}`);
    return run;
  }
  _task(run, taskId) {
    const task = run.tasks[taskId];
    if (!task) throw new Error(`Unknown workflow task: ${taskId}`);
    return task;
  }
  _head(cwd) { return git(cwd, 'rev-parse', 'HEAD'); }
  _clean(cwd) {
    if (git(cwd, 'status', '--porcelain', '--untracked-files=all')) throw new Error(`Worktree has uncommitted or untracked changes: ${cwd}`);
    if (succeeds(cwd, 'rev-parse', '--verify', 'MERGE_HEAD')) throw new Error('Resolve the in-progress merge before continuing.');
  }
  _worktree(task) {
    if (task.setup && task.setup.status !== 'ready') throw new Error('Worktree setup requires explicit recovery before use.');
    const actual = realpathSync(task.worktree);
    if (actual !== task.worktree || realpathSync(git(actual, 'rev-parse', '--path-format=absolute', '--git-common-dir')) !== this.commonGitDir || realpathSync(git(actual, 'rev-parse', '--show-toplevel')) !== actual) throw new Error('Task worktree no longer belongs to the registered repository.');
    const registered = git(this.cwd, 'worktree', 'list', '--porcelain').split('\n').some(line => line === `worktree ${actual}`);
    if (!registered) throw new Error('Task worktree is not registered in this repository.');
    return actual;
  }
  _createWorktree(target) {
    mkdirSync(path.dirname(target.worktree), { recursive: true, mode: 0o700 });
    git(this.cwd, 'worktree', 'add', '--detach', target.worktree, target.setup.baseSha);
  }
  _finishSetup(target) {
    if (target.setup?.status !== 'creating') return;
    if (!existsSync(target.worktree)) this._createWorktree(target);
    const cwd = this._worktree({ ...target, setup: null });
    this._clean(cwd);
    if (this._head(cwd) !== target.setup.baseSha) throw new Error('Interrupted worktree setup no longer has its recorded base; preserve and inspect it before recovery.');
    target.setup.status = 'ready'; target.setup.finishedAt = now(); target.status = 'pending';
  }
  _materializeSetup(runId, taskId) {
    return this._mutate(state => {
      const run = this._run(state, runId); const target = taskId ? this._task(run, taskId) : run.integration;
      try { this._finishSetup(target); }
      catch (error) { this._block(run, { taskId, phase: taskId ? 'task_setup' : 'integration' }, error.message); throw error; }
      return target;
    });
  }
  _plan(run, approved = false) {
    if (this._head(run.cwd) !== run.baseSha) throw new Error('Original checkout advanced after the recorded plan base. Start a new run against its current HEAD.');
    if (!existsSync(run.plan.snapshotPath) || hash(readFileSync(run.plan.snapshotPath)) !== run.plan.sha256) throw new Error('Saved plan snapshot changed. Take a new plan snapshot before reviewing it.');
    if (!existsSync(run.plan.path) || hash(readFileSync(run.plan.path)) !== run.plan.sha256) {
      run.status = 'plan_changed';
      throw new Error('Plan changed after snapshot. Take a new plan snapshot and obtain a new plan review.');
    }
    if (approved && !run.plan.approvalId) throw new Error('A successful, hash-bound plan approval is required before implementation.');
  }
  _idle(run, taskId) {
    if (run.attempts.some(a => ACTIVE.has(a.status) && (taskId === undefined || a.taskId === taskId)) || run.checks.some(check => CHECK_ACTIVE.has(check.status) && (taskId === undefined || check.taskId === taskId))) throw new Error('An attempt or check still owns this work. Wait for settlement or cancel the owned job first.');
  }
  _block(run, attempt, reason) {
    if (attempt.taskId) { const task = this._task(run, attempt.taskId); task.status = 'blocked'; task.blocked = { phase: attempt.phase, reason }; }
    else { run.blocked = { phase: attempt.phase, reason }; run.status = 'blocked'; }
  }
  _candidate(run, task) {
    this._plan(run, true);
    this._worktree(task); this._clean(task.worktree);
    if (!task.candidateSha || this._head(task.worktree) !== task.candidateSha || !succeeds(task.worktree, 'merge-base', '--is-ancestor', task.baseSha, task.candidateSha)) throw new Error('Candidate SHA changed or is not descended from the recorded base. Freeze and check the current candidate again.');
    this._scope(task);
    for (const [dependencyId, sha] of Object.entries(task.dependencyHeads ?? {})) {
      if (this._task(run, dependencyId).candidateSha !== sha) throw new Error('A dependency changed after this task started. Create a fresh task/run for the new dependency state.');
    }
  }
  _scope(task) {
    // --no-renames checks both deleted and added paths for a rename.
    const changed = gitRaw(task.worktree, 'diff', '--name-only', '--no-renames', '-z', task.baseSha, 'HEAD').split('\0').filter(Boolean);
    if (changed.some(file => !task.files.some(owned => file === owned || file.startsWith(`${owned}/`)))) throw new Error('Candidate changes files outside the task ownership paths.');
  }
  _passingChecks(run, taskId, sha) {
    const matching = run.checks.filter(check => check.taskId === taskId && check.candidateSha === sha && check.planSha256 === run.plan.sha256);
    const latest = new Map(matching.map(check => [JSON.stringify(check.argv), check]));
    if (!latest.size || [...latest.values()].some(check => check.status !== 'passed')) throw new Error('Recorded passing checks for the current candidate and plan are required.');
    return [...latest.values()].map(check => check.id);
  }
  _approvedTask(run, task) {
    this._candidate(run, task);
    const approval = run.approvals.find(item => item.id === task.approvalId);
    if (!approval || approval.planSha256 !== run.plan.sha256 || approval.baseSha !== task.baseSha || approval.candidateSha !== task.candidateSha || approval.verdict !== 'approve') throw new Error(`Task ${task.taskId} needs a current code review approval.`);
    this._passingChecks(run, task.taskId, task.candidateSha);
  }
  _integrationCandidate(run) {
    this._plan(run, true);
    const target = run.integration;
    if (!target || target.status !== 'integrated') throw new Error('Create the integration candidate before final checks or review.');
    const cwd = this._worktree(target); this._clean(cwd);
    if (this._head(cwd) !== target.candidateSha || !succeeds(cwd, 'merge-base', '--is-ancestor', run.baseSha, 'HEAD')) throw new Error('Integration candidate changed after verification.');
    for (const task of Object.values(run.tasks)) {
      this._approvedTask(run, task);
      if (target.taskCandidates[task.taskId] !== task.candidateSha || !succeeds(cwd, 'merge-base', '--is-ancestor', task.candidateSha, 'HEAD')) throw new Error('Integration no longer contains the reviewed task candidate.');
    }
    return target;
  }

  start({ planPath, runId = randomUUID() } = {}) {
    return this._mutate(state => {
      id(runId, 'runId');
      if (state.runs[runId]) throw new Error('Workflow run ID already exists.');
      this._clean(this.cwd);
      const resolved = realpathSync(path.resolve(this.cwd, required(planPath, 'planPath')));
      const content = readFileSync(resolved);
      const run = { runId, cwd: this.cwd, baseSha: this._head(this.cwd), createdAt: now(), status: 'planning', maxAttempts: this.maxAttempts,
        plan: { path: resolved, sha256: hash(content), revision: 1, approvalId: null }, tasks: {}, attempts: [], approvals: [], checks: [], recoveries: [], integration: null };
      const snapshot = path.join(this.directory, runId, 'plans', `${run.plan.sha256}.md`);
      mkdirSync(path.dirname(snapshot), { recursive: true, mode: 0o700 });
      writeFileSync(snapshot, content, { mode: 0o600 }); run.plan.snapshotPath = snapshot;
      state.runs[runId] = run;
      return run;
    });
  }
  list() { return clone(Object.values(this._readState().runs)); }
  get(runId) { return clone(this._run(this._readState(), runId)); }
  snapshotPlan(runId, { planPath } = {}) {
    return this._mutate(state => {
      const run = this._run(state, runId); this._idle(run);
      if (run.status === 'completed') throw new Error('Completed runs are immutable; start a new run.');
      const resolved = realpathSync(path.resolve(this.cwd, planPath ?? run.plan.path));
      const content = readFileSync(resolved); const sha256 = hash(content);
      const snapshotPath = path.join(this.directory, runId, 'plans', `${sha256}.md`);
      writeFileSync(snapshotPath, content, { mode: 0o600 });
      run.plan = { path: resolved, sha256, snapshotPath, revision: run.plan.revision + 1, approvalId: null };
      run.status = 'planning'; run.blocked = null;
      if (run.integration) {
        run.integrationHistory ??= [];
        run.integrationHistory.push({ ...run.integration, status: 'stale', archivedAt: now() });
        run.integration = null;
      }
      for (const task of Object.values(run.tasks)) { task.approvalId = null; task.candidateSha = null; task.status = task.blocked ? 'blocked' : 'pending'; }
      return run;
    });
  }
  addTask(runId, { taskId = randomUUID(), files, dependsOn = [], briefPath } = {}) {
    this._mutate(state => {
      const run = this._run(state, runId); this._plan(run); id(taskId, 'taskId');
      if (run.status === 'completed' || run.integration) throw new Error('Tasks cannot be added after integration starts.');
      if (run.tasks[taskId]) throw new Error('Task ID already exists.');
      if (!Array.isArray(files) || !files.length) throw new Error('Task file ownership paths are required.');
      const owned = [...new Set(files.map(scope))];
      if (!Array.isArray(dependsOn) || new Set(dependsOn).size !== dependsOn.length) throw new Error('dependsOn must be unique existing task IDs.');
      const ancestors = new Set();
      const visit = dep => { const task = this._task(run, dep); ancestors.add(dep); for (const parent of task.dependsOn) if (!ancestors.has(parent)) visit(parent); };
      for (const dep of dependsOn) visit(dep);
      for (const task of Object.values(run.tasks)) if (!ancestors.has(task.taskId) && task.files.some(a => owned.some(b => overlaps(a, b)))) throw new Error('Overlapping file ownership requires an explicit dependency on the existing task.');
      const resolvedBrief = briefPath ? realpathSync(path.resolve(this.cwd, briefPath)) : null;
      const worktree = path.join(this.directory, runId, 'worktrees', taskId);
      const task = { taskId, files: owned, dependsOn: [...dependsOn], worktree, baseSha: run.baseSha,
        setup: { status: 'creating', baseSha: run.baseSha, reservedAt: now() },
        briefPath: resolvedBrief, status: 'creating', candidateSha: null, approvalId: null, dependencyHeads: {}, started: false, blocked: null };
      run.tasks[taskId] = task;
      return task;
    });
    return this._materializeSetup(runId, taskId);
  }

  prepareAttempt(runId, { phase, taskId, runtime, model } = {}) {
    return this._mutate(state => {
      const run = this._run(state, runId);
      if (!PHASES.has(phase)) throw new Error('Unsupported workflow attempt phase.');
      const integrationReview = phase === 'code_review' && taskId === undefined;
      if (run.status === 'completed' || (run.integration && !integrationReview)) throw new Error('This run has entered integration; only the final integration code review may start.');
      this._plan(run, phase !== 'plan_review');
      if (run.blocked) throw new Error('Run requires explicit recovery before another attempt.');
      if (phase === 'plan_review' && taskId !== undefined) throw new Error('Plan review is a run phase and has no taskId.');
      const task = phase === 'plan_review' || integrationReview ? null : this._task(run, taskId);
      this._idle(run, task?.taskId);
      if (task?.blocked) throw new Error('Task requires explicit recovery after failure or orphaned work.');
      const previous = run.attempts.filter(a => a.phase === phase && a.taskId === (task?.taskId ?? null) && a.planRevision === run.plan.revision);
      if (previous.length >= run.maxAttempts) throw new Error('Attempt limit reached. Inspect the evidence and start a new run or revise the plan; automatic retries are disabled.');
      let cwd = run.cwd; let checkIds = []; let target = task;
      if (integrationReview) {
        target = this._integrationCandidate(run); cwd = target.worktree;
        checkIds = this._passingChecks(run, null, target.candidateSha);
      }
      if (task) {
        cwd = this._worktree(task);
        for (const dependencyId of task.dependsOn) this._approvedTask(run, this._task(run, dependencyId));
        if (phase === 'implement') {
          for (const otherRun of Object.values(state.runs)) for (const other of otherRun.attempts) {
            if (other.phase !== 'implement' || !ACTIVE.has(other.status)) continue;
            const otherTask = this._task(otherRun, other.taskId);
            if (otherTask.files.some(a => task.files.some(b => overlaps(a, b)))) throw new Error('Another implementation attempt owns overlapping file paths.');
          }
          if (!task.started) {
            this._clean(cwd);
            try {
              for (const dependencyId of task.dependsOn) {
                const dependency = this._task(run, dependencyId);
                git(cwd, 'merge', '--no-edit', '--no-ff', dependency.candidateSha);
                task.dependencyHeads[dependencyId] = dependency.candidateSha;
              }
              task.baseSha = this._head(cwd); task.started = true;
            } catch (error) { task.status = 'blocked'; task.blocked = { phase, reason: `Dependency merge requires inspection: ${error.message}` }; throw error; }
          }
          for (const [dep, sha] of Object.entries(task.dependencyHeads)) if (this._task(run, dep).candidateSha !== sha) throw new Error('Dependency candidate changed after implementation began.');
          task.candidateSha = null; task.approvalId = null; task.status = 'implementing';
        } else {
          this._candidate(run, task); checkIds = this._passingChecks(run, task.taskId, task.candidateSha);
          task.status = 'reviewing';
        }
      }
      const attempt = { attemptId: randomUUID(), runId, taskId: task?.taskId ?? null, phase, number: previous.length + 1, status: 'prepared',
        planRevision: run.plan.revision, planSha256: run.plan.sha256, planSnapshotPath: run.plan.snapshotPath,
        files: task?.files ?? null, checkIds, checks: run.checks.filter(check => checkIds.includes(check.id)), baseSha: target?.baseSha ?? null, candidateSha: phase === 'code_review' ? target.candidateSha : null,
        cwd, sessionId: this.sessionId, runtime: runtime ?? null, model: model ?? null, jobId: null, preparedAt: now() };
      run.attempts.push(attempt);
      return attempt;
    });
  }
  bindAttempt(runId, attemptId, job = {}) {
    return this._mutate(state => {
      const run = this._run(state, runId); const attempt = run.attempts.find(a => a.attemptId === attemptId);
      if (!attempt || attempt.status !== 'prepared' || attempt.sessionId !== this.sessionId) throw new Error('Only a prepared attempt in this session can bind a job.');
      const runtime = job.runtime ?? job.metadata?.route?.runtime; const model = job.model ?? job.metadata?.route?.model;
      if ((attempt.runtime && attempt.runtime !== runtime) || (attempt.model && attempt.model !== model)) throw new Error('Job route differs from the prepared attempt.');
      const jobId = required(job.jobId ?? job.id, 'jobId');
      if (Object.values(state.runs).some(other => other.attempts.some(item => item.jobId === jobId))) throw new Error('Job is already bound to another attempt.');
      if (job.cwd !== undefined && realpathSync(job.cwd) !== attempt.cwd) throw new Error('Job cwd does not match the prepared worktree.');
      required(runtime, 'runtime'); required(model, 'model');
      attempt.jobId = jobId; attempt.runtime = runtime; attempt.model = model;
      attempt.paths = job.paths ? clone(job.paths) : null;
      attempt.status = 'running'; attempt.boundAt = now();
      return attempt;
    });
  }
  abortAttempt(runId, attemptId, { reason } = {}) {
    return this._mutate(state => {
      const run = this._run(state, runId); const attempt = run.attempts.find(a => a.attemptId === attemptId);
      if (!attempt || attempt.sessionId !== this.sessionId || attempt.status !== 'prepared') throw new Error('Only an unbound prepared attempt in this session can be aborted.');
      attempt.reason = required(reason, 'Abort reason'); attempt.status = 'failed'; attempt.finishedAt = now();
      this._block(run, attempt, attempt.reason);
      return attempt;
    });
  }
  settleAttempt(runId, attemptId, job = {}) {
    return this._mutate(state => {
      const run = this._run(state, runId); const attempt = run.attempts.find(a => a.attemptId === attemptId);
      if (!attempt || attempt.sessionId !== this.sessionId) throw new Error('Unknown attempt in this session.');
      if (!ACTIVE.has(attempt.status)) return attempt;
      if (attempt.jobId && (job.id ?? job.jobId) !== attempt.jobId) throw new Error('Job does not belong to this attempt.');
      if (['running', 'queued'].includes(job.status)) return attempt;
      attempt.finishedAt = now();
      attempt.evidence = { jobId: job.id ?? job.jobId ?? null, paths: job.paths ?? null, status: job.status ?? 'failed', exitCode: job.exitCode ?? null,
        runtimeError: job.runtimeError ?? null, modelVerified: job.modelVerified ?? false, reportedModels: job.reportedModels ?? [], permissionDenials: job.permissionDenials ?? [] };
      const route = job.metadata?.route ?? {};
      try {
        this._plan(run, attempt.phase !== 'plan_review');
        if (attempt.planSha256 !== run.plan.sha256 || attempt.planRevision !== run.plan.revision) throw new Error('Attempt used a stale plan snapshot.');
        if (job.status !== 'completed' || job.exitCode !== 0 || job.runtimeError !== false || (job.permissionDenials?.length ?? 0) > 0 || (job.mismatchedModels?.length ?? 0) > 0) throw new Error('Job did not complete successfully with usable runtime evidence.');
        if (attempt.runtime !== route.runtime || attempt.model !== route.model) throw new Error('Job runtime/model route does not match its bound attempt.');
        if (attempt.phase === 'implement') {
          const task = this._task(run, attempt.taskId); this._worktree(task);
          task.status = 'implemented'; attempt.status = 'succeeded';
        } else {
          if (job.modelVerified !== true) throw new Error('A review requires verified configured-model evidence.');
          const review = job.reviewResult;
          if (!review || job.reviewResultError || review.phase !== attempt.phase || review.planSha256 !== attempt.planSha256 || review.baseSha !== attempt.baseSha || review.candidateSha !== attempt.candidateSha || !['approve', 'changes_requested'].includes(review.verdict) || !Array.isArray(review.findings) || review.findings.some(f => !['blocking', 'non_blocking'].includes(f.severity) || typeof f.message !== 'string' || !f.message.trim()) || (review.verdict === 'approve' && review.findings.some(f => f.severity === 'blocking'))) throw new Error('Review must contain a valid structured verdict bound to the exact reviewed plan/base/candidate.');
          const task = attempt.taskId ? this._task(run, attempt.taskId) : null;
          if (task) { this._candidate(run, task); this._passingChecks(run, task.taskId, task.candidateSha); }
          else if (attempt.phase === 'code_review') {
            const integration = this._integrationCandidate(run);
            if (integration.baseSha !== attempt.baseSha || integration.candidateSha !== attempt.candidateSha) throw new Error('Integration changed while its review was running.');
            this._passingChecks(run, null, integration.candidateSha);
          }
          const approval = { id: randomUUID(), attemptId, taskId: attempt.taskId, phase: attempt.phase, ...clone(review), runtime: attempt.runtime, model: attempt.model,
            jobId: attempt.jobId, recordedAt: now(), evidence: clone(attempt.evidence) };
          run.approvals.push(approval); attempt.approvalId = approval.id;
          attempt.status = review.verdict === 'approve' ? 'succeeded' : 'changes_requested';
          if (task) { task.approvalId = review.verdict === 'approve' ? approval.id : null; task.status = review.verdict === 'approve' ? 'approved' : 'changes_requested'; }
          else if (attempt.phase === 'code_review') { run.integration.approvalId = review.verdict === 'approve' ? approval.id : null; run.status = 'verifying'; }
          else { run.plan.approvalId = review.verdict === 'approve' ? approval.id : null; run.status = review.verdict === 'approve' ? 'ready' : 'planning'; }
        }
      } catch (error) { attempt.status = 'failed'; attempt.reason = error.message; this._block(run, attempt, error.message); }
      return attempt;
    });
  }

  freezeTask(runId, taskId) {
    return this._mutate(state => {
      const run = this._run(state, runId); const task = this._task(run, taskId); this._plan(run, true); this._idle(run, taskId);
      if (run.status === 'completed') throw new Error('Completed runs are immutable; start a new run.');
      if (task.blocked || !task.started) throw new Error('Implement and explicitly recover any blocked task before freezing its candidate.');
      this._worktree(task); this._clean(task.worktree); this._scope(task);
      const candidateSha = this._head(task.worktree);
      if (!succeeds(task.worktree, 'merge-base', '--is-ancestor', task.baseSha, candidateSha)) throw new Error('Candidate is not descended from the task base.');
      task.candidateSha = candidateSha; task.approvalId = null; task.status = 'candidate';
      return task;
    });
  }
  async recordChecks(runId, { taskId, argv, timeoutMs = 60_000, signal } = {}) {
    signal?.throwIfAborted();
    if (this.activeChecks.size >= 2) throw new Error('At most two candidate checks may run concurrently. Wait for a check to settle.');
    const check = this._mutate(state => {
      const run = this._run(state, runId); this._plan(run, true); this._idle(run, taskId);
      if (run.status === 'completed') throw new Error('Completed runs are immutable; start a new run.');
      if (run.blocked || (taskId && this._task(run, taskId).blocked)) throw new Error('Explicit recovery is required before another check.');
      if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !argv[0]) throw new Error('Checks require a nonempty argv array, executed without a shell.');
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Check timeout must be between 1 and 60000 ms.');
      const target = taskId !== undefined ? this._task(run, taskId) : this._integrationCandidate(run);
      if (taskId !== undefined) this._candidate(run, target);
      const check = { id: randomUUID(), taskId: taskId ?? null, argv: [...argv], cwd: target.worktree,
        candidateSha: target.candidateSha, planSha256: run.plan.sha256, sessionId: this.sessionId,
        timeoutMs, status: 'prepared', startedAt: now(), jobId: null, paths: null };
      run.checks.push(check);
      return check;
    });
    const active = { manager: null, promise: null };
    this.activeChecks.set(check.id, active);
    active.promise = this._executeCheck(runId, check, active, signal);
    return active.promise;
  }
  async _executeCheck(runId, check, active, signal) {
    let job; let failure; let cancel;
    try {
      active.manager = new JobManager({ directory: path.join(this.directory, runId, 'checks'), maxConcurrent: 1, maxQueued: 0, timeoutMs: check.timeoutMs });
      job = active.manager.submit({ launch: { runtime: check.argv[0], args: check.argv.slice(1), cwd: check.cwd }, label: 'candidate check', metadata: { runId, checkId: check.id } });
      this._mutate(state => {
        const saved = this._run(state, runId).checks.find(item => item.id === check.id);
        saved.jobId = job.id; saved.paths = job.paths; saved.status = 'running';
      });
      cancel = () => active.manager.cancel(job.id);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      while (!JOB_TERMINAL.has(job.status)) job = await active.manager.wait(job.id);
    } catch (error) { failure = error; }
    finally {
      if (cancel) signal?.removeEventListener('abort', cancel);
      // Dispose waits for owned root/descendant cleanup, including submission or
      // binding failures. Persisted PIDs from earlier sessions are never touched.
      if (active.manager) await active.manager.dispose();
    }
    try {
      if (job && active.manager) job = active.manager.get(job.id);
      return this._mutate(state => {
        const run = this._run(state, runId); const saved = run.checks.find(item => item.id === check.id);
        saved.finishedAt = now(); saved.exitCode = job?.exitCode ?? null; saved.signal = job?.signal ?? null;
        saved.jobStatus = job?.status ?? 'failed'; saved.error = failure?.message ?? job?.error ?? (job?.status === 'cancelled' ? 'Check was cancelled.' : null);
        saved.stdout = job?.output ?? ''; saved.stderr = job?.stderr ?? '';
        let unchanged = false;
        try {
          const target = check.taskId ? this._task(run, check.taskId) : this._integrationCandidate(run);
          if (check.taskId) this._candidate(run, target);
          unchanged = target.candidateSha === check.candidateSha && run.plan.sha256 === check.planSha256;
        } catch (error) { saved.error ??= error.message; }
        saved.status = job?.status === 'completed' && job.exitCode === 0 && !saved.error && unchanged ? 'passed' : 'failed';
        return saved;
      }, true);
    } finally { this.activeChecks.delete(check.id); }
  }
  recoverTask(runId, { taskId, phase, reason } = {}) {
    return this._mutate(state => {
      const run = this._run(state, runId); required(reason, 'Recovery inspection reason'); this._idle(run, taskId); this._plan(run);
      const target = taskId ? this._task(run, taskId) : run;
      if (!target.blocked) throw new Error('Target is not blocked; there is no recovery to acknowledge.');
      if (phase && phase !== target.blocked.phase) throw new Error('Recovery phase does not match the blocked phase.');
      const setupTarget = taskId ? target : run.integration;
      if (setupTarget?.setup?.status === 'creating') this._finishSetup(setupTarget);
      const cwd = taskId ? this._worktree(target) : run.integration ? this._worktree(run.integration) : run.cwd;
      if (succeeds(cwd, 'rev-parse', '--verify', 'MERGE_HEAD')) throw new Error('Resolve the in-progress merge explicitly before recovery.');
      const recovery = { id: randomUUID(), taskId: taskId ?? null, phase: target.blocked.phase, reason, headSha: this._head(cwd), worktreeStatus: git(cwd, 'status', '--porcelain', '--untracked-files=all'), recordedAt: now() };
      run.recoveries.push(recovery); target.blocked = null; target.status = taskId ? 'pending' : run.plan.approvalId ? 'ready' : 'planning';
      if (!taskId && run.integration && recovery.phase === 'integration') run.integration.status = 'pending';
      return recovery;
    });
  }
  integrate(runId) {
    this._mutate(state => {
      const run = this._run(state, runId); this._plan(run, true); this._idle(run);
      if (run.status === 'completed') throw new Error('Run is already complete.');
      if (run.blocked) throw new Error('Run requires explicit recovery before integration.');
      const tasks = Object.values(run.tasks);
      if (!tasks.length) throw new Error('At least one reviewed task is required for integration.');
      for (const task of tasks) this._approvedTask(run, task);
      this._clean(run.cwd);
      if (this._head(run.cwd) !== run.baseSha) throw new Error('Original checkout advanced after the plan base. Start a run against the new base.');
      if (!run.integration) {
        const worktree = path.join(this.directory, runId, 'worktrees', `.integration-${run.plan.revision}`);
        run.integration = { worktree, baseSha: run.baseSha, candidateSha: null, approvalId: null, status: 'creating',
          setup: { status: 'creating', baseSha: run.baseSha, reservedAt: now() } };
      }
    });
    this._materializeSetup(runId);
    this._mutate(state => { this._run(state, runId).integration.status = 'integrating'; });
    return this._mutate(state => {
      const run = this._run(state, runId); const tasks = Object.values(run.tasks);
      const cwd = this._worktree(run.integration);
      try {
        this._clean(cwd);
        for (const task of tasks) if (!succeeds(cwd, 'merge-base', '--is-ancestor', task.candidateSha, 'HEAD')) git(cwd, 'merge', '--no-edit', '--no-ff', task.candidateSha);
        const candidateSha = this._head(cwd);
        if (run.integration.candidateSha !== candidateSha) run.integration.approvalId = null;
        run.integration.candidateSha = candidateSha; run.integration.status = 'integrated';
        run.integration.taskCandidates = Object.fromEntries(tasks.map(task => [task.taskId, task.candidateSha]));
        run.status = 'verifying';
      } catch (error) { run.status = 'blocked'; run.blocked = { phase: 'integration', reason: error.message }; run.integration.status = 'blocked'; throw error; }
      return run.integration;
    });
  }
  complete(runId) {
    return this._mutate(state => {
      const run = this._run(state, runId); this._plan(run, true); this._idle(run);
      if (run.blocked || run.integration?.status !== 'integrated') throw new Error('An integrated candidate without blockers is required.');
      const integration = this._integrationCandidate(run);
      run.integration.finalCheckIds = this._passingChecks(run, null, run.integration.candidateSha);
      const approval = run.approvals.find(item => item.id === integration.approvalId);
      if (!approval || approval.phase !== 'code_review' || approval.taskId !== null || approval.verdict !== 'approve' || approval.planSha256 !== run.plan.sha256 || approval.baseSha !== integration.baseSha || approval.candidateSha !== integration.candidateSha) throw new Error('A current final integration code review approval is required.');
      run.status = 'completed'; run.completedAt = now();
      return run;
    });
  }
  close() {
    if (!this.closePromise) this.closePromise = this._close();
    return this.closePromise;
  }
  async _close() {
    if (this.closed) return;
    this.closing = true;
    const checks = [...this.activeChecks.values()];
    // Cancel all checks together. Keep the lease until their settlement and
    // cleanup complete, so a replacement controller cannot race old writers.
    if (checks.length) {
      await Promise.all(checks.map(check => check.manager?.dispose()));
      await Promise.allSettled(checks.map(check => check.promise));
    }
    try {
      this._mutate(state => {
        for (const run of Object.values(state.runs)) {
          for (const attempt of run.attempts) {
            if (attempt.sessionId !== this.sessionId || !ACTIVE.has(attempt.status)) continue;
            attempt.status = 'blocked'; attempt.reason = 'controller_closed'; attempt.finishedAt = now();
            this._block(run, attempt, 'Controller closed before settlement. Inspect preserved work and logs, then explicitly recover.');
          }
          for (const check of run.checks) if (check.sessionId === this.sessionId && CHECK_ACTIVE.has(check.status)) {
            check.status = 'blocked'; check.error = 'controller_closed'; check.finishedAt = now();
            this._block(run, { taskId: check.taskId, phase: 'check' }, 'Controller closed before check evidence settled. Inspect the preserved work and logs, then recover.');
          }
        }
      }, true);
    } finally {
      const lease = existsSync(this.leaseFile) ? JSON.parse(readFileSync(this.leaseFile, 'utf8')) : null;
      if (lease?.nonce === this.leaseNonce && lease?.sessionId === this.sessionId && lease?.pid === process.pid) rmSync(this.leaseFile, { force: true });
      this.closed = true;
    }
  }
}
