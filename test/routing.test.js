import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildManagedLaunch, interpretJob, routeTask, validateAssessment } from '../lib/routing.mjs';
import { ROOT, readWorkflowSettings } from '../lib/runtime.mjs';

function assessment(overrides = {}) {
  return {
    recommended_tier: 'standard',
    recommended_effort: 'measured',
    rationale: 'The bounded change has conventional behavior and observable tests.',
    move_up_if: 'Escalate capability or deliberation if ownership or security assumptions emerge.',
    move_down_if: 'Reduce capability or deliberation if a complete mechanical proof becomes available.',
    proof_surface: 'Run the changed behavior through the target project tests and review the actual diff.',
    ...overrides,
  };
}

function fixture(t) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'paperthin routing '));
  const dir = path.join(base, 'project');
  const personal = path.join(base, 'personal.json');
  mkdirSync(dir);
  const previous = process.env.PAPERTHIN_SETTINGS_PATH;
  process.env.PAPERTHIN_SETTINGS_PATH = personal;
  t.after(() => {
    if (previous === undefined) delete process.env.PAPERTHIN_SETTINGS_PATH;
    else process.env.PAPERTHIN_SETTINGS_PATH = previous;
    rmSync(base, { recursive: true, force: true });
  });
  const brief = path.join(dir, 'task brief.md');
  const literal = '--model unrequested --dangerously-skip-permissions $(touch INJECTED) `touch INJECTED` "quoted"\nSecond line.';
  writeFileSync(brief, literal);
  return { base, dir, brief, personal, literal };
}

function configure(dir, settings) {
  mkdirSync(path.join(dir, '.pi'), { recursive: true });
  writeFileSync(path.join(dir, '.pi/paperthin.json'), JSON.stringify(settings));
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  assert.ok(index >= 0, `missing ${flag}`);
  return args[index + 1];
}

function route(dir, options = {}) {
  return routeTask({ task: 'implement', assessment: assessment(), configCwd: dir, ...options });
}

function managed(dir, brief, options = {}) {
  return buildManagedLaunch({ task: 'implement', assessment: assessment(), configCwd: dir, cwd: dir, brief, ...options });
}

function completed(runtime, model, result, metadata = {}) {
  return {
    status: 'completed', exitCode: 0,
    output: typeof result === 'string' ? result : JSON.stringify(result),
    metadata: { route: { runtime, model }, ...metadata },
  };
}

test('modelchk requires exactly the six neutral, nonempty assessment fields', () => {
  const original = assessment();
  assert.deepEqual(validateAssessment(original), original);
  const invalid = [null, [], 'frontier', {}, { ...original, model: 'invented-model' },
    { ...original, recommended_tier: 'premium' }, { ...original, recommended_effort: 'high' }];
  for (const field of Object.keys(original)) {
    const missing = { ...original };
    delete missing[field];
    invalid.push(missing, { ...original, [field]: '' }, { ...original, [field]: '  ' }, { ...original, [field]: false });
  }
  for (const candidate of invalid) assert.throws(() => validateAssessment(candidate), undefined, JSON.stringify(candidate));
});

test('adaptive routing uses task defaults and maps frontier work to the correct Fable role', t => {
  const { dir } = fixture(t);
  const expected = {
    implement: ['sol', 'worker', 'pi', 'gpt-5.6-sol', 'claude-worker'],
    review: ['opus', 'reviewer', 'claude', 'claude-opus-5', 'escalation'],
    analyze: ['opus', 'reviewer', 'claude', 'claude-opus-5', 'escalation'],
    probe: ['sol', 'worker', 'pi', 'gpt-5.6-sol', 'escalation'],
  };
  for (const [task, [profile, role, runtime, model, frontierRole]] of Object.entries(expected)) {
    for (const tier of ['fast', 'standard']) {
      const selected = route(dir, { task, assessment: assessment({ recommended_tier: tier }) });
      assert.deepEqual([selected.profile, selected.role, selected.runtime, selected.model], [profile, role, runtime, model]);
      assert.equal(selected.selection, 'adaptive');
      assert.equal(selected.requiresBillingAuthorization, false);
    }
    const selected = route(dir, { task, assessment: assessment({ recommended_tier: 'frontier' }) });
    assert.equal(selected.profile, 'fable');
    assert.equal(selected.role, frontierRole);
    assert.equal(selected.runtime, 'claude');
    assert.equal(selected.model, 'claude-fable-5-1');
    assert.equal(selected.requiresBillingAuthorization, true);
  }
  assert.throws(() => route(dir, { task: 'deploy' }), /작업/);
});

test('workflow phases select their configured runtime profile independently of tier', t => {
  const { dir } = fixture(t);
  for (const tier of ['fast', 'standard', 'frontier']) {
    for (const [phase, task, profile, runtime] of [
      ['plan_review', 'review', 'fable', 'claude'],
      ['implement', 'implement', 'codex', 'codex'],
      ['code_review', 'review', 'opus', 'claude'],
    ]) {
      const selected = route(dir, { task, phase, assessment: assessment({ recommended_tier: tier }) });
      assert.equal(selected.phase, phase);
      assert.equal(selected.profile, profile);
      assert.equal(selected.runtime, runtime);
      assert.equal(selected.selection, 'phase-default');
      assert.equal(selected.requiresBillingAuthorization, profile === 'fable');
    }
  }
  for (const options of [{ task: 'implement', phase: 'plan_review' }, { task: 'review', phase: 'implement' },
    { task: 'probe', phase: 'code_review' }, { phase: 'deploy' }, { phase: null }]) {
    assert.throws(() => route(dir, options), /phase/);
  }
});

