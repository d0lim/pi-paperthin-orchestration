import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildLaunch, buildPolicy, readRoles, herdrSpec, parseArgs, ROOT, PACKAGE_ROOT } from '../scripts/agent.mjs';

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'paperthin space '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const brief = path.join(dir, 'brief with spaces.md');
  writeFileSync(brief, 'Read only. Preserve literal $(touch SHOULD_NOT_EXIST), `echo unsafe`, and "quotes".');
  return { dir, brief };
}

function configure(dir, value) {
  mkdirSync(path.join(dir, '.pi'), { recursive: true });
  writeFileSync(path.join(dir, '.pi/paperthin.json'), JSON.stringify(value));
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  assert.ok(index >= 0, `missing ${flag}`);
  return args[index + 1];
}

test('worker in another checkout receives policy, exact role, selected skills and full brief', t => {
  const { dir, brief } = fixture(t);
  const launch = buildLaunch({ role: 'worker', cwd: dir, brief });
  assert.equal(launch.cwd, realpathSync(dir));
  assert.equal(launch.args[launch.args.indexOf('--model') + 1], 'gpt-5.6-sol');
  assert.equal(launch.args[launch.args.indexOf('--thinking') + 1], 'medium');
  const policy = launch.args[launch.args.indexOf('--append-system-prompt') + 1];
  assert.ok(policy.includes(readFileSync(path.join(ROOT, 'instructions/common.md'), 'utf8')));
  assert.ok(policy.includes(readFileSync(path.join(ROOT, 'instructions/roles/worker.md'), 'utf8')));
  assert.equal(valueAfter(launch.args, '-e'), realpathSync(path.join(ROOT, 'extensions/workflow.ts')));
  assert.equal(valueAfter(launch.args, '--workflow-role'), 'worker');
  assert.equal(valueAfter(launch.args, '--workflow-config'), realpathSync(dir));
  assert.ok(launch.args.includes('--no-extensions'));
  assert.equal(launch.args.filter(a => a === '--skill').length, 4);
  assert.ok(launch.args.includes('--no-skills'));
  for (const p of launch.sources.skills) assert.ok(path.isAbsolute(p) && existsSync(p));
  assert.ok(launch.prompt.includes(readFileSync(brief, 'utf8')));
});

test('policy uses bundled support files and identifies target instructions without injecting them', t => {
  const { dir } = fixture(t);
  writeFileSync(path.join(dir, 'AGENTS.md'), 'TARGET_SENTINEL: use the target build system.');
  const { policy, sources } = buildPolicy('lead', { cwd: dir });
  assert.equal(ROOT, PACKAGE_ROOT);
  assert.equal(sources.common, realpathSync(path.join(ROOT, 'instructions/common.md')));
  assert.equal(sources.role, realpathSync(path.join(ROOT, 'instructions/roles/lead.md')));
  assert.equal(sources.project, realpathSync(path.join(dir, 'AGENTS.md')));
  assert.equal(sources.config, null);
  assert.equal(sources.defaults, realpathSync(path.join(ROOT, 'config/roles.json')));
  assert.ok(policy.includes(realpathSync(dir)));
  assert.ok(!policy.includes('TARGET_SENTINEL'));
  assert.ok(!policy.includes('node src/cli.js'));
  assert.ok(!policy.includes('npm test'));
});

test('plain project launches Lead with the canonical extension and retains Herdr discovery', t => {
  const { dir } = fixture(t);
  const launch = buildLaunch({ role: 'lead', cwd: dir });
  assert.equal(valueAfter(launch.args, '-e'), realpathSync(path.join(ROOT, 'extensions/workflow.ts')));
  assert.equal(valueAfter(launch.args, '--workflow-role'), 'lead');
  assert.equal(valueAfter(launch.args, '--workflow-config'), realpathSync(dir));
  assert.ok(!launch.args.includes('--no-extensions'));
});

test('partial project roles inherit defaults without changing bundled configuration', t => {
  const { dir } = fixture(t);
  const before = readFileSync(path.join(ROOT, 'config/roles.json'), 'utf8');
  configure(dir, { roles: { worker: { provider: 'custom-provider', model: 'custom-worker', effort: 'high' }, reviewer: { model: 'custom-reviewer' } } });
  const roles = readRoles(dir);
  assert.deepEqual(roles.worker, { runtime: 'pi', provider: 'custom-provider', model: 'custom-worker', effort: 'high' });
  assert.equal(roles.reviewer.runtime, 'claude');
  assert.equal(roles.reviewer.model, 'custom-reviewer');
  assert.equal(roles.reviewer.effort, 'high');
  assert.equal(roles.lead.model, 'gpt-6-astra');
  assert.equal(readFileSync(path.join(ROOT, 'config/roles.json'), 'utf8'), before);
  assert.equal(buildPolicy('worker', { cwd: dir }).sources.config, realpathSync(path.join(dir, '.pi/paperthin.json')));
});

