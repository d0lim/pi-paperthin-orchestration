import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';

const TAIL_BYTES = 12_000;
const OUTPUT_LIMIT = 8 * 1024 * 1024;
const KILL_GRACE_MS = 250;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out']);

function integer(value, name, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function text(value, name) {
  if (typeof value !== 'string' || !value.length || value.includes('\0')) throw new TypeError(`${name} must be a nonempty string without NUL characters.`);
  return value;
}

function directory(value, name) {
  text(value, name);
  if (!path.isAbsolute(value)) throw new TypeError(`${name} must be an absolute path.`);
  return value;
}

function copyMetadata(metadata = {}) {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) throw new TypeError('metadata must be a JSON object.');
  return JSON.parse(JSON.stringify(metadata));
}

function validateLaunch(launch) {
  if (!launch || typeof launch !== 'object' || Array.isArray(launch)) throw new TypeError('launch must be an object.');
  const runtime = text(launch.runtime, 'launch.runtime');
  if (!Array.isArray(launch.args) || launch.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new TypeError('launch.args must be an array of strings without NUL characters.');
  }
  const cwd = realpathSync(directory(launch.cwd, 'launch.cwd'));
  if (!statSync(cwd).isDirectory()) throw new TypeError('launch.cwd must be a directory.');
  const env = launch.env ?? {};
  if (typeof env !== 'object' || Array.isArray(env)) throw new TypeError('launch.env must be an object.');
  for (const [key, value] of Object.entries(env)) {
    if (!key || /[=\0]/.test(key) || (value !== undefined && (typeof value !== 'string' || value.includes('\0')))) {
      throw new TypeError('launch.env must contain valid environment names and string or undefined values.');
    }
  }
  const role = launch.role === undefined ? undefined : text(launch.role, 'launch.role');
  return { runtime, args: [...launch.args], cwd, env: { ...env }, role };
}

function childEnvironment(overrides) {
  const env = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) if (/^HERDR_/i.test(key) || env[key] === undefined) delete env[key];
  return env;
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/** A session-owned queue of fresh, headless processes. Never restores PIDs from disk. */
export class JobManager {
  constructor({ directory: outputDirectory, maxConcurrent = 2, maxQueued = 8, timeoutMs = 900_000, spawnProcess = spawn } = {}) {
    this.maxConcurrent = integer(maxConcurrent, 'maxConcurrent', 1);
    this.maxQueued = integer(maxQueued, 'maxQueued', 0);
    this.timeoutMs = integer(timeoutMs, 'timeoutMs', 1, 2_147_483_647);
    if (typeof spawnProcess !== 'function') throw new TypeError('spawnProcess must be a function.');
    directory(outputDirectory, 'directory');
    mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
    this.directory = realpathSync(outputDirectory);
    if (!statSync(this.directory).isDirectory()) throw new TypeError('directory must be a directory.');
    this._spawn = spawnProcess;
    this._jobs = new Map();
    this._queue = [];
    this._active = 0;
    this._draining = false;
    this._disposed = false;
    this._disposePromise = null;
  }

  submit({ launch, label, metadata } = {}) {
    if (this._disposed) throw new Error('This job manager has been disposed.');
    const validated = validateLaunch(launch);
    const savedMetadata = copyMetadata(metadata);
    const savedLabel = label === undefined ? validated.role ?? validated.runtime : text(label, 'label');
    if (this._active >= this.maxConcurrent && this._queue.length >= this.maxQueued) throw new Error('Headless job queue is full. Wait for or cancel an owned job before submitting more.');
    const id = randomUUID();
    const jobDirectory = path.join(this.directory, id);
    mkdirSync(jobDirectory, { mode: 0o700 });
    const job = {
      id, launch: validated, label: savedLabel, metadata: savedMetadata,
      status: 'queued', createdAt: new Date().toISOString(),
      output: Buffer.alloc(0), stderr: Buffer.alloc(0), outputBytes: 0,
      paths: { stdout: path.join(jobDirectory, 'stdout.log'), stderr: path.join(jobDirectory, 'stderr.log'), result: path.join(jobDirectory, 'result.json') },
      waiters: new Set(), child: null, terminalReason: null,
    };
    job.done = new Promise(resolve => { job.resolveDone = resolve; });
    try {
      job.stdoutFd = openSync(job.paths.stdout, 'wx', 0o600);
      job.stderrFd = openSync(job.paths.stderr, 'wx', 0o600);
      this._persist(job);
    } catch (error) {
      for (const fd of [job.stdoutFd, job.stderrFd]) if (fd !== undefined) closeSync(fd);
      rmSync(jobDirectory, { recursive: true, force: true });
      throw error;
    }
    this._jobs.set(id, job);
    this._queue.push(job);
    this._drain();
    return this._snapshot(job);
  }