test('phase defaults merge by phase while explicit profiles and effort pins retain priority', t => {
  const { dir, personal } = fixture(t);
  writeFileSync(personal, JSON.stringify({ routing: { phases: { implement: 'sol', plan_review: 'opus' } } }));
  configure(dir, { routing: { phases: { implement: 'codex' } }, roles: { 'codex-worker': { effort: 'low' } } });
  assert.deepEqual(readWorkflowSettings(dir).routing.phases, { plan_review: 'opus', implement: 'codex', code_review: 'opus' });
  const selected = route(dir, { phase: 'implement', assessment: assessment({ recommended_effort: 'exhaustive' }) });
  assert.equal(selected.effort, 'low');
  assert.equal(selected.effortSelection, 'configured');
  assert.equal(route(dir, { phase: 'implement', profile: 'sol' }).profile, 'sol');
  configure(dir, { routing: { pins: { implement: 'sol' } } });
  assert.equal(route(dir, { phase: 'implement' }).selection, 'user-pin');
  assert.throws(() => route(dir, { phase: 'implement', profile: 'codex' }), /고정/);
});

test('phase configuration rejects unknown phases and profiles for another task', t => {
  const { dir } = fixture(t);
  for (const phases of [null, [], { deploy: 'codex' }, { plan_review: 'codex' }, { code_review: 'sol' }, { implement: 'opus' }, { implement: { profile: 'codex' } }]) {
    configure(dir, { routing: { phases } });
    assert.throws(() => readWorkflowSettings(dir), /phase/);
  }
});

test('neutral effort maps independently of tier onto each selected runtime ladder', t => {
  const { dir } = fixture(t);
  const mappings = {
    sol: { glance: 'minimal', measured: 'medium', thorough: 'high', exhaustive: 'max' },
    opus: { glance: 'low', measured: 'high', thorough: 'xhigh', exhaustive: 'max' },
    codex: { glance: 'minimal', measured: 'medium', thorough: 'high', exhaustive: 'max' },
  };
  for (const [profile, efforts] of Object.entries(mappings)) {
    for (const [recommended_effort, expected] of Object.entries(efforts)) {
      const task = profile === 'opus' ? 'review' : 'implement';
      const selected = route(dir, { task, profile, assessment: assessment({ recommended_tier: 'fast', recommended_effort }) });
      assert.equal(selected.effort, expected, `${profile}/${recommended_effort}`);
      assert.equal(selected.effortSelection, 'modelchk-map');
    }
  }
});

test('fixed routing retains default profiles and configured effort despite a frontier recommendation', t => {
  const { dir } = fixture(t);
  configure(dir, { routing: { mode: 'fixed' }, roles: { worker: { effort: 'low' } } });
  const selected = route(dir, { assessment: assessment({ recommended_tier: 'frontier', recommended_effort: 'exhaustive' }) });
  assert.equal(selected.profile, 'sol');
  assert.equal(selected.effort, 'low');
  assert.equal(selected.selection, 'fixed');
  assert.equal(selected.effortSelection, 'configured');
  assert.equal(route(dir, { task: 'review', assessment: assessment({ recommended_tier: 'frontier' }) }).profile, 'opus');
});

test('explicit profiles and user pins are honored without silent conflict resolution', t => {
  const { dir } = fixture(t);
  const explicit = route(dir, { profile: 'sol', assessment: assessment({ recommended_tier: 'frontier' }) });
  assert.equal(explicit.profile, 'sol');
  assert.equal(explicit.selection, 'explicit-profile');
  configure(dir, { routing: { pins: { implement: 'codex', review: 'fable', probe: 'opus' } } });
  assert.equal(route(dir).role, 'codex-worker');
  assert.equal(route(dir).selection, 'user-pin');
  assert.equal(route(dir, { task: 'review' }).role, 'escalation');
  assert.equal(route(dir, { task: 'probe' }).role, 'reviewer');
  assert.equal(route(dir, { profile: 'codex' }).profile, 'codex');
  assert.throws(() => route(dir, { profile: 'fable' }), /고정/);
  assert.throws(() => route(dir, { task: 'analyze', profile: 'sol' }), /profile/);
});

test('project role effort and config origin override recommendations and child worktree settings', t => {
  const { dir, brief } = fixture(t);
  const worktree = path.join(dir, 'isolated worktree');
  mkdirSync(worktree);
  configure(dir, { roles: { worker: { provider: 'origin-provider', model: 'origin-model', effort: 'low' } } });
  configure(worktree, { routing: { mode: 'fixed' }, roles: { worker: { model: 'wrong-worktree-model', effort: 'max' } } });
  const launch = managed(dir, brief, { cwd: worktree, assessment: assessment({ recommended_effort: 'exhaustive' }) });
  assert.equal(launch.route.effortSelection, 'configured');
  assert.equal(launch.route.effort, 'low');
  assert.equal(valueAfter(launch.args, '--thinking'), 'low');
  assert.equal(valueAfter(launch.args, '--model'), 'origin-model');
  assert.equal(valueAfter(launch.args, '--provider'), 'origin-provider');
  assert.equal(valueAfter(launch.args, '--workflow-config'), realpathSync(dir));
  assert.equal(launch.cwd, realpathSync(worktree));
});

