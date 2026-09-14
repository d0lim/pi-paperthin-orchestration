import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { JobManager } from '../lib/jobs.mjs';

function fixture(t, options = {}) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'paperthin jobs '));
  const manager = new JobManager({ directory: path.join(cwd, 'jobs'), ...options });
  t.after(async () => { await manager.dispose(); rmSync(cwd, { recursive: true, force: true }); });
  const launch = (code = '', extra = {}) => ({ runtime: process.execPath, args: ['-e', code], cwd, ...extra });
  return { cwd, manager, launch };
}

class Child extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.signals = [];
    this.closeOnKill = true;
  }

  kill(signal) {
    this.signals.push(signal);
    if (this.closeOnKill) queueMicrotask(() => this.finish(null, signal));
    return true;
  }

  finish(code = 0, signal = null) {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

function controlledSpawner() {
  const calls = [];
  const spawnProcess = (runtime, args, options) => {
    const child = new Child();
    calls.push({ runtime, args, options, child });
    return child;
  };
  return { calls, spawnProcess };
}

async function until(condition, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Test condition did not become true.');
    await delay(10);
  }
}

test('job manager validates limits and launch input before creating job directories', async t => {
  const { cwd, manager, launch } = fixture(t);
  for (const limits of [{ maxConcurrent: 0 }, { maxConcurrent: 1.5 }, { maxConcurrent: '2' }, { maxQueued: -1 }, { maxQueued: NaN }, { timeoutMs: 0 }]) {
    assert.throws(() => new JobManager({ directory: path.join(cwd, 'invalid'), ...limits }), /integer/);
  }
  assert.throws(() => new JobManager({ directory: 'relative' }), /absolute/);
  assert.throws(() => new JobManager({ directory: cwd, spawnProcess: true }), /function/);
  for (const invalid of [launch('', { cwd: '.' }), launch('', { runtime: '' }), launch('', { args: 'not an array' }), launch('', { args: ['ok', null] }), launch('', { args: ['\0'] })]) {
    assert.throws(() => manager.submit({ launch: invalid }));
  }
  assert.throws(() => manager.submit({ launch: launch(), metadata: null }), /JSON object/);
  assert.equal(readdirSync(manager.directory).length, 0);
  assert.throws(() => manager.get('../other-session'), /Unknown job/);
  assert.throws(() => manager.cancel('../other-session'), /Unknown job/);
});

test('concurrency and queue caps are enforced and released only after saved completion', async t => {
  const { calls, spawnProcess } = controlledSpawner();
  const { manager, launch } = fixture(t, { maxConcurrent: 2, maxQueued: 2, spawnProcess });
  const jobs = Array.from({ length: 4 }, () => manager.submit({ launch: launch() }));
  assert.deepEqual(jobs.map(job => job.status), ['running', 'running', 'queued', 'queued']);
  assert.equal(calls.length, 2);
  assert.throws(() => manager.submit({ launch: launch() }), /queue is full/);
  calls[0].child.stdout.write('first result');
  calls[0].child.finish();
  assert.equal(JSON.parse(readFileSync(jobs[0].paths.result, 'utf8')).status, 'completed');
  assert.equal(calls.length, 3);
  assert.equal(manager.get(jobs[2].id).status, 'running');
  calls[1].child.finish(9);
  assert.equal(manager.get(jobs[1].id).status, 'failed');
  assert.equal(calls.length, 4);
  calls[2].child.finish();
  calls[3].child.finish();
  assert.deepEqual(manager.list().map(job => job.status), ['completed', 'failed', 'completed', 'completed']);
});

test('zero queue capacity accepts idle slots and refuses excess jobs', t => {
  const { calls, spawnProcess } = controlledSpawner();
  const { manager, launch } = fixture(t, { maxConcurrent: 1, maxQueued: 0, spawnProcess });
  const first = manager.submit({ launch: launch() });
  assert.throws(() => manager.submit({ launch: launch() }), /queue is full/);
  calls[0].child.finish();
  assert.equal(manager.get(first.id).status, 'completed');
  assert.equal(manager.submit({ launch: launch() }).status, 'running');
});

