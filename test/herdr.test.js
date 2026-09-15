import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHerdrTaskTab } from '../lib/herdr.mjs';

const context = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1', HERDR_TAB_ID: 'w1:t2', HERDR_PANE_ID: 'w1:p3' };
const created = {
  tab: { tab_id: 'w1:t8', workspace_id: 'w1' },
  root_pane: { pane_id: 'w1:p12', workspace_id: 'w1', tab_id: 'w1:t8' },
};
const response = result => ({ stdout: JSON.stringify({ id: 'request-id', result }), stderr: '' });

function fixture(t, results = [response(created), response({ agent: {} }), response({ submitted: true })]) {
  const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'paperthin herdr ')));
  t.after(() => rmSync(cwd, { force: true, recursive: true }));
  const calls = [];
  const execute = async (file, args, options) => {
    calls.push({ file, args, options });
    const next = results.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const request = {
    workspaceId: 'w1', cwd, label: 'Review candidate', name: 'pt-review-task',
    launch: { runtime: 'claude', cwd, args: ['--model', 'fixture-model'], prompt: 'Review this candidate.' },
  };
  return { cwd, calls, execute, request };
}

test('explicit interactive tab uses returned IDs, a new session and safe CLI argument arrays', async t => {
  const { cwd, calls, execute, request } = fixture(t);
  const result = await createHerdrTaskTab(request, { env: context, execute });
  assert.equal(result.status, 'prompt_submitted');
  assert.equal(result.mode, 'interactive');
  assert.equal(result.separateSession, true);
  assert.equal(result.tabId, 'w1:t8');
  assert.equal(result.paneId, 'w1:p12');
  assert.deepEqual(result.launcher, { runtime: 'claude', args: request.launch.args, prompt: request.launch.prompt });
  assert.deepEqual(calls.map(call => call.args), [
    ['tab', 'create', '--workspace', 'w1', '--cwd', cwd, '--label', 'Review candidate', '--no-focus'],
    ['agent', 'start', 'pt-review-task', '--kind', 'claude', '--pane', 'w1:p12', '--timeout', '30000', '--', '--model', 'fixture-model'],
    ['agent', 'prompt', 'w1:p12', '--', 'Review this candidate.'],
  ]);
  for (const call of calls) {
    assert.equal(call.file, 'herdr');
    assert.equal(call.options.shell, false);
    assert.equal(call.options.cwd, cwd);
    assert.deepEqual(call.options.env, context);
  }
});

test('shell metacharacters in prompts and native agent arguments stay literal arguments', async t => {
  const { calls, execute, request } = fixture(t);
  request.launch.args = ['--append-system-prompt', "Ignore `substitution`; $(do-not-run) 'quoted'\nSecond line"];
  request.launch.prompt = '--leading-option $(do-not-run)\nLiteral prompt';
  await createHerdrTaskTab(request, { env: context, execute });
  assert.deepEqual(calls[1].args.slice(-2), request.launch.args);
  assert.deepEqual(calls[2].args.slice(-2), ['--', request.launch.prompt]);
});

test('outside Herdr, missing caller context and missing explicit destination issue no CLI command', async t => {
  const { calls, execute, request } = fixture(t);
  for (const env of [{}, { ...context, HERDR_ENV: '0' }, { ...context, HERDR_TAB_ID: '' }, { ...context, HERDR_PANE_ID: undefined }]) {
    await assert.rejects(() => createHerdrTaskTab(request, { env, execute }), /HERDR/);
  }
  for (const fields of [{ workspaceId: undefined }, { cwd: '.' }, { launch: { ...request.launch, cwd: '.' } }, { launch: { ...request.launch, runtime: 'sh' } }, { launch: { ...request.launch, args: ['bad\0arg'] } }, { name: 'bad name' }, { timeoutMs: 0 }, { label: '-option' }]) {
    await assert.rejects(() => createHerdrTaskTab({ ...request, ...fields }, { env: context, execute }));
  }
  assert.deepEqual(calls, []);
});

test('launch cwd must match requested cwd and environment overrides cannot be silently discarded', async t => {
  const { calls, execute, request } = fixture(t);
  await assert.rejects(() => createHerdrTaskTab({ ...request, launch: { ...request.launch, cwd: os.tmpdir() } }, { env: context, execute }), /match/);
  await assert.rejects(() => createHerdrTaskTab({ ...request, launch: { ...request.launch, env: { EXTRA: 'yes' } } }, { env: context, execute }), /overrides/);
  assert.deepEqual(calls, []);
});

test('failed creation neither guesses IDs nor touches an existing pane', async t => {
  const { calls, execute, request } = fixture(t, [new Error('socket unavailable')]);
  await assert.rejects(() => createHerdrTaskTab(request, { env: context, execute }), error => {
    assert.equal(error.stage, 'create');
    assert.equal(error.createdTab, undefined);
    assert.match(error.message, /uncertain/);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('malformed or foreign creation responses never start an agent in an unverified pane', async t => {
  const invalid = [
    {},
    { ...created, root_pane: undefined },
    { ...created, root_pane: { ...created.root_pane, pane_id: context.HERDR_PANE_ID } },
    { ...created, tab: { ...created.tab, tab_id: context.HERDR_TAB_ID } },
    { ...created, root_pane: { ...created.root_pane, workspace_id: 'w9' } },
    { ...created, root_pane: { ...created.root_pane, tab_id: 'w1:t99' } },
  ];
  for (const value of invalid) {
    const { calls, execute, request } = fixture(t, [response(value)]);
    await assert.rejects(() => createHerdrTaskTab(request, { env: context, execute }), error => {
      assert.equal(error.createdTab.preserved, true);
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test('startup or prompt errors preserve the created tab and never retry possibly delivered input', async t => {
  for (const failedStage of ['start', 'prompt']) {
    const results = [response(created), ...(failedStage === 'prompt' ? [response({ agent: {} })] : []), new Error('agent blocked or timed out')];
    const { calls, execute, request } = fixture(t, results);
    await assert.rejects(() => createHerdrTaskTab(request, { env: context, execute }), error => {
      assert.equal(error.stage, failedStage);
      assert.deepEqual(error.createdTab, { workspaceId: 'w1', tabId: 'w1:t8', paneId: 'w1:p12', preserved: true });
      assert.match(error.message, /preserved/);
      return true;
    });
    assert.equal(calls.length, failedStage === 'start' ? 2 : 3);
    assert.equal(calls.some(call => call.args.includes('close') || call.args[0] === 'pane' || call.args.includes('--focus')), false);
  }
});

test('Herdr JSON error responses fail even when the executor exits successfully', async t => {
  const { calls, execute, request } = fixture(t, [response(created), { stdout: JSON.stringify({ error: { message: 'agent_not_ready' } }) }]);
  await assert.rejects(() => createHerdrTaskTab(request, { env: context, execute }), /agent_not_ready/);
  assert.equal(calls.length, 2);
});
