#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const usage = `Usage: node src/cli.js [--file <json-path>] <command>

Commands:
  add "task title"  Add a task
  list              List all tasks
  done <id>         Mark a task complete

The default file is .data/tasks.json in the current directory.`;

function parseArguments(args) {
  let file = resolve('.data/tasks.json');
  if (args[0] === '--file') {
    if (!args[1] || args[1].startsWith('--')) {
      throw new Error('--file requires a JSON file path.');
    }
    file = resolve(args[1]);
    args = args.slice(2);
  }
  const [command, ...values] = args;
  if ((!command || command === '--help' || command === '-h') && values.length === 0) {
    return { file, command: 'help' };
  }
  if (command === 'list' && values.length === 0) return { file, command };
  if (command === 'add' && values.length === 1 && values[0].trim()) {
    return { file, command, title: values[0].trim() };
  }
  if (command === 'done' && values.length === 1 && /^[1-9]\d*$/.test(values[0])) {
    const id = Number(values[0]);
    if (Number.isSafeInteger(id)) return { file, command, id };
  }
  throw new Error(`Invalid command or arguments.\n${usage}`);
}

function validateStore(store) {
  if (!store || typeof store !== 'object' || store.version !== 1 ||
      !Number.isSafeInteger(store.nextId) || store.nextId < 1 ||
      !Array.isArray(store.tasks)) return false;

  const seenIds = new Set();
  for (const task of store.tasks) {
    if (!task || typeof task !== 'object' ||
        !Number.isSafeInteger(task.id) || task.id < 1 || task.id >= store.nextId ||
        seenIds.has(task.id) || typeof task.title !== 'string' || !task.title.trim() ||
        typeof task.done !== 'boolean') return false;
    seenIds.add(task.id);
  }
  return true;
}

async function readStore(file) {
  let content;
  try {
    content = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, nextId: 1, tasks: [] };
    throw new Error(`Cannot read task file ${file}: ${error.message}`);
  }
  let store;
  try {
    store = JSON.parse(content);
  } catch {
    throw new Error(`Task file is not valid JSON: ${file}. The file was not changed.`);
  }
  if (!validateStore(store)) {
    throw new Error(`Task file has an invalid schema: ${file}. The file was not changed.`);
  }
  return store;
}

async function writeStore(file, store) {
  await mkdir(dirname(file), { recursive: true });
  // Write beside the destination, then replace it so a partial write is not published.
  const temporaryFile = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryFile, `${JSON.stringify(store, null, 2)}\n`, { flag: 'wx' });
    await rename(temporaryFile, file);
  } finally {
    await unlink(temporaryFile).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === 'help') {
    console.log(usage);
    return;
  }
  const store = await readStore(options.file);

  if (options.command === 'list') {
    console.log(store.tasks.length === 0
      ? 'No tasks.'
      : store.tasks.map((task) => `${task.id} [${task.done ? 'x' : ' '}] ${task.title}`).join('\n'));
    return;
  }

  if (options.command === 'add') {
    if (store.nextId === Number.MAX_SAFE_INTEGER) throw new Error('Task ID limit reached.');
    const task = { id: store.nextId++, title: options.title, done: false };
    store.tasks.push(task);
    await writeStore(options.file, store);
    console.log(`Added task ${task.id}: ${task.title}`);
    return;
  }

  const task = store.tasks.find((item) => item.id === options.id);
  if (!task) throw new Error(`Task ${options.id} does not exist.`);
  if (task.done) {
    console.log(`Task ${task.id} is already complete: ${task.title}`);
    return;
  }
  task.done = true;
  await writeStore(options.file, store);
  console.log(`Completed task ${task.id}: ${task.title}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