test('personal settings merge with project settings without reading the real user configuration', t => {
  const { dir, personal } = fixture(t);
  writeFileSync(personal, JSON.stringify({
    routing: { pins: { implement: 'codex' }, allowFableHeadless: true },
    roles: { reviewer: { effort: 'low' } },
    jobs: { maxConcurrent: 1, maxQueued: 3, timeoutMs: 9000 },
  }));
  configure(dir, { routing: { pins: { implement: 'sol' } }, jobs: { maxConcurrent: 2 } });
  const settings = readWorkflowSettings(dir);
  assert.equal(settings.personalConfig, realpathSync(personal));
  assert.equal(route(dir).profile, 'sol');
  assert.equal(route(dir, { task: 'review', assessment: assessment({ recommended_effort: 'exhaustive' }) }).effort, 'low');
  assert.equal(route(dir, { profile: 'sol' }).selection, 'user-pin');
  assert.deepEqual(settings.jobs, { maxConcurrent: 2, maxQueued: 3, timeoutMs: 9000 });
  assert.equal(route(dir, { task: 'review', profile: 'fable' }).requiresBillingAuthorization, false);
});

test('routing and job configuration reject invalid fields, mappings, booleans, and bounds', t => {
  const { dir } = fixture(t);
  const invalid = [
    { routing: null }, { routing: [] }, { routing: { mode: 'automatic' } },
    { routing: { allowFableHeadless: 'yes' } }, { routing: { fallback: 'sol' } },
    { routing: { pins: [] } }, { routing: { pins: { review: 'sol' } } },
    { routing: { pins: { implement: 'opus' } } }, { routing: { pins: { probe: 'codex' } } },
    { routing: { pins: { deploy: 'fable' } } }, { jobs: null }, { jobs: [] },
    { jobs: { maxConcurrent: 0 } }, { jobs: { maxConcurrent: 5 } }, { jobs: { maxConcurrent: 1.5 } },
    { jobs: { maxQueued: -1 } }, { jobs: { maxQueued: 33 } }, { jobs: { timeoutMs: 999 } },
    { jobs: { timeoutMs: 3600001 } }, { jobs: { timeoutMs: '1000' } }, { jobs: { retries: 10 } },
  ];
  for (const settings of invalid) {
    configure(dir, settings);
    assert.throws(() => readWorkflowSettings(dir), undefined, JSON.stringify(settings));
  }
  configure(dir, { jobs: { maxConcurrent: 4, maxQueued: 0, timeoutMs: 3600000 } });
  assert.deepEqual(readWorkflowSettings(dir).jobs, { maxConcurrent: 4, maxQueued: 0, timeoutMs: 3600000 });
});

test('Fable launch requires recorded headless authorization and never falls back', t => {
  const { dir, brief } = fixture(t);
  const frontier = assessment({ recommended_tier: 'frontier', recommended_effort: 'thorough' });
  assert.throws(() => managed(dir, brief, { assessment: frontier }), /allowFableHeadless/);
  assert.throws(() => managed(dir, brief, { task: 'review', profile: 'fable' }), /allowFableHeadless/);
  configure(dir, { routing: { allowFableHeadless: false }, roles: { reviewer: { model: 'claude-fable-5-1' } } });
  assert.equal(route(dir, { task: 'review' }).requiresBillingAuthorization, true, 'renaming the profile must not bypass the model guard');
  assert.throws(() => managed(dir, brief, { task: 'review' }), /allowFableHeadless/);
  configure(dir, { routing: { allowFableHeadless: true } });
  const launch = managed(dir, brief, { assessment: frontier });
  assert.equal(launch.runtime, 'claude');
  assert.equal(launch.route.role, 'claude-worker');
  assert.equal(valueAfter(launch.args, '--model'), 'claude-fable-5-1');
  assert.equal(valueAfter(launch.args, '--effort'), 'xhigh');
  assert.equal(valueAfter(launch.args, '--permission-mode'), 'acceptEdits');
  assert.equal(launch.route.requiresBillingAuthorization, false);
});

test('managed launch preserves literal requests as one final argv value and disables nested agents', t => {
  const { dir, brief, literal } = fixture(t);
  configure(dir, { routing: { allowFableHeadless: true } });
  for (const [task, profile] of [['implement', 'sol'], ['implement', 'fable'], ['implement', 'codex'], ['review', 'opus']]) {
    const launch = managed(dir, brief, { task, profile });
    assert.equal(launch.args.at(-2), '--');
    assert.equal(launch.args.at(-1), launch.prompt);
    assert.ok(launch.prompt.includes(literal));
    assert.equal(launch.args.filter(arg => arg === '--model').length, 1);
    assert.equal(launch.args.includes('--dangerously-skip-permissions'), false);
    if (launch.runtime === 'pi') {
      assert.equal(valueAfter(launch.args, '--mode'), 'json');
      assert.ok(launch.args.includes('--no-session'));
      assert.ok(launch.args.includes('--no-extensions'));
      assert.equal(valueAfter(launch.args, '--workflow-role'), 'worker');
      assert.equal(valueAfter(launch.args, '--workflow-effort'), 'medium');
    } else if (launch.runtime === 'claude') {
      assert.equal(valueAfter(launch.args, '--disallowedTools'), 'Agent,Task');
      assert.equal(valueAfter(launch.args, '--output-format'), 'json');
      assert.ok(launch.args.includes('--no-session-persistence'));
      assert.equal(launch.env.CLAUDE_CODE_EFFORT_LEVEL, launch.route.effort);
      assert.equal(valueAfter(launch.args, '--permission-mode'), task === 'review' ? 'plan' : 'acceptEdits');
      const settings = JSON.parse(valueAfter(launch.args, '--settings'));
      assert.equal(settings.switchModelsOnFlag, false);
      assert.deepEqual(settings.fallbackModel, []);
      assert.equal(settings.enabledPlugins['compound-engineering@compound-engineering-plugin'], false);
    } else {
      assert.equal(launch.args[0], 'exec');
      assert.ok(launch.args.includes('--json'));
      assert.ok(launch.args.includes('--ephemeral'));
      assert.ok(launch.args.includes('features.multi_agent=false'));
      assert.equal(launch.args.includes('--ask-for-approval'), false);
      assert.equal(valueAfter(launch.args, '--sandbox'), 'workspace-write');
    }
  }
  assert.equal(existsSync(path.join(dir, 'INJECTED')), false);
});