test('cancellation preserves the running slot until process close and cancels queued jobs without spawning', async t => {
  const { calls, spawnProcess } = controlledSpawner();
  const { manager, launch } = fixture(t, { maxConcurrent: 1, spawnProcess });
  const active = manager.submit({ launch: launch() });
  const queued = manager.submit({ launch: launch() });
  const next = manager.submit({ launch: launch() });
  calls[0].child.closeOnKill = false;
  assert.equal(manager.cancel(queued.id).status, 'cancelled');
  const requested = manager.cancel(active.id);
  assert.equal(requested.status, 'running');
  assert.equal(requested.cancellationRequested, true);
  assert.deepEqual(calls[0].child.signals, ['SIGTERM']);
  assert.equal((await manager.wait(active.id, { timeoutMs: 20 })).status, 'running');
  assert.equal(calls.length, 1);
  assert.equal(manager.get(next.id).status, 'queued');
  await delay(260);
  assert.ok(calls[0].child.signals.includes('SIGKILL'));
  assert.equal(calls.length, 1, 'SIGKILL submission alone must not free the slot');
  calls[0].child.finish(null, 'SIGKILL');
  assert.equal((await manager.wait(active.id)).status, 'cancelled');
  assert.equal(manager.get(next.id).status, 'running');
  assert.equal(calls.length, 2);
  calls[1].child.finish();
});

test('wait expiry and abort only stop waiting, while completion removes waiter listeners', async t => {
  const { calls, spawnProcess } = controlledSpawner();
  const { manager, launch } = fixture(t, { spawnProcess });
  const job = manager.submit({ launch: launch() });
  assert.equal((await manager.wait(job.id, { timeoutMs: 1 })).status, 'running');
  const abort = new AbortController();
  const waiting = manager.wait(job.id, { signal: abort.signal });
  abort.abort(new Error('caller stopped waiting'));
  await assert.rejects(waiting, /caller stopped waiting/);
  assert.equal(manager.get(job.id).status, 'running');
  assert.deepEqual(calls[0].child.signals, []);
  await assert.rejects(manager.wait(job.id, { timeoutMs: 10_001 }), /integer/);
  const result = manager.wait(job.id);
  calls[0].child.finish();
  assert.equal((await result).status, 'completed');
  assert.equal(calls[0].child.listenerCount('close'), 0);
  assert.equal(calls[0].child.stdout.listenerCount('data'), 0);
});

test('spawn receives literal final argv, isolated environment, and no input from the Lead terminal', t => {
  const { calls, spawnProcess } = controlledSpawner();
  const { manager, launch } = fixture(t, { spawnProcess });
  const previous = process.env.HERDR_JOB_TEST;
  process.env.HERDR_JOB_TEST = 'parent-pane';
  t.after(() => { if (previous === undefined) delete process.env.HERDR_JOB_TEST; else process.env.HERDR_JOB_TEST = previous; });
  const args = ['-p', '--', 'literal $(touch should-not-exist) `unsafe`'];
  const job = manager.submit({ launch: launch('', {
    args, prompt: 'must not be appended', role: 'worker', env: { HERDR_PANE_ID: 'w99:p1', HERDR_ENV: '1', HERDR_SOCKET_PATH: 'private-socket', ALLOWED_JOB_TEST: 'private-env-value' },
  }), metadata: { task: 'example' } });
  assert.deepEqual(calls[0].args, args);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.detached, process.platform !== 'win32');
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(calls[0].options.env.ALLOWED_JOB_TEST, 'private-env-value');
  assert.deepEqual(Object.keys(calls[0].options.env).filter(key => key.startsWith('HERDR_')), []);
  calls[0].child.finish();
  const saved = readFileSync(job.paths.result, 'utf8');
  for (const secret of ['private-env-value', 'private-socket', 'must not be appended', 'should-not-exist']) assert.ok(!saved.includes(secret));
  const snapshot = manager.get(job.id);
  snapshot.metadata.task = 'mutated';
  snapshot.paths.stdout = 'elsewhere';
  assert.equal(manager.get(job.id).metadata.task, 'example');
  assert.equal(manager.get(job.id).paths.stdout, job.paths.stdout);
});

