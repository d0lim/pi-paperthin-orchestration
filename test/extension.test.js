import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { buildLaunch, ROOT } from '../lib/runtime.mjs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

process.env.PAPERTHIN_SETTINGS_PATH = path.join(os.tmpdir(), `paperthin-no-user-${randomUUID()}.json`);

const extensionPath = path.join(ROOT, 'extensions/workflow.ts');
function installedPiPackage() {
  const candidates = [];
  if (process.env.PI_PACKAGE_DIR) candidates.push(process.env.PI_PACKAGE_DIR);
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    try {
      let current = path.dirname(realpathSync(path.join(directory, 'pi')));
      for (let depth = 0; depth < 6; depth++) {
        candidates.push(current, path.join(current, 'libexec/lib/node_modules/@earendil-works/pi-coding-agent'));
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  for (const candidate of candidates) {
    try {
      const metadata = JSON.parse(readFileSync(path.join(candidate, 'package.json'), 'utf8'));
      if (['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent'].includes(metadata.name) &&
          existsSync(path.join(candidate, 'dist/core/extensions/loader.js'))) return candidate;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  return null;
}


function fixture(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'paperthin-extension '));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const brief = path.join(cwd, 'brief with spaces.md');
  writeFileSync(brief, 'Read only. Keep $(touch NEVER_RUN) literal.');
  return { cwd, brief };
}

function harness(cwd, role) {
  const handlers = new Map(), commands = new Map(), tools = new Map();
  const flags = new Map(role === undefined ? [] : [['workflow-role', role]]);
  const messages = [], requests = [], selections = [], entries = [], executions = [];
  const state = {
    model: { provider: 'ordinary', id: 'unchanged' }, effort: 'low',
    idle: true, authenticated: true, trusted: true, branch: [], prompt: 'Ordinary project prompt.',
    execResult: { stdout: 'Independent reading.', stderr: '', code: 0, killed: false },
    available: { provider: 'openai-codex', id: 'gpt-6-astra' },
  };
  const api = {
    on(name, handler) { handlers.set(name, handler); },
    registerFlag(name, options) { if (!flags.has(name) && options.default !== undefined) flags.set(name, options.default); },
    getFlag(name) { return flags.get(name); },
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { tools.set(tool.name, tool); },
    getThinkingLevel() { return state.effort; },
    setThinkingLevel(level) { state.effort = level; },
    async setModel(model) {
      selections.push(model);
      if (state.authenticated) state.model = model;
      return state.authenticated;
    },
    appendEntry(type, data) { entries.push({ type, data }); },
    sendMessage(message, options) { messages.push({ message, options }); },
    sendUserMessage(message, options) { requests.push({ message, options }); },
    getActiveTools() { return ['herdr_delegate']; },
    async exec(command, args, options) { executions.push({ command, args, options }); return state.execResult; },
  };
  const ctx = {
    cwd, hasUI: false,
    get model() { return state.model; },
    isIdle: () => state.idle,
    isProjectTrusted: () => state.trusted,
    getSystemPrompt: () => state.prompt,
    modelRegistry: { find(provider, id) {
      return state.available?.provider === provider && state.available?.id === id ? state.available : undefined;
    } },
    sessionManager: { getBranch: () => state.branch },
    ui: { setStatus() {}, editor: async () => undefined },
  };
  return { api, ctx, state, handlers, commands, tools, flags, messages, requests, selections, entries, executions };
}

function configure(h, role) {
  h.state.model = { provider: 'openai-codex', id: role === 'worker' ? 'gpt-5.6-sol' : 'gpt-6-astra' };
  h.state.effort = role === 'worker' ? 'medium' : 'high';
}

function fakeJobs(options) {
  const records = new Map();
  return {
    options, disposed: false,
    submit({ launch, label, metadata }) {
      const job = { id: `job-${records.size + 1}`, status: 'running', label, cwd: launch.cwd, metadata, launch, paths: {}, output: '', stderr: '' };
      records.set(job.id, job);
      return { ...job };
    },
    list() { return [...records.values()].map(job => ({ ...job })); },
    get(id) { if (!records.has(id)) throw new Error('Unknown owned job'); return { ...records.get(id) }; },
    async wait(id, { signal } = {}) { signal?.throwIfAborted(); return this.get(id); },
    cancel(id) { this.get(id); records.get(id).status = 'cancelled'; return this.get(id); },
    async dispose() { this.disposed = true; for (const job of records.values()) if (['queued', 'running'].includes(job.status)) job.status = 'cancelled'; },
    complete(id, text) {
      const job = records.get(id);
      const { runtime, model } = job.metadata.route;
      const output = runtime === 'claude'
        ? JSON.stringify({ type: 'result', result: text, is_error: false, modelUsage: { [model]: {} } })
        : runtime === 'codex'
          ? [
            { type: 'thread.started', thread_id: `thread-${id}`, model },
            { type: 'item.completed', item: { type: 'agent_message', text } },
            { type: 'turn.completed' },
          ].map(event => JSON.stringify(event)).join('\n')
          : JSON.stringify({ type: 'message_end', message: { role: 'assistant', model, content: [{ type: 'text', text }] } });
      Object.assign(job, { status: 'completed', exitCode: 0, output });
    },
  };
}

const assessment = { recommended_tier: 'standard', recommended_effort: 'thorough', rationale: 'Bounded code work', move_up_if: 'Risk increases', move_down_if: 'Mechanical change', proof_surface: 'Tests and independent review' };

const sdk = installedPiPackage();
test('installable extension contract without model or Herdr calls', {
  skip: sdk ? false : 'Installed Pi SDK unavailable.',
}, async (t) => {
  const requirePi = createRequire(path.join(sdk, 'package.json'));
  const jitiManifest = requirePi.resolve('jiti/package.json');
  const jitiMetadata = JSON.parse(readFileSync(jitiManifest, 'utf8'));
  const jitiEntry = path.resolve(path.dirname(jitiManifest), jitiMetadata.exports['./static'].import);
  const { createJiti } = await import(pathToFileURL(jitiEntry).href);
  const typebox = await import(pathToFileURL(requirePi.resolve('typebox')).href);
  const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false, virtualModules: { typebox } });
  const factory = await jiti.import(extensionPath, { default: true });
  function setup(cwd, role) {
    const h = harness(cwd, role);
    h.managers = [];
    factory(h.api, options => { const manager = fakeJobs(options); h.managers.push(manager); return manager; });
    return h;
  }
  async function status(h) {
    await h.commands.get('workflow').handler('', h.ctx);
    return JSON.parse(h.messages.at(-1).message.content);
  }

  await t.test('installed Pi loader registers commands and tools without implicit activation', async () => {
    const { loadExtensions } = await import(pathToFileURL(path.join(sdk, 'dist/core/extensions/loader.js')).href);
    const loaded = await loadExtensions([extensionPath], ROOT);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    assert.equal(extension.flags.get('workflow-role').default, undefined);
    for (const name of ['workflow', 'lead']) assert.ok(extension.commands.has(name));
    for (const name of ['workflow_prepare', 'workflow_cold_read', 'workflow_spawn', 'workflow_jobs', 'workflow_skills', 'workflow_run', 'workflow_tab']) assert.ok(extension.tools.has(name));
    assert.ok(extension.handlers.has('input'));
    assert.ok(!extension.handlers.has('resources_discover'), 'manifest alone supplies skills');
  });

  await t.test('plain Pi requests and system prompt remain untouched before activation', async (st) => {
    const { cwd } = fixture(st), h = setup(cwd);
    h.state.trusted = false;
    writeFileSync(path.join(cwd, 'AGENTS.md'), 'Untrusted project instruction.');
    assert.deepEqual(h.handlers.get('input')({}, h.ctx), { action: 'continue' });
    assert.equal(h.handlers.get('before_agent_start')({ systemPrompt: 'Original' }, h.ctx), undefined);
    assert.equal((await status(h)).active, false);
    assert.deepEqual(h.state.model, { provider: 'ordinary', id: 'unchanged' });
    assert.equal(h.state.effort, 'low');
    assert.equal(h.selections.length + h.requests.length + h.entries.length + h.executions.length, 0);
    for (const tool of h.tools.values()) {
      if (tool.name === 'workflow_skills') continue;
      await assert.rejects(() => tool.execute('inactive', {}, undefined, undefined, h.ctx), /Lead/);
    }
  });

  await t.test('lead selects exact authenticated configuration and persists activation before sending literal request', async (st) => {
    const { cwd } = fixture(st), h = setup(cwd);
    const request = '  Implement $(touch NEVER_RUN).\nKeep every line.  ';
    await h.commands.get('lead').handler(request, h.ctx);
    assert.deepEqual(h.selections, [{ provider: 'openai-codex', id: 'gpt-6-astra' }]);
    assert.equal(h.state.effort, 'high');
    assert.deepEqual(h.entries, [{ type: 'paperthin-workflow', data: { role: 'lead', cwd: path.resolve(cwd) } }]);
    assert.deepEqual(h.requests, [{ message: request, options: { deliverAs: 'followUp', expandPromptTemplates: false } }]);
    assert.equal((await status(h)).active, true);
    const injected = h.handlers.get('before_agent_start')({ systemPrompt: 'Original' }, h.ctx);
    assert.match(injected.systemPrompt, /<pi-paperthin-role:lead>/);
    assert.ok(injected.systemPrompt.startsWith('Original'));
    h.state.prompt = injected.systemPrompt;
    assert.equal(h.handlers.get('before_agent_start')({ systemPrompt: injected.systemPrompt }, h.ctx), undefined);
    assert.equal(h.executions.length, 0);
    assert.equal(existsSync(path.join(cwd, 'NEVER_RUN')), false);
  });

  await t.test('help, headless empty input and editor cancellation never activate', async (st) => {
    const { cwd } = fixture(st);
    for (const args of ['', ' \n ', '--help', '-h', 'help']) {
      const h = setup(cwd);
      await h.commands.get('lead').handler(args, h.ctx);
      assert.equal(h.messages.at(-1).message.customType, 'workflow-help');
      assert.equal(h.selections.length + h.entries.length + h.requests.length, 0);
    }
    for (const answer of [undefined, '', ' \n ']) {
      const h = setup(cwd);
      h.ctx.hasUI = true;
      h.ctx.ui.editor = async () => answer;
      await h.commands.get('lead').handler('', h.ctx);
      assert.equal(h.selections.length + h.entries.length + h.requests.length + h.messages.length, 0);
    }
    const h = setup(cwd);
    h.ctx.hasUI = true;
    h.ctx.ui.editor = async () => 'Investigate\nthis project.';
    await h.commands.get('lead').handler('', h.ctx);
    assert.equal(h.requests[0].message, 'Investigate\nthis project.');
    assert.equal(h.entries[0].data.role, 'lead');
  });

  await t.test('missing model, failed authentication and untrusted project prevent activation and request', async (st) => {
    const { cwd } = fixture(st);
    for (const reason of ['missing', 'auth', 'trust']) {
      const h = setup(cwd);
      if (reason === 'missing') h.state.available = undefined;
      if (reason === 'auth') h.state.authenticated = false;
      if (reason === 'trust') {
        h.state.trusted = false;
        writeFileSync(path.join(cwd, 'AGENTS.md'), 'Project policy.');
      }
      await h.commands.get('lead').handler('Implement a change.', h.ctx);
      assert.equal(h.messages.at(-1).message.customType, 'workflow-error', reason);
      assert.equal(h.requests.length + h.entries.length, 0, reason);
      assert.equal(h.state.effort, 'low', reason);
      assert.deepEqual(h.state.model, { provider: 'ordinary', id: 'unchanged' });
      assert.equal(h.executions.length, 0);
    }
  });

  await t.test('inactive busy sessions reject activation while active busy Lead queues follow-up', async (st) => {
    const { cwd } = fixture(st), h = setup(cwd);
    h.state.idle = false;
    await h.commands.get('lead').handler('Next work.', h.ctx);
    assert.equal(h.requests.length + h.selections.length + h.entries.length, 0);
    h.state.idle = true;
    await h.commands.get('lead').handler('First work.', h.ctx);
    h.state.idle = false;
    await h.commands.get('lead').handler('Next work.', h.ctx);
    assert.equal(h.selections.length, 1);
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.requests[1].options, { deliverAs: 'followUp', expandPromptTemplates: false });
    await h.commands.get('workflow').handler('off', h.ctx);
    assert.equal(h.entries.length, 1, 'busy off must not persist deactivation');
  });

  await t.test('explicit roles validate model and policy without selecting or persisting another model', async (st) => {
    const { cwd } = fixture(st);
    for (const role of ['lead', 'worker']) {
      const h = setup(cwd, role);
      configure(h, role);
      assert.equal(h.handlers.get('input')({}, h.ctx).action, 'continue');
      for (const mismatch of ['provider', 'model', 'effort', 'policy']) {
        configure(h, role);
        h.state.prompt = 'Original';
        if (mismatch === 'provider') h.state.model.provider = 'fallback';
        if (mismatch === 'model') h.state.model.id = 'fallback';
        if (mismatch === 'effort') h.state.effort = 'low';
        if (mismatch === 'policy') h.state.prompt = '<pi-paperthin-role:lead>\n<pi-paperthin-role:worker>';
        assert.equal(h.handlers.get('input')({}, h.ctx).action, 'handled', role + ': ' + mismatch);
      }
      assert.equal(h.selections.length + h.entries.length + h.executions.length, 0);
      await h.commands.get('workflow').handler('off', h.ctx);
      assert.equal(h.messages.at(-1).message.customType, 'workflow-error');
    }
    const invalid = setup(cwd, 'reviewer');
    assert.equal(invalid.handlers.get('input')({}, invalid.ctx).action, 'handled');
    const worker = setup(cwd, 'worker');
    configure(worker, 'worker');
    await worker.commands.get('lead').handler('Do lead work.', worker.ctx);
    assert.equal(worker.requests.length + worker.selections.length, 0);
    await assert.rejects(() => worker.tools.get('workflow_prepare').execute('x', {}, undefined, undefined, worker.ctx), /Lead/);
  });

  await t.test('off deactivates input and policy while retaining the selected model', async (st) => {
    const { cwd } = fixture(st), h = setup(cwd);
    await h.commands.get('lead').handler('Inspect.', h.ctx);
    await h.commands.get('workflow').handler('off', h.ctx);
    assert.deepEqual(h.entries.at(-1).data, { role: null, cwd: path.resolve(cwd) });
    assert.equal((await status(h)).active, false);
    assert.equal(h.state.model.id, 'gpt-6-astra');
    h.state.model = { provider: 'ordinary', id: 'another' };
    h.state.effort = 'low';
    assert.equal(h.handlers.get('input')({}, h.ctx).action, 'continue');
    assert.equal(h.handlers.get('before_agent_start')({ systemPrompt: 'Normal' }, h.ctx), undefined);
  });

  await t.test('session restore uses latest valid entry only for the current project', async (st) => {
    const { cwd } = fixture(st);
    const entry = (role, directory = path.resolve(cwd)) => ({ type: 'custom', customType: 'paperthin-workflow', data: { role, cwd: directory } });
    const cases = [
      { branch: [entry('lead')], active: true },
      { branch: [entry('lead', '/unrelated/project')], active: false },
      { branch: [entry('lead'), entry(null)], active: false },
      { branch: [entry(null), entry('lead')], active: true },
      { branch: [entry('worker')], active: false },
      { branch: [entry('lead'), { type: 'custom', customType: 'other', data: { role: null, cwd } }], active: true },
    ];
    for (const scenario of cases) {
      const h = setup(cwd);
      configure(h, 'lead');
      h.state.branch = scenario.branch;
      await h.handlers.get('session_start')({}, h.ctx);
      assert.equal((await status(h)).active, scenario.active);
      assert.equal(h.selections.length + h.entries.length + h.requests.length, 0);
    }
  });

  await t.test('project role overrides select the exact configured Lead', async (st) => {
    const { cwd } = fixture(st);
    mkdirSync(path.join(cwd, '.pi'));
    writeFileSync(path.join(cwd, '.pi/paperthin.json'), JSON.stringify({ roles: { lead: { model: 'configured-astra', effort: 'medium' } } }));
    const h = setup(cwd);
    h.state.available = { provider: 'openai-codex', id: 'configured-astra' };
    await h.commands.get('lead').handler('Inspect.', h.ctx);
    assert.equal(h.state.model.id, 'configured-astra');
    assert.equal(h.state.effort, 'medium');
    assert.equal(h.requests.length, 1);
  });

  await t.test('prepare returns exact project-aware delegation arguments without spawning', async (st) => {
    const { cwd, brief } = fixture(st), h = setup(cwd, 'lead');
    configure(h, 'lead');
    for (const role of ['worker', 'reviewer', 'escalation', 'codex-worker']) {
      const result = await h.tools.get('workflow_prepare').execute('prepare', { role, cwd, brief: path.basename(brief), name: 'test-' + role }, undefined, undefined, h.ctx);
      const launch = buildLaunch({ role, cwd, configCwd: cwd, brief });
      assert.deepEqual(result.details.spec.agentArgs, launch.args);
      assert.equal(result.details.spec.prompt, launch.prompt);
      assert.deepEqual(JSON.parse(result.content[0].text), result.details.spec);
      assert.equal(result.details.spec.onBlocked, 'return');
    }
    await assert.rejects(() => h.tools.get('workflow_prepare').execute('relative', { role: 'worker', cwd: '.', brief }, undefined, undefined, h.ctx), /절대경로/);
    await assert.rejects(() => h.tools.get('workflow_prepare').execute('lead', { role: 'lead', cwd, brief }, undefined, undefined, h.ctx), /역할/);
    assert.equal(h.executions.length, 0);
  });

  await t.test('cold read shares the queue, returns snapshot identity and is collected through jobs', async (st) => {
    const { cwd, brief } = fixture(st), h = setup(cwd, 'lead');
    configure(h, 'lead');
    const controller = new AbortController();
    const run = () => h.tools.get('workflow_cold_read').execute('cold', { artifact: brief }, controller.signal, undefined, h.ctx);
    const result = await run();
    const submitted = JSON.parse(result.content[0].text);
    assert.equal(submitted.artifactSha256, buildLaunch({ role: 'cold-read', cwd, artifact: brief }).sources.artifactSha256);
    const manager = h.managers[0], execution = manager.get(submitted.id).launch;
    assert.equal(manager.options.maxConcurrent, 2);
    for (const flag of ['--no-context-files', '--no-skills', '--no-extensions', '--no-prompt-templates', '--no-tools', '--no-session']) assert.ok(execution.args.includes(flag), flag);
    assert.ok(!execution.args.includes('-e'));
    assert.ok(!execution.args.join('\n').includes('<pi-paperthin-role:'));
    manager.complete(submitted.id, 'Independent reading.');
    const collected = await h.tools.get('workflow_jobs').execute('get', { action: 'get', id: submitted.id }, undefined, undefined, h.ctx);
    assert.equal(collected.details.interpretation, 'Independent reading.');
    assert.equal(collected.details.artifactSha256, submitted.artifactSha256);
    assert.equal(collected.details.modelVerified, true);
    assert.equal(h.executions.length, 0);
    controller.abort();
    const count = manager.list().length;
    await assert.rejects(run);
    assert.equal(manager.list().length, count);
  });

  await t.test('managed spawn routes effort, shares child limits and preserves ownership through cancellation', async (st) => {
    const { cwd, brief } = fixture(st), h = setup(cwd, 'lead');
    configure(h, 'lead');
    const result = await h.tools.get('workflow_spawn').execute('spawn', { task: 'analyze', cwd, brief, assessment, skills: ['factchk'] }, undefined, undefined, h.ctx);
    assert.equal(result.details.route.effort, 'xhigh');
    assert.equal(result.details.route.profile, 'opus');
    const launch = h.managers[0].get(result.details.id).launch;
    assert.ok(launch.args.includes('--effort'));
    assert.ok(launch.sources.embeddedSkills.some(file => file.includes('/factchk/')));
    await h.commands.get('workflow').handler('off', h.ctx);
    assert.match(h.messages.at(-1).message.content, /하위 작업/);
    await assert.rejects(() => h.tools.get('workflow_jobs').execute('cancel', { action: 'cancel', id: 'foreign' }, undefined, undefined, h.ctx), /Unknown/);
    await h.commands.get('workflow').handler(`cancel ${result.details.id}`, h.ctx);
    assert.equal(h.managers[0].get(result.details.id).status, 'cancelled');
    assert.equal(h.executions.length, 0);
  });

  await t.test('session shutdown disposes only this session queue and billing failures create no jobs', async (st) => {
    const { cwd, brief } = fixture(st), h = setup(cwd, 'lead');
    configure(h, 'lead');
    const spawn = data => h.tools.get('workflow_spawn').execute('spawn', { task: 'analyze', cwd, brief, assessment, ...data }, undefined, undefined, h.ctx);
    await assert.rejects(() => spawn({ assessment: { ...assessment, recommended_tier: 'frontier' } }), /usage credits/);
    assert.equal(h.managers.length, 0);
    await spawn({});
    const manager = h.managers[0];
    await h.handlers.get('session_shutdown')({}, h.ctx);
    assert.equal(manager.disposed, true);
    const list = await h.tools.get('workflow_jobs').execute('list', { action: 'list' }, undefined, undefined, h.ctx);
    assert.deepEqual(list.details.jobs, []);
  });

  await t.test('implementation and review require persistent run identity before launching', async (st) => {
    const { cwd, brief } = fixture(st), h = setup(cwd, 'lead');
    configure(h, 'lead');
    for (const task of ['implement','review']) {
      await assert.rejects(() => h.tools.get('workflow_spawn').execute('ungated', { task, cwd, brief, assessment }, undefined, undefined, h.ctx), /runId/);
    }
    assert.equal(h.managers.length, 0);
    await assert.rejects(() => h.tools.get('workflow_tab').execute('outside', { workspaceId:'test', cwd, label:'review',role:'reviewer',brief }, undefined, undefined, h.ctx), /HERDR_ENV/);
  });

  await t.test('registered tools complete a reviewed workflow with real Git worktrees and asynchronous checks', async (st) => {
    const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'paperthin extension workflow ')));
    const cwd = path.join(directory, 'project');
    mkdirSync(cwd);
    const git = (target, ...args) => execFileSync('git', ['-C', target, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const h = setup(cwd, 'lead');
    configure(h, 'lead');
    st.after(async () => {
      await h.handlers.get('session_shutdown')({}, h.ctx);
      rmSync(directory, { recursive: true, force: true });
    });
    git(cwd, 'init', '-q', '-b', 'main');
    git(cwd, 'config', 'user.name', 'Extension Workflow Test');
    git(cwd, 'config', 'user.email', 'extension-test@example.invalid');
    mkdirSync(path.join(cwd, '.pi'));
    writeFileSync(path.join(cwd, '.pi', 'paperthin.json'), JSON.stringify({ routing: { allowFableHeadless: true } }));
    writeFileSync(path.join(cwd, 'feature.txt'), 'before\n');
    git(cwd, 'add', '.pi/paperthin.json', 'feature.txt');
    git(cwd, 'commit', '-qm', 'Fixture baseline');
    const originalSha = git(cwd, 'rev-parse', 'HEAD');
    const originalBranch = git(cwd, 'branch', '--show-current');
    const plan = path.join(directory, 'plan with spaces.md');
    const brief = path.join(directory, 'brief with spaces.md');
    writeFileSync(plan, 'Change feature.txt to after; verify its exact contents.\n');
    writeFileSync(brief, 'Follow the supplied plan and return the requested evidence.\n');
    const invoke = async (tool, params, signal) => (await h.tools.get(tool).execute('workflow-regression', params, signal, undefined, h.ctx)).details;
    const run = await invoke('workflow_run', { action: 'start', runId: 'extension-flow', plan });
    const runId = run.runId;
    const task = await invoke('workflow_run', { action: 'task', runId, taskId: 'feature', files: ['feature.txt'], brief });
    assert.notEqual(task.worktree, cwd);
    const spawn = (phase, taskId) => invoke('workflow_spawn', { task: phase === 'implement' ? 'implement' : 'review', phase, runId, taskId, brief, assessment });
    await assert.rejects(() => spawn('implement', 'feature'), /plan approval/i);

    async function review(phase, taskId, expectedProfile) {
      const submitted = await spawn(phase, taskId);
      const manager = h.managers[0];
      const job = manager.get(submitted.id);
      assert.equal(submitted.route.profile, expectedProfile);
      assert.equal(submitted.route.runtime, 'claude');
      assert.equal(job.metadata.workflow.runId, runId);
      assert.equal(job.metadata.workflow.taskId, taskId ?? null);
      assert.ok(job.launch.prompt.includes(JSON.stringify(readFileSync(plan, 'utf8'))));
      const approval = { phase, ...job.metadata.reviewTarget, verdict: 'approve', findings: [] };
      manager.complete(job.id, JSON.stringify(approval));
      // Runtime completion reaches the persistent state only through collection.
      const beforeCollection = await invoke('workflow_run', { action: 'get', runId });
      assert.equal(beforeCollection.attempts.find(attempt => attempt.jobId === job.id).status, 'running');
      const collected = await invoke('workflow_jobs', { action: 'wait', id: job.id, waitMs: 0 });
      assert.equal(collected.workflow.status, 'succeeded');
      assert.equal(collected.runtimeError, false);
      assert.equal(collected.modelVerified, true);
      assert.deepEqual(collected.reviewResult, approval);
      return collected;
    }

    const planReview = await review('plan_review', undefined, 'fable');
    assert.equal(planReview.reviewResult.planSha256, run.plan.sha256);
    const implementation = await spawn('implement', 'feature');
    assert.equal(implementation.route.profile, 'codex');
    assert.equal(implementation.route.runtime, 'codex');
    const manager = h.managers[0];
    assert.equal(manager.get(implementation.id).cwd, task.worktree);
    manager.complete(implementation.id, 'Implementation finished; commit and validate the candidate.');
    const implemented = await invoke('workflow_jobs', { action: 'get', id: implementation.id });
    assert.equal(implemented.workflow.status, 'succeeded');
    assert.equal(implemented.modelVerified, true);
    writeFileSync(path.join(task.worktree, 'feature.txt'), 'after\n');
    git(task.worktree, 'add', 'feature.txt');
    git(task.worktree, 'commit', '-qm', 'Implement feature');
    const candidate = await invoke('workflow_run', { action: 'freeze', runId, taskId: 'feature' });
    await assert.rejects(() => spawn('code_review', 'feature'), /passing checks/);

    const argv = [process.execPath, '-e', "const assert=require('node:assert/strict'); const fs=require('node:fs'); assert.equal(fs.readFileSync('feature.txt','utf8'),'after\\n'); console.log('Verified feature contents.');"];
    const checkSignal = new AbortController().signal;
    const checked = await invoke('workflow_run', { action: 'check', runId, taskId: 'feature', argv, timeoutMs: 5000 }, checkSignal);
    assert.equal(checked.status, 'passed');
    assert.equal(checked.candidateSha, candidate.candidateSha);
    assert.match(checked.stdout, /Verified feature contents/);
    await review('code_review', 'feature', 'opus');
    const integrated = await invoke('workflow_run', { action: 'integrate', runId });
    assert.equal(integrated.status, 'integrated');
    assert.equal(readFileSync(path.join(integrated.worktree, 'feature.txt'), 'utf8'), 'after\n');
    await assert.rejects(() => invoke('workflow_run', { action: 'complete', runId }), /passing checks/);
    const finalCheck = await invoke('workflow_run', { action: 'check', runId, argv, timeoutMs: 5000 }, checkSignal);
    assert.equal(finalCheck.status, 'passed');
    assert.equal(finalCheck.candidateSha, integrated.candidateSha);
    await assert.rejects(() => invoke('workflow_run', { action: 'complete', runId }), /final integration code review/);
    const finalReview = await review('code_review', undefined, 'opus');
    assert.equal(finalReview.reviewResult.candidateSha, integrated.candidateSha);
    const completed = await invoke('workflow_run', { action: 'complete', runId });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.approvals.length, 3);
    assert.deepEqual(completed.integration.finalCheckIds, [finalCheck.id]);
    assert.equal(git(cwd, 'rev-parse', 'HEAD'), originalSha);
    assert.equal(git(cwd, 'branch', '--show-current'), originalBranch);
    assert.equal(readFileSync(path.join(cwd, 'feature.txt'), 'utf8'), 'before\n');
    assert.equal(git(cwd, 'status', '--porcelain'), '');
    assert.equal(h.executions.length, 0, 'checks execute through the owned check runner, not an agent or Herdr');
    await h.handlers.get('session_shutdown')({}, h.ctx);
    assert.equal(manager.disposed, true);
    assert.deepEqual((await invoke('workflow_jobs', { action: 'list' })).jobs, []);
  });

  await t.test('managed worker effort is checked and cannot activate another scheduler', async (st) => {
    const { cwd } = fixture(st), h = setup(cwd, 'worker');
    configure(h, 'worker');
    h.flags.set('workflow-effort', 'high');
    assert.equal(h.handlers.get('input')({}, h.ctx).action, 'handled');
    h.state.effort = 'high';
    assert.equal(h.handlers.get('input')({}, h.ctx).action, 'continue');
    await assert.rejects(() => h.tools.get('workflow_spawn').execute('recursive', {}, undefined, undefined, h.ctx), /Lead/);
    assert.equal(h.managers.length, 0);
  });
});