test('selected automatic skills must exist, allow the role, and retain every user-only boundary', t => {
  const { dir, brief } = fixture(t);
  const catalog = JSON.parse(readFileSync(path.join(ROOT, 'config/skills.json'), 'utf8'));
  const source = JSON.parse(readFileSync(path.join(ROOT, 'vendor/paperthin/source.json'), 'utf8'));
  const launch = managed(dir, brief, { skills: ['factchk', 'mandela', 'factchk'] });
  assert.equal(launch.sources.skills.length, 28);
  assert.deepEqual(launch.sources.skills.map(file => path.basename(path.dirname(file))), source.skills);
  const embedded = launch.sources.embeddedSkills.map(file => path.basename(path.dirname(file)));
  assert.ok(embedded.includes('factchk'));
  assert.ok(embedded.includes('mandela'));
  assert.equal(embedded.filter(name => name === 'factchk').length, 1);
  for (const entry of catalog.filter(skill => skill.invocation === 'user')) {
    assert.throws(() => managed(dir, brief, { skills: [entry.name] }), /사용자 직접 호출용/, entry.name);
  }
  for (const name of ['re0-loop', 're0-work', 'autobahn', 'aim', 'catchup', 'nba']) {
    assert.throws(() => managed(dir, brief, { skills: [name] }), /자동 배정/, name);
  }
  assert.throws(() => managed(dir, brief, { task: 'review', skills: ['re0'] }), /자동 배정/);
  assert.throws(() => managed(dir, brief, { skills: ['missing-skill'] }), /알 수 없는/);
  assert.throws(() => managed(dir, brief, { skills: 'factchk' }), /배열/);
});

test('default probes capture an immutable artifact-only snapshot with no tools or project context', t => {
  const { dir, brief, literal } = fixture(t);
  const artifactBytes = readFileSync(brief);
  const launch = buildManagedLaunch({ task: 'probe', assessment: assessment(), cwd: dir, configCwd: dir, artifact: brief });
  assert.equal(launch.runtime, 'pi');
  assert.equal(launch.route.profile, 'sol');
  for (const flag of ['--no-context-files', '--no-skills', '--no-extensions', '--no-prompt-templates', '--no-tools', '--no-session']) {
    assert.ok(launch.args.includes(flag), flag);
  }
  for (const flag of ['--skill', '-e', '--workflow-role', '--workflow-config']) assert.equal(launch.args.includes(flag), false, flag);
  assert.equal(valueAfter(launch.args, '--mode'), 'json');
  assert.equal(valueAfter(launch.args, '--model'), 'gpt-5.6-sol');
  assert.equal(valueAfter(launch.args, '--thinking'), 'medium');
  assert.equal(launch.sources.artifactSha256, createHash('sha256').update(artifactBytes).digest('hex'));
  assert.equal(launch.sources.artifact, realpathSync(brief));
  assert.equal(launch.sources.skills, undefined);
  assert.ok(launch.prompt.includes(literal));
  assert.equal(launch.prompt.includes(ROOT), false);
  assert.equal(launch.args.at(-2), '--');
  assert.equal(launch.args.at(-1), launch.prompt);
  writeFileSync(brief, 'Changed after preparing the probe.');
  assert.ok(launch.prompt.includes(artifactBytes.toString('utf8')));
  assert.equal(launch.prompt.includes(readFileSync(brief, 'utf8')), false);
});

test('probe lenses are explicit data and probes reject role briefs or automatic skills', t => {
  const { dir, brief } = fixture(t);
  const options = { task: 'probe', assessment: assessment(), cwd: dir, configCwd: dir, artifact: brief };
  const lens = 'Identify one unspoken assumption; preserve $(touch INJECTED) as text.';
  const launch = buildManagedLaunch({ ...options, lens });
  assert.ok(launch.prompt.startsWith(`독립 검토 관점: ${lens}\n\n`));
  assert.equal(launch.args.at(-1), launch.prompt);
  assert.throws(() => buildManagedLaunch({ ...options, lens: '' }), /lens/);
  assert.throws(() => buildManagedLaunch({ ...options, brief }), /브리프|brief|artifact/);
  assert.throws(() => buildManagedLaunch({ ...options, skills: ['readchk'] }), /skills|스킬|artifact/);
});