test('child launch inherits the Lead configuration origin across a different worktree', t => {
  const { dir, brief } = fixture(t);
  const worktree = path.join(dir, 'other worktree');
  mkdirSync(worktree);
  configure(dir, { roles: { worker: { provider: 'lead-provider', model: 'lead-worker', effort: 'high' } } });
  configure(worktree, { roles: { worker: { model: 'wrong-child-default' } } });
  const launch = buildLaunch({ role: 'worker', cwd: worktree, configCwd: dir, brief });
  assert.equal(valueAfter(launch.args, '--provider'), 'lead-provider');
  assert.equal(valueAfter(launch.args, '--model'), 'lead-worker');
  assert.equal(valueAfter(launch.args, '--thinking'), 'high');
  assert.equal(valueAfter(launch.args, '--workflow-config'), realpathSync(dir));
  assert.equal(launch.sources.config, realpathSync(path.join(dir, '.pi/paperthin.json')));
  assert.equal(launch.cwd, realpathSync(worktree));
});

test('untrusted project configuration is skipped without hiding errors in trusted configuration', t => {
  const { dir } = fixture(t);
  configure(dir, { roles: { worker: { model: 'untrusted-worker' } } });
  assert.equal(readRoles(dir, { projectTrusted: false }).worker.model, 'gpt-5.6-sol');
  assert.equal(readRoles(dir).worker.model, 'untrusted-worker');
  writeFileSync(path.join(dir, '.pi/paperthin.json'), '{broken JSON');
  assert.equal(readRoles(dir, { projectTrusted: false }).worker.model, 'gpt-5.6-sol');
  assert.throws(() => readRoles(dir), SyntaxError);
});

test('configuration rejects unknown fields, roles, runtimes, types and effort values', t => {
  const { dir } = fixture(t);
  const invalid = [
    null, [], { unexpected: true }, { roles: [] }, { roles: null },
    { roles: { unknown: {} } }, { roles: { worker: null } },
    { roles: { worker: { command: 'custom' } } },
    { roles: { worker: { runtime: 'claude' } } },
    { roles: { worker: { runtime: 'shell' } } },
    { roles: { worker: { provider: 12 } } },
    { roles: { reviewer: { provider: 'ignored-provider' } } },
    { roles: { escalation: { provider: 'ignored-provider' } } },
    { roles: { 'codex-worker': { provider: 'ignored-provider' } } },
    { roles: { worker: { model: '' } } },
    { roles: { worker: { model: ' padded ' } } },
    { roles: { worker: { model: 'two\nlines' } } },
    { roles: { worker: { effort: 'ultra' } } },
    { roles: { reviewer: { effort: 'minimal' } } },
    { roles: { 'codex-worker': { effort: false } } },
  ];
  for (const input of invalid) {
    configure(dir, input);
    assert.throws(() => readRoles(dir), undefined, JSON.stringify(input));
  }
  configure(dir, {});
  assert.equal(readRoles(dir).worker.model, 'gpt-5.6-sol');
  configure(dir, { roles: { worker: { runtime: 'pi', effort: 'max' } } });
  assert.equal(readRoles(dir).worker.effort, 'max');
});

test('runtime API resolves relative brief and artifact paths against target cwd', t => {
  const { dir, brief } = fixture(t);
  assert.equal(buildLaunch({ role: 'worker', cwd: dir, brief: path.basename(brief) }).sources.brief, realpathSync(brief));
  assert.equal(buildLaunch({ role: 'cold-read', cwd: dir, artifact: path.basename(brief) }).sources.artifact, realpathSync(brief));
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
  configure(dir, { roles: { worker: { provider: 'cold-read-provider', model: 'cold-read-model', effort: 'high' } } });
  const launch = buildLaunch({ role: 'cold-read', cwd: dir, artifact: brief });
  for (const flag of ['--no-context-files', '--no-skills', '--no-extensions', '--no-prompt-templates', '--no-tools', '--no-session']) assert.ok(launch.args.includes(flag));
  // Explicit neutral prompts suppress separately discovered SYSTEM/APPEND_SYSTEM files.
  assert.ok(launch.args.includes('--system-prompt'));
  assert.ok(!launch.args[launch.args.indexOf('--append-system-prompt') + 1].includes('AGENTS'));
  assert.ok(!launch.prompt.includes(ROOT));
  assert.equal(valueAfter(launch.args, '--provider'), 'cold-read-provider');
  assert.equal(valueAfter(launch.args, '--model'), 'cold-read-model');
  assert.equal(valueAfter(launch.args, '--thinking'), 'high');
  assert.ok(!launch.args.includes('-e'));
  assert.ok(!launch.args.includes('--workflow-role'));
  assert.ok(!launch.args.includes('--skill'));
  assert.ok(launch.prompt.includes(readFileSync(brief, 'utf8')));
  const original = readFileSync(brief);
  assert.equal(launch.sources.artifactSha256, createHash('sha256').update(original).digest('hex'));
  writeFileSync(brief, 'A changed artifact after preparing the read.');
  assert.ok(launch.prompt.includes(original.toString('utf8')), 'the digest identifies the same snapshot sent to the reader');
  assert.ok(!launch.prompt.includes(readFileSync(brief, 'utf8')));
  assert.throws(() => buildLaunch({ role: 'cold-read', cwd: dir, artifact: brief, brief }), /브리프/);
});

