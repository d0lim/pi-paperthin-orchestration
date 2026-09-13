import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { buildLaunch, ROOT } from '../scripts/agent.mjs';

const extensionPath = path.join(ROOT, '.pi/extensions/workflow.ts');

// Reuse the user's installed SDK without adding dependencies or invoking Pi/models.
// Resolve both an npm executable and Homebrew's wrapper layout.
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
  const directory = mkdtempSync(path.join(os.tmpdir(), 'workflow other checkout '));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const brief = path.join(directory, 'brief with spaces.md');
  writeFileSync(brief, 'Read only. Keep literal $(touch NEVER_RUN) and `echo unsafe`.');
  return { directory, brief };
}

function fakeApi(role = 'lead', execResult = { stdout: 'Artifact needs one clarification.', stderr: '', code: 0, killed: false }) {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const flags = new Map([['workflow-role', role]]);
  const messages = [];
  const executions = [];
  return {
    handlers, tools, commands, flags, messages, executions,
    api: {
      on(name, handler) { handlers.set(name, handler); },
      registerFlag(name, options) { if (!flags.has(name)) flags.set(name, options.default); },
      getFlag(name) { return flags.get(name); },
      registerTool(tool) { tools.set(tool.name, tool); },
      registerCommand(name, command) { commands.set(name, command); },
      getThinkingLevel() { return 'medium'; },
      getAllTools() { return [{ name: 'herdr_delegate' }]; },
      getActiveTools() { return ['herdr_delegate']; },
      sendMessage(message, options) { messages.push({ message, options }); },
      async exec(command, args, options) {
        executions.push({ command, args, options });
        return execResult;
      },
    },
  };
}

function context(directory, systemPrompt = 'Existing system prompt.') {
  return {
    cwd: directory,
    hasUI: false,
    model: { provider: 'observed-provider', id: 'observed-model' },
    getSystemPrompt() { return systemPrompt; },
    ui: { notify() {}, setStatus() {} },
  };
}

async function mustRejectTool(action) {
  let result;
  try {
    result = await action();
  } catch (error) {
    assert.ok(error instanceof Error);
    return;
  }
  assert.equal(result?.isError, true, 'invalid request must throw or return an explicit tool error');
}

const sdk = installedPiPackage();