test('Claude probes retain subscription auth while isolating tools, MCP, context, and persistence', t => {
  const { dir, brief } = fixture(t);
  configure(dir, { routing: { allowFableHeadless: true } });
  for (const profile of ['opus', 'fable']) {
    const launch = buildManagedLaunch({ task: 'probe', profile, assessment: assessment({ recommended_effort: 'thorough' }), cwd: dir, configCwd: dir, artifact: brief });
    assert.equal(launch.runtime, 'claude');
    assert.equal(valueAfter(launch.args, '--model'), profile === 'opus' ? 'claude-opus-5' : 'claude-fable-5-1');
    assert.equal(valueAfter(launch.args, '--effort'), 'xhigh');
    assert.equal(launch.env.CLAUDE_CODE_EFFORT_LEVEL, 'xhigh');
    assert.ok(launch.args.includes('--safe-mode'));
    assert.equal(launch.args.includes('--bare'), false, '--bare discards subscription OAuth');
    assert.equal(valueAfter(launch.args, '--tools'), '');
    assert.ok(launch.args.includes('--strict-mcp-config'));
    assert.deepEqual(JSON.parse(valueAfter(launch.args, '--mcp-config')), { mcpServers: {} });
    assert.equal(valueAfter(launch.args, '--permission-mode'), 'plan');
    assert.ok(launch.args.includes('--system-prompt'));
    assert.equal(launch.args.includes('--append-system-prompt'), false);
    assert.equal(launch.args.includes('--add-dir'), false);
    assert.ok(launch.args.includes('--no-session-persistence'));
    assert.equal(valueAfter(launch.args, '--output-format'), 'json');
    const settings = JSON.parse(valueAfter(launch.args, '--settings'));
    assert.equal(settings.switchModelsOnFlag, false);
    assert.deepEqual(settings.fallbackModel, []);
  }
});

test('Claude launch environment overrides inherited effort with the selected concrete level', t => {
  const { dir, brief } = fixture(t);
  const previous = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  process.env.CLAUDE_CODE_EFFORT_LEVEL = 'max';
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    else process.env.CLAUDE_CODE_EFFORT_LEVEL = previous;
  });
  configure(dir, { routing: { allowFableHeadless: true }, roles: { reviewer: { effort: 'low' } } });
  const review = managed(dir, brief, { task: 'review', assessment: assessment({ recommended_effort: 'exhaustive' }) });
  assert.equal(review.route.effortSelection, 'configured');
  assert.equal(review.route.effort, 'low');
  assert.equal(valueAfter(review.args, '--effort'), 'low');
  assert.equal(review.env.CLAUDE_CODE_EFFORT_LEVEL, 'low');
  const probe = buildManagedLaunch({
    task: 'probe', profile: 'fable', assessment: assessment({ recommended_effort: 'glance' }),
    cwd: dir, configCwd: dir, artifact: brief,
  });
  assert.equal(probe.route.effort, 'low');
  assert.equal(valueAfter(probe.args, '--effort'), 'low');
  assert.equal(probe.env.CLAUDE_CODE_EFFORT_LEVEL, 'low');
  assert.equal(process.env.CLAUDE_CODE_EFFORT_LEVEL, 'max', 'preparing a child does not mutate the parent environment');
});

test('completed Claude process reports permission denials and runtime failures independently of exit zero', () => {
  const denials = [{ tool_name: 'Bash', tool_use_id: 'tool-1', tool_input: { command: 'npm test' } }];
  const interpreted = interpretJob(completed('claude', 'claude-opus-5', {
    type: 'result', is_error: true, result: 'The test command was denied.',
    modelUsage: { 'claude-opus-5': {} }, permission_denials: denials,
  }));
  assert.equal(interpreted.exitCode, 0);
  assert.equal(interpreted.runtimeError, true);
  assert.deepEqual(interpreted.permissionDenials, denials);
  assert.equal(interpreted.interpretation, 'The test command was denied.');
  assert.equal(interpreted.modelVerified, true);
  const deniedOnly = interpretJob(completed('claude', 'claude-opus-5', {
    result: 'A partial read completed.', is_error: false,
    modelUsage: { 'claude-opus-5': {} }, permission_denials: denials,
  }));
  assert.deepEqual(deniedOnly.permissionDenials, denials);
});

test('reported model mismatches survive successful text and dated identifiers match only their configured model', () => {
  const mismatch = interpretJob(completed('claude', 'claude-fable-5-1', {
    result: 'APPROVED', modelUsage: { 'claude-fable-5-1': {}, 'claude-opus-5': {} },
  }));
  assert.deepEqual(mismatch.reportedModels, ['claude-fable-5-1', 'claude-opus-5']);
  assert.deepEqual(mismatch.mismatchedModels, ['claude-opus-5']);
  assert.equal(mismatch.modelVerified, false);
  assert.equal(mismatch.interpretation, 'APPROVED');
  const dated = interpretJob(completed('claude', 'claude-opus-5', {
    result: 'Review complete.', modelUsage: { 'claude-opus-5-20260915': {} },
  }));
  assert.equal(dated.modelVerified, true);
  assert.deepEqual(dated.mismatchedModels, []);
  const noEvidence = interpretJob(completed('claude', 'claude-opus-5', { result: 'Done.' }));
  assert.equal(noEvidence.modelVerified, false);
});

test('Pi JSONL interpretation extracts the final assistant text and retains failures from earlier messages', () => {
  const lines = [
    { type: 'session', id: 'fixture-only' },
    { type: 'message_end', message: { role: 'assistant', model: 'gpt-5.6-sol', stopReason: 'error', content: [{ type: 'text', text: 'First attempt failed.' }] } },
    { type: 'message_end', message: { role: 'toolResult', content: [{ type: 'text', text: 'TOOL OUTPUT' }] } },
    { type: 'message_end', message: { role: 'assistant', model: 'gpt-5.6-sol', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'Hidden deliberation' }, { type: 'text', text: 'Final result.' }, { type: 'text', text: 'Evidence attached.' }] } },
  ].map(event => JSON.stringify(event)).join('\n') + '\n';
  const interpreted = interpretJob(completed('pi', 'gpt-5.6-sol', lines));
  assert.equal(interpreted.interpretation, 'Final result.\nEvidence attached.');
  assert.deepEqual(interpreted.reportedModels, ['gpt-5.6-sol']);
  assert.equal(interpreted.modelVerified, true);
  assert.equal(interpreted.runtimeError, true);
  assert.equal(interpreted.interpretation.includes('Hidden deliberation'), false);
  const mismatch = interpretJob(completed('pi', 'gpt-5.6-sol', JSON.stringify({
    type: 'message_end', message: { role: 'assistant', model: 'gpt-6-astra', stopReason: 'aborted', content: [{ type: 'text', text: 'Cancelled.' }] },
  })));
  assert.equal(mismatch.runtimeError, true);
  assert.equal(mismatch.modelVerified, false);
  assert.deepEqual(mismatch.mismatchedModels, ['gpt-6-astra']);
});