test('streaming logs preserve full output with private permissions and bounded snapshot tails', t => {
  const { calls, spawnProcess } = controlledSpawner();
  const { manager, launch } = fixture(t, { spawnProcess });
  const job = manager.submit({ launch: launch() });
  const stdout = `${'x'.repeat(24_000)}stdout-end`;
  const stderr = `${'y'.repeat(18_000)}stderr-end`;
  calls[0].child.stdout.write(stdout);
  calls[0].child.stderr.write(stderr);
  assert.equal(readFileSync(job.paths.stdout, 'utf8'), stdout, 'logs must be readable before completion');
  assert.equal(readFileSync(job.paths.stderr, 'utf8'), stderr);
  const running = manager.get(job.id);
  assert.equal(running.output.length, 12_000);
  assert.equal(running.stderr.length, 12_000);
  assert.ok(running.output.endsWith('stdout-end'));
  assert.ok(running.stderr.endsWith('stderr-end'));
  calls[0].child.finish();
  if (process.platform !== 'win32') {
    assert.equal(statSync(path.dirname(job.paths.stdout)).mode & 0o777, 0o700);
    for (const filename of Object.values(job.paths)) assert.equal(statSync(filename).mode & 0o777, 0o600);
  }
});

test('the combined output cap fails and terminates the child before starting a queued job', async t => {
  const { calls, spawnProcess } = controlledSpawner();
  const { manager, launch } = fixture(t, { maxConcurrent: 1, spawnProcess });
  const noisy = manager.submit({ launch: launch() });
  const next = manager.submit({ launch: launch() });
  calls[0].child.closeOnKill = false;
  calls[0].child.stderr.write(Buffer.alloc(1_024, 121));
  calls[0].child.stdout.write(Buffer.alloc(8 * 1024 * 1024, 120));
  assert.ok(calls[0].child.signals.includes('SIGTERM'));
  assert.equal(manager.get(next.id).status, 'queued');
  calls[0].child.finish(null, 'SIGTERM');
  const result = await manager.wait(noisy.id);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /output exceeded/);
  assert.equal(result.outputBytes, 8 * 1024 * 1024);
  assert.equal(statSync(noisy.paths.stdout).size + statSync(noisy.paths.stderr).size, 8 * 1024 * 1024);
  assert.equal(result.output.length, 12_000);
  assert.equal(manager.get(next.id).status, 'running');
  calls[1].child.finish();
});

test('synchronous and asynchronous spawn failures retain results and permit subsequent work', async t => {
  let attempted = false;
  const { spawnProcess, calls } = controlledSpawner();
  const { manager, launch } = fixture(t, { maxConcurrent: 1, spawnProcess: (...args) => {
    if (!attempted) { attempted = true; throw new Error('synthetic spawn failure'); }
    return spawnProcess(...args);
  } });
  const failed = manager.submit({ launch: launch() });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /synthetic spawn failure/);
  const another = manager.submit({ launch: launch() });
  const next = manager.submit({ launch: launch() });
  calls[0].child.emit('error', new Error('synthetic child error'));
  assert.equal((await manager.wait(another.id)).status, 'failed');
  assert.equal(manager.get(next.id).status, 'running');
  calls[1].child.finish();
});