  get(id) {
    return this._snapshot(this._job(id));
  }

  list() {
    return [...this._jobs.values()].map(job => this._snapshot(job));
  }

  async wait(id, { timeoutMs = 10_000, signal } = {}) {
    integer(timeoutMs, 'wait.timeoutMs', 0, 10_000);
    signal?.throwIfAborted();
    const job = this._job(id);
    if (TERMINAL.has(job.status) || timeoutMs === 0) return this._snapshot(job);
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        job.waiters.delete(finish);
        signal?.removeEventListener('abort', abort);
      };
      const finish = () => { cleanup(); resolve(this._snapshot(job)); };
      const abort = () => { cleanup(); reject(signal.reason ?? new Error('Job wait aborted.')); };
      job.waiters.add(finish);
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(finish, timeoutMs);
      if (signal?.aborted) abort();
    });
  }

  cancel(id) {
    const job = this._job(id);
    if (job.status === 'queued') {
      this._queue = this._queue.filter(candidate => candidate !== job);
      this._finish(job, 'cancelled');
    } else if (job.status === 'running') {
      this._terminate(job, 'cancelled');
    }
    return this._snapshot(job);
  }

  async dispose() {
    if (!this._disposePromise) {
      this._disposed = true;
      for (const job of this._jobs.values()) this.cancel(job.id);
      this._disposePromise = Promise.all([...this._jobs.values()].map(job => job.done)).then(() => {});
    }
    return this._disposePromise;
  }

  _job(id) {
    const job = this._jobs.get(id);
    if (!job) throw new Error('Unknown job ID in this session.');
    return job;
  }

  _snapshot(job) {
    return {
      id: job.id, status: job.status, cwd: job.launch.cwd,
      ...(job.launch.role ? { role: job.launch.role } : {}), label: job.label,
      ...(job.pid ? { pid: job.pid } : {}),
      ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
      ...(job.exitSignal ? { signal: job.exitSignal } : {}),
      output: job.output.toString('utf8'), stderr: job.stderr.toString('utf8'),
      paths: { ...job.paths }, metadata: copyMetadata(job.metadata), outputBytes: job.outputBytes,
      createdAt: job.createdAt,
      ...(job.startedAt ? { startedAt: job.startedAt } : {}),
      ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
      ...(job.terminalReason === 'cancelled' ? { cancellationRequested: true } : {}),
      ...(job.error ? { error: job.error } : {}),
    };
  }

  _persist(job) {
    const temporary = `${job.paths.result}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(this._snapshot(job), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, job.paths.result);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  _drain() {
    if (this._disposed || this._draining) return;
    this._draining = true;
    try {
      while (this._active < this.maxConcurrent && this._queue.length) this._start(this._queue.shift());
    } finally {
      this._draining = false;
    }
  }

  _start(job) {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    this._active += 1;
    let child;
    try {
      this._persist(job);
      child = this._spawn(job.launch.runtime, job.launch.args, {
        cwd: job.launch.cwd, env: childEnvironment(job.launch.env),
        shell: false, detached: process.platform !== 'win32', windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      job.child = child;
      job.pid = child.pid;
    } catch (error) {
      job.error = `Could not start job: ${message(error)}`;
      this._finish(job, 'failed');
      return;
    }
    const stdout = chunk => this._append(job, 'output', chunk);
    const stderr = chunk => this._append(job, 'stderr', chunk);
    const error = failure => this._terminate(job, 'failed', `Child process error: ${message(failure)}`);
    const exit = (code, signal) => { job.exitCode = code; job.exitSignal = signal; };
    const close = (code, signal) => {
      job.closed = true;
      job.exitCode = code;
      job.exitSignal = signal;
      clearTimeout(job.timer);
      const finish = () => this._finish(job, job.terminalReason ?? (code === 0 ? 'completed' : 'failed'));
      // The root can close before descendants with redirected stdio. Finish
      // terminating its own process group even when SIGTERM ended the root.
      if (job.terminalReason) {
        this._signalGroup(job, 'SIGKILL');
        finish();
      } else if (this._signalGroup(job, 'SIGTERM')) {
        // A successful headless job must not leave background servers behind.
        job.killTimer = setTimeout(() => { this._signalGroup(job, 'SIGKILL'); finish(); }, KILL_GRACE_MS);
      } else {
        finish();
      }
    };
    job.cleanupListeners = () => {
      child.stdout?.removeListener('data', stdout);
      child.stderr?.removeListener('data', stderr);
      child.stdout?.removeListener('error', error);
      child.stderr?.removeListener('error', error);
      child.removeListener('error', error);
      child.removeListener('exit', exit);
      child.removeListener('close', close);
    };
    child.stdout?.on('data', stdout);
    child.stderr?.on('data', stderr);
    child.stdout?.on('error', error);
    child.stderr?.on('error', error);
    child.on('error', error);
    child.once('exit', exit);
    child.once('close', close);
    job.timer = setTimeout(() => this._terminate(job, 'timed_out', `Job exceeded ${this.timeoutMs} ms.`), this.timeoutMs);
  }

  _append(job, channel, chunk) {
    if (TERMINAL.has(job.status)) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const accepted = bytes.subarray(0, Math.max(0, OUTPUT_LIMIT - job.outputBytes));
    const fd = channel === 'output' ? job.stdoutFd : job.stderrFd;
    try {
      let offset = 0;
      while (offset < accepted.length) offset += writeSync(fd, accepted, offset, accepted.length - offset);
      job.outputBytes += accepted.length;
      job[channel] = Buffer.from(Buffer.concat([job[channel], accepted]).subarray(-TAIL_BYTES));
    } catch (error) {
      this._terminate(job, 'failed', `Could not save child output: ${message(error)}`);
      return;
    }
    if (accepted.length < bytes.length) this._terminate(job, 'failed', `Child output exceeded the ${OUTPUT_LIMIT} byte limit.`);
  }

  _terminate(job, reason, error) {
    if (job.status !== 'running' || job.terminalReason) return;
    job.terminalReason = reason;
    if (error) job.error = error;
    clearTimeout(job.timer);
    clearTimeout(job.killTimer);
    this._signal(job, 'SIGTERM');
    job.killTimer = setTimeout(() => {
      this._signal(job, 'SIGKILL');
      if (job.closed) this._finish(job, job.terminalReason);
    }, KILL_GRACE_MS);
    // Keep status and the concurrency slot until child 'close' and saved logs.
  }

  _signal(job, signal) {
    if (!job.child || TERMINAL.has(job.status)) return;
    if (this._signalGroup(job, signal)) return;
    try { job.child.kill(signal); } catch (error) { job.error ??= `Could not signal child: ${message(error)}`; }
  }

  _signalGroup(job, signal) {
    if (process.platform !== 'win32' && Number.isSafeInteger(job.pid) && job.pid > 0) {
      try { process.kill(-job.pid, signal); return true; } catch (error) {
        if (error.code !== 'ESRCH') job.error ??= `Could not signal child group: ${message(error)}`;
      }
    }
    return false;
  }

  _finish(job, status) {
    if (TERMINAL.has(job.status)) return;
    const wasRunning = job.status === 'running';
    clearTimeout(job.timer);
    clearTimeout(job.killTimer);
    job.cleanupListeners?.();
    for (const key of ['stdoutFd', 'stderrFd']) {
      try { if (job[key] !== undefined) closeSync(job[key]); } catch (error) {
        status = 'failed';
        job.error ??= `Could not close job log: ${message(error)}`;
      }
      job[key] = undefined;
    }
    job.status = status;
    job.finishedAt = new Date().toISOString();
    try { this._persist(job); } catch (error) {
      job.status = 'failed';
      job.error = `Could not save job result: ${message(error)}`;
    }
    // Launch arguments may contain full policies; keep only public identity
    // after execution, never persist argv, prompts, or environment variables.
    job.launch = { cwd: job.launch.cwd, role: job.launch.role };
    job.child = null;
    if (wasRunning) this._active -= 1;
    job.resolveDone();
    for (const finish of [...job.waiters]) finish();
    this._drain();
  }
}