test('every runtime receives complete role-specific Paperthin bodies without unrelated skill bodies', t => {
  const { dir, brief } = fixture(t);
  const expected = {
    lead: ['readchk', 'modelchk', 'shower', 're0'],
    worker: ['readchk', 're0'],
    reviewer: ['readchk'],
    escalation: ['readchk'],
    'codex-worker': ['readchk', 're0'],
  };
  for (const [role, names] of Object.entries(expected)) {
    const launch = buildLaunch({ role, cwd: dir, brief });
    const delivered = launch.runtime === 'codex'
      ? JSON.parse(launch.args.find(arg => arg.startsWith('developer_instructions=')).slice('developer_instructions='.length))
      : valueAfter(launch.args, '--append-system-prompt');
    assert.deepEqual(launch.sources.embeddedSkills.map(p => path.basename(path.dirname(p))), names, role);
    for (const skillPath of launch.sources.skills) {
      const name = path.basename(path.dirname(skillPath));
      assert.equal(delivered.includes(readFileSync(skillPath, 'utf8')), names.includes(name), `${role}/${name}`);
    }
  }
});

test('review policy supports plan artifact hashes separately from code commit identities', t => {
  const { dir } = fixture(t);
  const policy = buildPolicy('reviewer', { cwd: dir }).policy;
  assert.ok(policy.includes('계획 파일의 실제 SHA-256'));
  assert.ok(policy.includes('계획 검토에는 코드 base/candidate SHA를 요구하지 않는다'));
  assert.ok(policy.includes('실제 base SHA와 candidate SHA'));
  const leadPolicy = buildPolicy('lead', { cwd: dir });
  const steps = readFileSync(leadPolicy.sources.role, 'utf8');
  assert.ok(steps.indexOf('구현 전에 독립 Reviewer') < steps.indexOf('Worker 브리프'));
  assert.ok(leadPolicy.policy.includes('리뷰를 통과한 변경을 Lead가'));
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

test('CLI resolves relative input files from invocation cwd and supports a separate config origin', t => {
  const { dir, brief } = fixture(t);
  const worktree = path.join(dir, 'worktree');
  mkdirSync(worktree);
  configure(dir, { roles: { worker: { model: 'from-origin' } } });
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/agent.mjs'), 'worker', '--cwd', 'worktree',
    '--config-cwd', '.', '--brief', path.basename(brief), '--dry-run'], { cwd: dir, encoding: 'utf8', env: { PATH: '' } });
  assert.equal(result.status, 0, result.stderr);
  const launch = JSON.parse(result.stdout);
  assert.equal(launch.sources.brief, realpathSync(brief));
  assert.equal(launch.cwd, realpathSync(worktree));
  assert.equal(valueAfter(launch.args, '--model'), 'from-origin');
  assert.equal(valueAfter(launch.args, '--workflow-config'), realpathSync(dir));
});

test('all advertised skill paths use the unmodified pinned vendor source', t => {
  const { dir } = fixture(t);
  const base = path.join(ROOT, 'vendor/paperthin');
  const manifest = JSON.parse(readFileSync(path.join(base, 'source.json'), 'utf8'));
  assert.deepEqual(buildPolicy('lead', { cwd: dir }).sources.skills,
    manifest.skills.map(name => realpathSync(path.join(base, 'skills', name, 'SKILL.md'))));
  for (const [relative, expected] of Object.entries(manifest.sha256)) {
    assert.equal(createHash('sha256').update(readFileSync(path.join(base, relative))).digest('hex'), expected, relative);
  }
});
