import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-paperthin-tasks-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    file: join(directory, 'tasks.json'),
    run(...args) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.ifError(result.error);
      return result;
    },
  };
}

test('add, list, and done persist stable IDs across separate invocations', (t) => {
  const { file, run } = fixture(t);
  assert.equal(run('--file', file, 'add', '  First task  ').status, 0);
  assert.equal(run('--file', file, 'add', '두 번째 작업').status, 0);
  assert.equal(run('--file', file, 'done', '1').status, 0);
  assert.equal(run('--file', file, 'add', 'Third task').status, 0);

  const listed = run('--file', file, 'list');
  assert.equal(listed.status, 0);
  assert.equal(listed.stdout, '1 [x] First task\n2 [ ] 두 번째 작업\n3 [ ] Third task\n');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    version: 1,
    nextId: 4,
    tasks: [
      { id: 1, title: 'First task', done: true },
      { id: 2, title: '두 번째 작업', done: false },
      { id: 3, title: 'Third task', done: false },
    ],
  });
  assert.match(run('--file', file, 'done', '1').stdout, /already complete/);
});

test('a missing file lists an empty collection without creating a file', (t) => {
  const { file, run } = fixture(t);
  const result = run('--file', file, 'list');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'No tasks.\n');
  assert.equal(existsSync(file), false);
  const missing = run('--file', file, 'done', '1');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Task 1 does not exist/);
  assert.equal(existsSync(file), false);
});

test('the default location is created under the working directory', (t) => {
  const { directory, run } = fixture(t);
  assert.equal(run('add', 'Default location').status, 0);
  const store = JSON.parse(readFileSync(join(directory, '.data/tasks.json'), 'utf8'));
  assert.equal(store.tasks[0].title, 'Default location');
  assert.equal(run('list').stdout, '1 [ ] Default location\n');
});

test('invalid arguments fail without creating or modifying data', (t) => {
  const { file, run } = fixture(t);
  for (const args of [
    ['add'], ['add', '   '], ['add', 'one', 'two'], ['list', 'extra'],
    ['done'], ['done', '0'], ['done', '-1'], ['done', '1.5'],
    ['done', '9007199254740992'], ['unknown'],
  ]) {
    const result = run('--file', file, ...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /Invalid command or arguments/);
    assert.equal(existsSync(file), false);
  }
  assert.equal(run('--file').status, 1);
  assert.equal(run('--help').status, 0);
  assert.equal(run('--file', file, 'add', 'Keep me').status, 0);
  const before = readFileSync(file, 'utf8');
  assert.equal(run('--file', file, 'done', '999').status, 1);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('corrupt JSON is reported and never overwritten by an add', (t) => {
  const { file, run } = fixture(t);
  const content = '{broken JSON';
  writeFileSync(file, content);
  for (const args of [['list'], ['add', 'Do not save'], ['done', '1']]) {
    const result = run('--file', file, ...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not valid JSON/);
    assert.equal(readFileSync(file, 'utf8'), content);
  }
});

test('invalid schemas including duplicate IDs cannot be silently repaired', (t) => {
  const { file, run } = fixture(t);
  const task = { id: 1, title: 'Existing task', done: false };
  for (const store of [
    null,
    [],
    { version: 2, nextId: 2, tasks: [task] },
    { version: 1, nextId: 1, tasks: [task] },
    { version: 1, nextId: 2, tasks: [task, task] },
    { version: 1, nextId: 2, tasks: [{ ...task, done: 'false' }] },
  ]) {
    const content = JSON.stringify(store);
    writeFileSync(file, content);
    const result = run('--file', file, 'add', 'Do not save');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid schema/);
    assert.equal(readFileSync(file, 'utf8'), content);
  }
});
