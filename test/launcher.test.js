import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildLaunch, herdrSpec, parseArgs, ROOT } from '../scripts/agent.mjs';

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'paperthin space '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const brief = path.join(dir, 'brief with spaces.md');
  writeFileSync(brief, 'Read only. Preserve literal $(touch SHOULD_NOT_EXIST), `echo unsafe`, and "quotes".');
  return { dir, brief };
}

test('worker in another checkout receives policy, exact role, selected skills and full brief', t => {
  const { dir, brief } = fixture(t);
  const launch = buildLaunch({ role: 'worker', cwd: dir, brief });
  assert.equal(launch.cwd, realpathSync(dir));
  assert.equal(launch.args[launch.args.indexOf('--model') + 1], 'gpt-5.6-sol');
  assert.equal(launch.args[launch.args.indexOf('--thinking') + 1], 'medium');
  const policy = launch.args[launch.args.indexOf('--append-system-prompt') + 1];
  assert.ok(policy.includes(readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8')));
  assert.ok(policy.includes(readFileSync(path.join(ROOT, '.workflow/roles/worker.md'), 'utf8')));
  assert.equal(launch.args.filter(a => a === '--skill').length, 4);
  assert.ok(launch.args.includes('--no-skills'));
  for (const p of launch.sources.skills) assert.ok(path.isAbsolute(p) && existsSync(p));
  assert.ok(launch.prompt.includes(readFileSync(brief, 'utf8')));
});

test('reviewer receives plan mode and explicit skill paths outside the source checkout', t => {
  const { dir, brief } = fixture(t);
  const launch = buildLaunch({ role: 'reviewer', cwd: dir, brief });
  assert.equal(launch.runtime, 'claude');
  assert.equal(launch.args[launch.args.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(launch.args[launch.args.indexOf('--effort') + 1], 'high');
  const policy = launch.args[launch.args.indexOf('--append-system-prompt') + 1];
  for (const p of launch.sources.skills) assert.ok(policy.includes(p));
  assert.equal(JSON.parse(launch.args[launch.args.indexOf('--settings') + 1]).enabledPlugins['compound-engineering@compound-engineering-plugin'], false);
});

test('Herdr spec preserves argv and literal brief content, and returns on a blocked child', t => {
  const { dir, brief } = fixture(t);
  const launch = buildLaunch({ role: 'worker', cwd: dir, brief });
  const spec = herdrSpec(launch, 'test-worker');
  assert.deepEqual(spec.agentArgs, launch.args);
  assert.equal(spec.prompt, launch.prompt);
  assert.equal(spec.cwd, realpathSync(dir));
  assert.equal(spec.onBlocked, 'return');
  assert.equal(spec.name, 'test-worker');
  assert.equal(spec.agent, 'pi');
  assert.ok(herdrSpec({ ...launch, role: 'codex-worker' }).name.length <= 32);
  assert.throws(() => herdrSpec(launch, 'Invalid name'), /Herdr 이름/);
});

test('cold read excludes project policy, role, skill catalog and tools', t => {
  const { dir, brief } = fixture(t);
  const launch = buildLaunch({ role: 'cold-read', cwd: dir, artifact: brief });
  for (const flag of ['--no-context-files', '--no-skills', '--no-extensions', '--no-prompt-templates', '--no-tools', '--no-session']) assert.ok(launch.args.includes(flag));
  // Explicit neutral prompts suppress separately discovered SYSTEM/APPEND_SYSTEM files.
  assert.ok(launch.args.includes('--system-prompt'));
  assert.ok(!launch.args[launch.args.indexOf('--append-system-prompt') + 1].includes('AGENTS'));
  assert.ok(!launch.prompt.includes(ROOT));
  assert.ok(launch.prompt.includes(readFileSync(brief, 'utf8')));
  assert.throws(() => buildLaunch({ role: 'cold-read', cwd: dir, artifact: brief, brief }), /브리프/);
});

test('invalid role, missing brief and conflicting invocation modes fail before starting a runtime', t => {
  const { dir } = fixture(t);
  assert.throws(() => buildLaunch({ role: 'unknown', cwd: dir }), /역할/);
  assert.throws(() => buildLaunch({ role: 'worker', cwd: dir }), /brief/);
  assert.throws(() => parseArgs(['worker', '--brief']), /값/);
  assert.throws(() => parseArgs(['lead', '--print', '--herdr-spec']), /함께/);
  assert.throws(() => parseArgs(['lead', '--model', 'anything']), /지원하지/);
});

test('dry-run uses no runtime or shell and does not execute brief contents', t => {
  const { dir, brief } = fixture(t);
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/agent.mjs'), 'worker', '--cwd', dir, '--brief', brief, '--dry-run'], {
    cwd: dir, encoding: 'utf8', env: { PATH: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).runtime, 'pi');
  assert.equal(existsSync(path.join(dir, 'SHOULD_NOT_EXIST')), false);
});

test('native skill entry points resolve to one unmodified pinned source', () => {
  const base = path.join(ROOT, 'vendor/paperthin');
  const manifest = JSON.parse(readFileSync(path.join(base, 'source.json'), 'utf8'));
  for (const name of manifest.skills) {
    for (const scope of ['.pi', '.claude', '.agents']) {
      assert.equal(realpathSync(path.join(ROOT, scope, 'skills', name)), realpathSync(path.join(base, 'skills', name)));
    }
  }
  for (const [relative, expected] of Object.entries(manifest.sha256)) {
    assert.equal(createHash('sha256').update(readFileSync(path.join(base, relative))).digest('hex'), expected, relative);
  }
});