test('empty or missing Claude and Pi final results are runtime failures even with exit zero', () => {
  const cases = [
    ['claude', 'null'],
    ['claude', {}],
    ['claude', { result: '' }],
    ['claude', { result: '   \n' }],
    ['claude', { result: null }],
    ['claude', { result: 42 }],
    ['claude', { errors: ['No result was produced.'] }],
    ['pi', 'null'],
    ['pi', JSON.stringify({ type: 'session', id: 'started-but-no-answer' })],
    ['pi', JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fixture-model', content: [] } })],
    ['pi', JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fixture-model', content: [{ type: 'thinking', thinking: 'No deliverable.' }] } })],
    ['pi', JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fixture-model', content: [{ type: 'text', text: '  \n' }] } })],
  ];
  for (const [runtime, result] of cases) {
    const interpreted = interpretJob(completed(runtime, 'fixture-model', result));
    assert.equal(interpreted.runtimeError, true, `${runtime}: ${JSON.stringify(result)}`);
    assert.equal(interpreted.exitCode, 0);
    assert.equal(typeof interpreted.interpretation, 'string');
  }
  for (const runtime of ['claude', 'pi']) {
    for (const output of ['', undefined]) {
      const interpreted = interpretJob({
        status: 'completed', exitCode: 0, ...(output === undefined ? {} : { output }),
        metadata: { route: { runtime, model: 'fixture-model' } },
      });
      assert.equal(interpreted.runtimeError, true, `${runtime}: ${String(output)}`);
      assert.equal(typeof interpreted.interpretation, 'string');
    }
  }
});

test('Codex JSONL extracts the final agent message and preserves turn failures and model evidence', () => {
  const events = [
    { type: 'thread.started', thread_id: 'fixture-only', model: 'gpt-5.6-sol' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Initial progress.' } },
    { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'Unrelated command output.' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Final answer with evidence.' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 20 } },
  ];
  const jsonl = entries => entries.map(event => JSON.stringify(event)).join('\n') + '\n';
  const success = interpretJob(completed('codex', 'gpt-5.6-sol', jsonl(events)));
  assert.equal(success.interpretation, 'Final answer with evidence.');
  assert.equal(success.runtimeError, false);
  assert.equal(success.modelVerified, true);
  assert.deepEqual(success.reportedModels, ['gpt-5.6-sol']);
  for (const failure of [{ type: 'turn.failed', error: { message: 'Request failed.' } }, { type: 'error', message: 'Connection lost.' }]) {
    const failed = interpretJob(completed('codex', 'gpt-5.6-sol', jsonl([...events, failure])));
    assert.equal(failed.runtimeError, true);
    assert.equal(failed.interpretation, 'Final answer with evidence.');
  }
  const missing = interpretJob(completed('codex', 'gpt-5.6-sol', jsonl([{ type: 'turn.completed' }])));
  assert.equal(missing.runtimeError, true);
  assert.equal(missing.modelVerified, false);
  const noModel = interpretJob(completed('codex', 'gpt-5.6-sol', jsonl(events.slice(1))));
  assert.equal(noModel.runtimeError, false);
  assert.equal(noModel.modelVerified, false, 'a successful answer does not invent model identity');
  const mismatch = interpretJob(completed('codex', 'gpt-5.6-sol', jsonl([{ ...events[0], model: 'gpt-6-astra' }, ...events.slice(1)])));
  assert.deepEqual(mismatch.mismatchedModels, ['gpt-6-astra']);
  assert.equal(mismatch.modelVerified, false);
});

test('malformed runtime JSON never becomes a clean completion and stdout artifacts retain probe identity', t => {
  const { dir } = fixture(t);
  for (const runtime of ['pi', 'claude', 'codex']) {
    const interpreted = interpretJob(completed(runtime, 'fixture-model', '{invalid JSON'));
    assert.equal(interpreted.runtimeError, true);
    assert.equal(interpreted.modelVerified, false);
    assert.ok(interpreted.interpretation.includes('{invalid JSON'));
  }
  const stdout = path.join(dir, 'stdout.json');
  writeFileSync(stdout, JSON.stringify({ result: 'Read from persisted stdout.', modelUsage: { 'claude-opus-5': {} } }));
  const artifactSha256 = 'a'.repeat(64);
  const interpreted = interpretJob({
    ...completed('claude', 'claude-opus-5', 'stale preview', { sources: { artifactSha256 } }),
    paths: { stdout },
  });
  assert.equal(interpreted.interpretation, 'Read from persisted stdout.');
  assert.equal(interpreted.artifactSha256, artifactSha256);
  assert.equal(interpreted.runtimeError, false);
  const running = { status: 'running', output: '{incomplete', metadata: { route: { runtime: 'pi', model: 'fixture-model' } } };
  assert.equal(interpretJob(running), running);
});

function reviewTarget(phase = 'code_review') {
  return { planSha256: 'a'.repeat(64), baseSha: phase === 'plan_review' ? null : 'b'.repeat(40), candidateSha: phase === 'plan_review' ? null : 'c'.repeat(40) };
}

function reviewResult(phase = 'code_review', overrides = {}) {
  return { phase, ...reviewTarget(phase), verdict: 'approve', findings: [], ...overrides };
}

function reviewJob(result, { phase = 'code_review', target = reviewTarget(phase), envelope = {} } = {}) {
  return completed('claude', 'claude-opus-5', {
    result: typeof result === 'string' ? result : JSON.stringify(result), modelUsage: { 'claude-opus-5': {} }, ...envelope,
  }, { route: { task: 'review', phase, runtime: 'claude', model: 'claude-opus-5' }, reviewTarget: target });
}

test('managed phase reviews require exact immutable targets and native JSON schema output', t => {
  const { dir, brief } = fixture(t);
  configure(dir, { routing: { allowFableHeadless: true } });
  for (const phase of ['plan_review', 'code_review']) {
    const target = reviewTarget(phase);
    const launch = managed(dir, brief, { task: 'review', phase, reviewTarget: target });
    assert.deepEqual(launch.reviewTarget, target);
    assert.notEqual(launch.reviewTarget, target);
    assert.ok(launch.prompt.includes(JSON.stringify(target)));
    const schema = JSON.parse(valueAfter(launch.args, '--json-schema'));
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ['phase', 'planSha256', 'baseSha', 'candidateSha', 'verdict', 'findings']);
    assert.deepEqual(schema.properties.phase.enum, [phase]);
    assert.deepEqual(schema.properties.planSha256.enum, [target.planSha256]);
    assert.equal(launch.args.at(-1), launch.prompt);
    assert.throws(() => managed(dir, brief, { task: 'review', phase }), /reviewTarget/);
  }
  const target = reviewTarget();
  for (const invalid of [null, {}, { ...target, planSha256: null }, { ...target, baseSha: 'main' },
    { ...target, candidateSha: 'c'.repeat(39) }, { ...target, extra: true }]) {
    assert.throws(() => managed(dir, brief, { task: 'review', phase: 'code_review', reviewTarget: invalid }), /reviewTarget/);
  }
  assert.throws(() => managed(dir, brief, { task: 'review', phase: 'plan_review', reviewTarget: target }), /reviewTarget/);
  assert.throws(() => managed(dir, brief, { phase: 'implement', reviewTarget: target }), /reviewTarget/);
  const legacy = managed(dir, brief, { task: 'review' });
  assert.equal(legacy.args.includes('--json-schema'), false);
});

test('review parsing binds the exact phase, plan and candidate without treating free text as approval', () => {
  const valid = interpretJob(reviewJob(reviewResult()));
  assert.deepEqual(valid.reviewResult, reviewResult());
  assert.equal(valid.reviewResultError, null);
  assert.equal(valid.runtimeError, false);
  const changes = reviewResult('code_review', { verdict: 'changes_requested', findings: [{ severity: 'blocking', message: 'Missing regression check.' }] });
  assert.deepEqual(interpretJob(reviewJob(changes)).reviewResult, changes);
  const plan = reviewResult('plan_review');
  assert.deepEqual(interpretJob(reviewJob(plan, { phase: 'plan_review' })).reviewResult, plan);
  const invalid = ['APPROVED', 'Before ' + JSON.stringify(reviewResult()), '```json\n' + JSON.stringify(reviewResult()) + '\n```',
    reviewResult('plan_review'), reviewResult('code_review', { planSha256: 'd'.repeat(64) }),
    reviewResult('code_review', { baseSha: 'd'.repeat(40) }), reviewResult('code_review', { candidateSha: 'd'.repeat(40) }),
    reviewResult('code_review', { unexpected: true }), reviewResult('code_review', { verdict: 'approved' }),
    reviewResult('code_review', { findings: [{ severity: 'blocking', message: 'A bug.' }] }),
    reviewResult('code_review', { findings: [{ severity: 'minor', message: 'A note.' }] }),
    reviewResult('code_review', { findings: [{ severity: 'non_blocking', message: ' ' }] }),
    reviewResult('code_review', { findings: [{ severity: 'non_blocking', message: 'A note.', extra: true }] }),
    reviewResult('code_review', { findings: {} })];
  for (const result of invalid) {
    const parsed = interpretJob(reviewJob(result));
    assert.equal(parsed.reviewResult, null, JSON.stringify(result));
    assert.equal(typeof parsed.reviewResultError, 'string');
    assert.equal(parsed.runtimeError, false, 'schema errors are distinct from CLI failure');
    assert.equal(parsed.modelVerified, true);
  }
  assert.equal(interpretJob(reviewJob(reviewResult(), { target: undefined })).reviewResultError, null);
  assert.ok(interpretJob(reviewJob(reviewResult(), { target: null })).reviewResultError);
});

test('native structured output is parsed while runtime failures and model mismatches stay distinct', () => {
  const native = interpretJob(reviewJob('', { envelope: { structured_output: reviewResult() } }));
  assert.deepEqual(native.reviewResult, reviewResult());
  assert.equal(native.runtimeError, false);
  const runtimeFailed = interpretJob(reviewJob(reviewResult(), { envelope: { is_error: true } }));
  assert.equal(runtimeFailed.runtimeError, true);
  assert.deepEqual(runtimeFailed.reviewResult, reviewResult());
  const modelFailed = interpretJob(reviewJob(reviewResult(), { envelope: { modelUsage: { 'claude-fable-5-1': {} } } }));
  assert.equal(modelFailed.modelVerified, false);
  assert.equal(modelFailed.reviewResultError, null);
  const legacy = interpretJob(completed('claude', 'claude-opus-5', { result: 'Review finished.' }));
  assert.equal(legacy.reviewResult, null);
  assert.equal(legacy.reviewResultError, null);
});

test('usage extracts reported token totals and USD without inventing unavailable costs', () => {
  const claude = interpretJob(completed('claude', 'claude-opus-5', {
    result: 'Done', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 }, total_cost_usd: 0.123,
  }));
  assert.deepEqual(claude.usage, { inputTokens: 45, outputTokens: 20, cachedInputTokens: 30, totalTokens: 65, costUsd: 0.123 });
  const events = [{ type: 'item.completed', item: { type: 'agent_message', text: 'Done' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 20, cached_input_tokens: 5 } },
    { type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 6, cached_input_tokens: 0 } }];
  const codex = interpretJob(completed('codex', 'gpt-5.6-sol', events.map(event => JSON.stringify(event)).join('\n')));
  assert.deepEqual(codex.usage, { inputTokens: 14, outputTokens: 26, cachedInputTokens: 5, totalTokens: 40, costUsd: null });
  const pi = interpretJob(completed('pi', 'gpt-5.6-sol', JSON.stringify({ type: 'message_end', message: {
    role: 'assistant', content: [{ type: 'text', text: 'Done' }],
    usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 5, totalTokens: 65, cost: { total: 0.5 } },
  } })));
  assert.deepEqual(pi.usage, { inputTokens: 45, outputTokens: 20, cachedInputTokens: 30, totalTokens: 65, costUsd: 0.5 });
  const missing = interpretJob(completed('claude', 'claude-opus-5', { result: 'Done' }));
  assert.deepEqual(missing.usage, { inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null, costUsd: null });
  const invalid = interpretJob(completed('claude', 'claude-opus-5', { result: 'Done', usage: { input_tokens: -1, output_tokens: '4' }, total_cost_usd: -1 }));
  assert.deepEqual(invalid.usage, missing.usage);
});

test('managed launches bind routing and argv to one configuration read', t => {
  const { dir, brief, personal } = fixture(t);
  configure(dir, {});
  // Each case runs in an isolated process: replacing the config after its first read
  // models an atomic edit without patching builtins used by other test files.
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const { buildManagedLaunch } = await import(process.argv[1]);
    const input = JSON.parse(process.argv[2]);
    const original = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = function(file, ...args) {
      const result = original.call(this, file, ...args);
      if (file === input.configPath) {
        reads++;
        if (reads === 1) fs.writeFileSync(file, JSON.stringify(input.changed));
      }
      return result;
    };
    syncBuiltinESMExports();
    let launch;
    try { launch = buildManagedLaunch(input.options); }
    finally { fs.readFileSync = original; syncBuiltinESMExports(); }
    assert.equal(reads, 1);
    const flag = name => launch.args[launch.args.indexOf(name) + 1];
    assert.equal(flag('--model'), launch.route.model);
    assert.equal(flag(launch.runtime === 'pi' ? '--thinking' : '--effort'), launch.route.effort);
    if (launch.runtime === 'pi') assert.equal(flag('--provider'), launch.route.provider);
    assert.equal(launch.route.requiresBillingAuthorization, false);
    if (launch.runtime === 'claude') {
      assert.equal(launch.route.model, 'claude-opus-5');
      assert.match(flag('--append-system-prompt'), /설정된 모델: claude-opus-5;/);
      assert.throws(() => buildManagedLaunch(input.options), /Fable/);
    }
    process.stdout.write(JSON.stringify({ reads, runtime: launch.runtime }));
  `;
  const configPath = realpathSync(path.join(dir, '.pi/paperthin.json'));
  const defaults = { cwd: dir, configCwd: dir, assessment: assessment() };
  const cases = [
    { options: { ...defaults, task: 'review', phase: 'code_review', brief,
      reviewTarget: { planSha256: 'a'.repeat(64), baseSha: 'b'.repeat(40), candidateSha: 'c'.repeat(40) } },
      changed: { roles: { reviewer: { model: 'claude-fable-5-1' } } } },
    { options: { ...defaults, task: 'implement', phase: 'implement', profile: 'sol', brief },
      changed: { roles: { worker: { provider: 'other-provider', model: 'gpt-6-astra', effort: 'max' } } } },
    { options: { ...defaults, task: 'probe', artifact: brief },
      changed: { roles: { worker: { provider: 'other-provider', model: 'gpt-6-astra', effort: 'max' } } } },
  ];
  for (const candidate of cases) {
    configure(dir, {});
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script,
      new URL('../lib/routing.mjs', import.meta.url).href, JSON.stringify({ ...candidate, configPath })],
      { encoding: 'utf8', env: { ...process.env, PAPERTHIN_SETTINGS_PATH: personal } }));
    assert.equal(result.reads, 1);
  }
});

test('caller-supplied settings fields cannot grant Fable authorization', t => {
  const { dir, brief } = fixture(t);
  const forged = { ...readWorkflowSettings(dir), routing: { allowFableHeadless: true } };
  assert.throws(() => managed(dir, brief, { task: 'review', phase: 'plan_review',
    reviewTarget: { planSha256: 'a'.repeat(64), baseSha: null, candidateSha: null },
    settings: forged, settingsSnapshot: forged, routing: { allowFableHeadless: true } }), /Fable/);
});