test('real local child success, empty output, nonzero exit, and missing executable are distinguished', async t => {
  const { manager, launch, cwd } = fixture(t);
  const output = manager.submit({ launch: launch('process.stdout.write("actual output"); process.stderr.write("actual stderr");') });
  const empty = manager.submit({ launch: launch() });
  const failed = manager.submit({ launch: launch('process.exit(7)') });
  const missing = manager.submit({ launch: launch('', { runtime: path.join(cwd, 'does-not-exist') }) });
  const results = await Promise.all([output, empty, failed, missing].map(job => manager.wait(job.id)));
  assert.deepEqual(results.map(job => job.status), ['completed', 'completed', 'failed', 'failed']);
  assert.equal(results[0].output, 'actual output');
  assert.equal(results[0].stderr, 'actual stderr');
  assert.equal(results[1].output, '');
  assert.equal(results[1].exitCode, 0);
  assert.equal(results[2].exitCode, 7);
  assert.match(results[3].error, /ENOENT/);
});

test('execution timeout terminates an owned child that ignores SIGTERM and waits for close', async t => {
  const { manager, launch } = fixture(t, { timeoutMs: 300 });
  const job = manager.submit({ launch: launch('process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);') });
  const result = await manager.wait(job.id);
  assert.equal(result.status, 'timed_out');
  assert.match(result.error, /exceeded 300 ms/);
  assert.equal(JSON.parse(readFileSync(result.paths.result, 'utf8')).status, 'timed_out');
  assert.throws(() => process.kill(job.pid, 0), { code: 'ESRCH' });
});

test('dispose cancels only owned jobs, never starts queued work, and does not reconnect old job IDs', async t => {
  const { calls, spawnProcess } = controlledSpawner();
  const { manager, launch } = fixture(t, { maxConcurrent: 1, spawnProcess });
  const running = manager.submit({ launch: launch() });
  const queued = manager.submit({ launch: launch() });
  await manager.dispose();
  assert.equal(calls.length, 1);
  assert.equal(manager.get(running.id).status, 'cancelled');
  assert.equal(manager.get(queued.id).status, 'cancelled');
  assert.throws(() => manager.submit({ launch: launch() }), /disposed/);
  const another = new JobManager({ directory: manager.directory, spawnProcess });
  assert.deepEqual(another.list(), []);
  assert.throws(() => another.cancel(running.id), /Unknown job/);
  await another.dispose();
});

test('POSIX cancellation terminates descendants in its own group while unrelated processes survive', { skip: process.platform === 'win32' }, async t => {
  const { manager, launch, cwd } = fixture(t);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
  t.after(async () => {
    if (unrelated.exitCode === null && unrelated.signalCode === null) {
      const closed = once(unrelated, 'close');
      unrelated.kill('SIGKILL');
      await closed;
    }
  });
  const pidFile = path.join(cwd, 'descendant.pid');
  const code = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(process.argv[1],String(child.pid)); process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);`;
  const job = manager.submit({ launch: launch('', { args: ['-e', code, pidFile] }) });
  await until(() => { try { return !!readFileSync(pidFile, 'utf8'); } catch { return false; } });
  const descendantPid = Number(readFileSync(pidFile, 'utf8'));
  await delay(60);
  manager.cancel(job.id);
  assert.equal((await manager.wait(job.id)).status, 'cancelled');
  await until(() => { try { process.kill(descendantPid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
});

test('successful POSIX jobs also clean up descendants that redirected their output', { skip: process.platform === 'win32' }, async t => {
  const { manager, launch, cwd } = fixture(t);
  const pidFile = path.join(cwd, 'background.pid');
  const code = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(process.argv[1],String(child.pid)); child.unref(); setTimeout(()=>process.exit(0),100);`;
  const job = manager.submit({ launch: launch('', { args: ['-e', code, pidFile] }) });
  const result = await manager.wait(job.id);
  assert.equal(result.status, 'completed');
  const descendantPid = Number(readFileSync(pidFile, 'utf8'));
  await until(() => { try { process.kill(descendantPid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
});
