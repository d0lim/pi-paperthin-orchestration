import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const RUNTIMES = new Set(['pi', 'codex', 'claude']);

function text(value, name, { multiline = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || (multiline ? /\0/ : /[\u0000-\u001f\u007f]/).test(value)) {
    throw new TypeError(`${name} must be a nonempty string without ${multiline ? 'NUL' : 'control'} characters.`);
  }
  return value;
}

function identifier(value, name) {
  text(value, name);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(value)) throw new TypeError(`${name} must be an explicit Herdr identifier.`);
  return value;
}

function directory(value, name) {
  text(value, name);
  if (!path.isAbsolute(value)) throw new TypeError(`${name} must be an absolute path.`);
  const resolved = realpathSync(value);
  if (!statSync(resolved).isDirectory()) throw new TypeError(`${name} must be a directory.`);
  return resolved;
}

function result(response) {
  const parsed = JSON.parse(typeof response === 'string' ? response : response.stdout);
  if (!parsed || typeof parsed !== 'object' || parsed.error || !parsed.result || typeof parsed.result !== 'object') {
    throw new Error(parsed?.error?.message ?? 'Herdr did not return a successful JSON result.');
  }
  return parsed.result;
}

/** Explicit, new interactive session. This adapter never manages headless jobs. */
export async function createHerdrTaskTab({ workspaceId, cwd, label, launch, name, timeoutMs = 30_000 } = {}, { env = process.env, execute = executeFile } = {}) {
  if (env.HERDR_ENV !== '1') throw new Error('Interactive task tabs require HERDR_ENV=1 inside Herdr. No Herdr control command was issued.');
  for (const key of ['HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_PANE_ID']) identifier(env[key], key);
  identifier(workspaceId, 'workspaceId');
  const targetCwd = directory(cwd, 'cwd');
  text(label, 'label');
  if (label.startsWith('-')) throw new TypeError('label must not start with a hyphen.');
  if (!launch || !RUNTIMES.has(launch.runtime)) throw new TypeError('launch.runtime must be pi, codex, or claude.');
  if (directory(launch.cwd, 'launch.cwd') !== targetCwd) throw new TypeError('launch.cwd must match the explicit task tab cwd.');
  if (!Array.isArray(launch.args) || launch.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new TypeError('launch.args must contain strings without NUL characters.');
  }
  text(launch.prompt, 'launch.prompt', { multiline: true });
  if (launch.env && Object.keys(launch.env).length) throw new TypeError('Interactive task tabs do not support launch.env overrides.');
  const agentName = name ?? `pt-${launch.runtime}-${randomUUID().slice(0, 16)}`;
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agentName)) throw new TypeError('name must be a lowercase Herdr agent name of at most 32 characters.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new TypeError('timeoutMs must be an integer between 1 and 300000.');
  if (typeof execute !== 'function') throw new TypeError('execute must be a function.');
  const launcher = { runtime: launch.runtime, args: [...launch.args], prompt: launch.prompt };
  const options = { cwd: targetCwd, env: { ...env }, shell: false, encoding: 'utf8', timeout: timeoutMs + 5_000, maxBuffer: 1024 * 1024 };
  let createdTab;
  let stage = 'create';
  try {
    const created = result(await execute('herdr', ['tab', 'create', '--workspace', workspaceId, '--cwd', targetCwd, '--label', label, '--no-focus'], options));
    // Keep exactly what the creation response said even if its topology is invalid.
    createdTab = {
      workspaceId: created.tab?.workspace_id ?? null,
      tabId: created.tab?.tab_id ?? null,
      paneId: created.root_pane?.pane_id ?? null,
      preserved: true,
    };
    const tabId = identifier(createdTab.tabId, 'created tab ID');
    const paneId = identifier(createdTab.paneId, 'created pane ID');
    if (createdTab.workspaceId !== workspaceId || created.root_pane.workspace_id !== workspaceId || created.root_pane.tab_id !== tabId
      || tabId === env.HERDR_TAB_ID || paneId === env.HERDR_PANE_ID) {
      throw new Error('Herdr creation response did not identify a new tab and pane in the requested workspace.');
    }
    stage = 'start';
    result(await execute('herdr', ['agent', 'start', agentName, '--kind', launcher.runtime, '--pane', paneId, '--timeout', String(timeoutMs), '--', ...launcher.args], options));
    stage = 'prompt';
    result(await execute('herdr', ['agent', 'prompt', paneId, '--', launcher.prompt], options));
    return {
      mode: 'interactive', separateSession: true, status: 'prompt_submitted',
      workspaceId, tabId, paneId, agentName, cwd: targetCwd, label,
      launcher, createdAt: new Date().toISOString(),
    };
  } catch (cause) {
    // Startup can time out after the process starts or pause at a user question.
    // Never close such a tab automatically, or retry a possibly delivered prompt.
    const error = new Error(`Herdr task tab ${stage} failed: ${cause.message ?? String(cause)}. ${createdTab ? 'The created tab was preserved; inspect its reported IDs before any retry.' : 'Creation may be uncertain; no existing pane was inspected or controlled.'}`, { cause });
    error.stage = stage;
    if (createdTab) error.createdTab = createdTab;
    throw error;
  }
}