test('Pi workflow extension works without model or Herdr calls', {
  skip: sdk ? false : 'Installed Pi SDK not found; CLI and launcher tests still run.',
}, async (t) => {
  const requirePi = createRequire(path.join(sdk, 'package.json'));
  const jitiManifest = requirePi.resolve('jiti/package.json');
  const jitiMetadata = JSON.parse(readFileSync(jitiManifest, 'utf8'));
  const jitiEntry = path.resolve(path.dirname(jitiManifest), jitiMetadata.exports['./static'].import);
  const { createJiti } = await import(pathToFileURL(jitiEntry).href);
  const typebox = await import(pathToFileURL(requirePi.resolve('typebox')).href);
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    tryNative: false,
    virtualModules: { typebox },
  });
  const factory = await jiti.import(extensionPath, { default: true });

  await t.test('installed Pi loader accepts the extension and registers its public surface', async () => {
    const { loadExtensions } = await import(pathToFileURL(path.join(sdk, 'dist/core/extensions/loader.js')).href);
    const result = await loadExtensions([extensionPath], ROOT);
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    const extension = result.extensions[0];
    assert.equal(extension.flags.get('workflow-role').default, 'lead');
    assert.ok(extension.commands.has('workflow'));
    assert.ok(extension.tools.has('workflow_prepare'));
    assert.ok(extension.tools.has('workflow_cold_read'));
    assert.ok(extension.handlers.has('before_agent_start'));
    assert.ok(extension.handlers.has('resources_discover'));
    assert.ok(extension.handlers.has('input'));
  });

  await t.test('input explicitly blocks invalid or conflicting roles before Pi can continue the turn', async (st) => {
    const { directory } = fixture(st);
    const cases = [
      { role: 'lead', prompt: 'No injected policy yet.', action: 'continue' },
      { role: 'worker', prompt: '<pi-paperthin-role:worker>', action: 'continue' },
      { role: 'reviewer', prompt: 'No injected policy yet.', action: 'handled' },
      { role: 'worker', prompt: '<pi-paperthin-role:lead>', action: 'handled' },
      { role: 'lead', prompt: '<pi-paperthin-role:worker>', action: 'handled' },
      // The matching marker must not hide an additional conflicting policy.
      { role: 'worker', prompt: '<pi-paperthin-role:worker>\n<pi-paperthin-role:lead>', action: 'handled' },
    ];
    for (const scenario of cases) {
      const fake = fakeApi(scenario.role);
      fake.api.getThinkingLevel = () => scenario.role === 'worker' ? 'medium' : 'high';
      const ctx = context(directory, scenario.prompt);
      ctx.model = { provider: 'openai-codex', id: scenario.role === 'worker' ? 'gpt-5.6-sol' : 'gpt-6-astra' };
      await factory(fake.api);
      const result = await fake.handlers.get('input')({
        source: 'interactive', text: 'Implement the requested change.', images: [],
      }, ctx);
      assert.equal(result.action, scenario.action, `${scenario.role}: ${scenario.prompt}`);
      const errors = fake.messages.filter((item) => item.message.customType === 'workflow-error');
      assert.equal(errors.length, scenario.action === 'handled' ? 1 : 0);
      if (errors.length > 0) {
        assert.match(errors[0].message.content, /중단/);
        assert.equal(errors[0].message.display, true);
        assert.equal(errors[0].options.triggerTurn, false);
      }
      assert.equal(fake.executions.length, 0);
    }
  });

  await t.test('input blocks provider, model, or effort fallback before any work starts', async (st) => {
    const { directory } = fixture(st);
    for (const role of ['lead', 'worker']) {
      const expectedModel = role === 'lead' ? 'gpt-6-astra' : 'gpt-5.6-sol';
      const expectedEffort = role === 'lead' ? 'high' : 'medium';
      for (const mismatch of ['provider', 'model', 'effort', 'missing-model']) {
        const fake = fakeApi(role);
        const ctx = context(directory, `<pi-paperthin-role:${role}>`);
        ctx.model = {
          provider: mismatch === 'provider' ? 'unexpected-provider' : 'openai-codex',
          id: mismatch === 'model' ? 'unexpected-fallback-model' : expectedModel,
        };
        if (mismatch === 'missing-model') ctx.model = undefined;
        fake.api.getThinkingLevel = () => mismatch === 'effort' ? 'low' : expectedEffort;
        await factory(fake.api);
        const result = await fake.handlers.get('input')({
          source: 'interactive', text: 'Implement the requested change.', images: [],
        }, ctx);
        assert.equal(result.action, 'handled', `${role}: ${mismatch}`);
        const errors = fake.messages.filter((item) => item.message.customType === 'workflow-error');
        assert.equal(errors.length, 1);
        assert.ok(errors[0].message.content.includes(`openai-codex/${expectedModel}`));
        assert.ok(errors[0].message.content.includes(`thinking ${expectedEffort}`));
        assert.equal(errors[0].options.triggerTurn, false);
        assert.equal(fake.executions.length, 0);
      }
    }
  });

  await t.test('worker policy and pinned skills load outside the source checkout without duplicate policy', async (st) => {
    const { directory } = fixture(st);
    const fake = fakeApi('worker');
    await factory(fake.api);
    const callback = fake.handlers.get('before_agent_start');
    const injected = await callback({ systemPrompt: 'Existing system prompt.' }, context(directory));
    assert.ok(injected.systemPrompt.startsWith('Existing system prompt.'));
    assert.ok(injected.systemPrompt.includes(readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8')));
    assert.ok(injected.systemPrompt.includes(readFileSync(path.join(ROOT, '.workflow/roles/worker.md'), 'utf8')));
    const repeated = await callback({ systemPrompt: injected.systemPrompt }, context(directory));
    const effectivePrompt = repeated?.systemPrompt ?? injected.systemPrompt;
    assert.equal(effectivePrompt, injected.systemPrompt);
    assert.throws(() => callback({ systemPrompt: '<pi-paperthin-role:lead>' }, context(directory)), /역할/);
    assert.throws(() => callback({ systemPrompt: '<pi-paperthin-role:worker>\n<pi-paperthin-role:lead>' }, context(directory)), /역할/);
    const resources = await fake.handlers.get('resources_discover')({ reason: 'startup' }, context(directory));
    assert.equal(resources.skillPaths.length, 4);
    for (const skill of ['readchk', 'modelchk', 'shower', 're0']) {
      const expected = realpathSync(path.join(ROOT, 'vendor/paperthin/skills', skill, 'SKILL.md'));
      assert.ok(resources.skillPaths.some((resource) => path.isAbsolute(resource) && realpathSync(resource) === expected));
    }
    assert.equal(fake.executions.length, 0);
  });

  await t.test('prepare returns the exact launcher specification and never spawns an agent', async (st) => {
    const { directory, brief } = fixture(st);
    const fake = fakeApi();
    await factory(fake.api);
    const prepare = fake.tools.get('workflow_prepare');
    for (const role of ['worker', 'reviewer', 'escalation', 'codex-worker']) {
      const name = `test-${role}`;
      const result = await prepare.execute('prepare-test', { role, cwd: directory, brief, name }, undefined, undefined, context(ROOT));
      assert.notEqual(result.isError, true);
      const launch = buildLaunch({ role, cwd: directory, brief });
      assert.deepEqual(result.details.spec.agentArgs, launch.args);
      assert.equal(result.details.spec.prompt, launch.prompt);
      assert.equal(result.details.spec.cwd, realpathSync(directory));
      assert.equal(result.details.spec.agent, launch.runtime);
      assert.equal(result.details.spec.name, name);
      assert.equal(result.details.spec.onBlocked, 'return');
      assert.deepEqual(result.details.sources, launch.sources);
      assert.deepEqual(JSON.parse(result.content[0].text), result.details.spec);
    }
    assert.equal(fake.executions.length, 0);
    assert.equal(existsSync(path.join(directory, 'NEVER_RUN')), false);
  });

  await t.test('prepare resolves relative briefs from Lead cwd and rejects ambiguous child cwd', async (st) => {
    const { directory, brief } = fixture(st);
    const fake = fakeApi();
    await factory(fake.api);
    const prepare = fake.tools.get('workflow_prepare');
    const result = await prepare.execute('relative-brief', {
      role: 'worker', cwd: ROOT, brief: path.basename(brief),
    }, undefined, undefined, context(directory));
    assert.equal(result.details.sources.brief, realpathSync(brief));
    assert.equal(result.details.spec.cwd, ROOT);
    await mustRejectTool(() => prepare.execute('relative-cwd', {
      role: 'worker', cwd: '.', brief,
    }, undefined, undefined, context(directory)));
    assert.equal(fake.executions.length, 0);
  });

  await t.test('workers cannot prepare children or invoke cold-read and Lead cannot prepare another Lead', async (st) => {
    const { directory, brief } = fixture(st);
    const worker = fakeApi('worker');
    await factory(worker.api);
    await mustRejectTool(() => worker.tools.get('workflow_prepare').execute('denied', {
      role: 'worker', cwd: directory, brief,
    }, undefined, undefined, context(directory)));
    await mustRejectTool(() => worker.tools.get('workflow_cold_read').execute('denied', {
      artifact: brief,
    }, undefined, undefined, context(directory)));
    assert.equal(worker.executions.length, 0);
    const lead = fakeApi();
    await factory(lead.api);
    await mustRejectTool(() => lead.tools.get('workflow_prepare').execute('denied', {
      role: 'lead', cwd: directory, brief,
    }, undefined, undefined, context(directory)));
    assert.equal(lead.executions.length, 0);
    const invalidRole = fakeApi('reviewer');
    await factory(invalidRole.api);
    assert.throws(() => invalidRole.handlers.get('resources_discover')({}, context(directory)), /workflow-role/);
  });

  await t.test('status reports the runtime model separately from expected routing without model turn', async (st) => {
    const { directory } = fixture(st);
    const fake = fakeApi();
    await factory(fake.api);
    await fake.commands.get('workflow').handler('status', context(directory));
    const sent = fake.messages.find((item) => item.message.customType === 'workflow-status');
    assert.ok(sent);
    const status = JSON.parse(sent.message.content);
    assert.equal(status.role, 'lead');
    assert.deepEqual(status.actualModel, { provider: 'observed-provider', model: 'observed-model', effort: 'medium' });
    assert.equal(status.expected.model, 'gpt-6-astra');
    assert.equal(status.sources.skills.length, 4);
    assert.equal(sent.options.triggerTurn, false);
    assert.equal(fake.executions.length, 0);
  });

  await t.test('cold-read forwards cancellation and bounds a tool-free isolated Pi process', async (st) => {
    const { directory, brief } = fixture(st);
    const fake = fakeApi();
    await factory(fake.api);
    const controller = new AbortController();
    const result = await fake.tools.get('workflow_cold_read').execute('cold-test', {
      artifact: brief,
    }, controller.signal, undefined, context(directory));
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /Artifact needs one clarification/);
    assert.equal(fake.executions.length, 1);
    const execution = fake.executions[0];
    assert.equal(execution.command, 'pi');
    assert.equal(execution.options.timeout, 120_000);
    assert.equal(execution.options.signal, controller.signal);
    assert.equal(realpathSync(execution.options.cwd), realpathSync(directory));
    for (const flag of ['--no-context-files', '--no-skills', '--no-extensions', '--no-prompt-templates', '--no-tools', '--no-session', '--system-prompt', '--append-system-prompt']) {
      assert.ok(execution.args.includes(flag), flag);
    }
    assert.ok(!execution.args.includes('-e'));
    assert.ok(!execution.args.includes('--extension'));
    assert.ok(!execution.args.join('\n').includes('<pi-paperthin-role:'));
    assert.ok(execution.args.at(-1).includes(readFileSync(brief, 'utf8')));
    assert.equal(existsSync(path.join(directory, 'NEVER_RUN')), false);
  });

  await t.test('cold-read process errors remain explicit failures', async (st) => {
    const { directory, brief } = fixture(st);
    for (const failure of [
      { stdout: '', stderr: 'Model unavailable.', code: 1, killed: false },
      { stdout: 'Partial output', stderr: '', code: 0, killed: true },
    ]) {
      const fake = fakeApi('lead', failure);
      await factory(fake.api);
      await mustRejectTool(() => fake.tools.get('workflow_cold_read').execute('failed-cold', {
        artifact: brief,
      }, undefined, undefined, context(directory)));
      assert.equal(fake.executions.length, 1);
    }
    const cancelled = fakeApi();
    await factory(cancelled.api);
    const controller = new AbortController();
    controller.abort();
    await mustRejectTool(() => cancelled.tools.get('workflow_cold_read').execute('cancelled-cold', {
      artifact: brief,
    }, controller.signal, undefined, context(directory)));
    assert.equal(cancelled.executions.length, 0);
  });
});
