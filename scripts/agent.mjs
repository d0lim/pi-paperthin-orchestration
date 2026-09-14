#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildLaunch, herdrSpec, readWorkflowSettings } from '../lib/runtime.mjs';

export { buildPolicy, buildLaunch, herdrSpec, readRoles, PACKAGE_ROOT, ROOT, POLICY_MARKER } from '../lib/runtime.mjs';

export function parseArgs(argv) {
  const invocationCwd = process.cwd();
  const options = { role: argv[0], cwd: invocationCwd };
  if (argv.length === 0 || ['-h', '--help'].includes(argv[0])) return { help: true };
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    if (['--dry-run', '--herdr-spec', '--print'].includes(key)) options[key.slice(2)] = true;
    else if (['--cwd', '--config-cwd', '--brief', '--artifact', '--name'].includes(key)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${key} 값이 필요합니다.`);
      options[key === '--config-cwd' ? 'configCwd' : key.slice(2)] = argv[++i];
    } else throw new Error(`지원하지 않는 옵션: ${key}`);
  }
  if (options['dry-run'] && options['herdr-spec']) throw new Error('출력 형식은 하나만 선택하세요.');
  if (options.print && options['herdr-spec']) throw new Error('--print는 Herdr 대화형 실행과 함께 사용할 수 없습니다.');
  // CLI file arguments remain relative to the directory where the command was entered.
  // The reusable runtime API instead resolves brief/artifact paths against its target cwd.
  for (const key of ['cwd', 'configCwd', 'brief', 'artifact']) {
    if (options[key]) options[key] = path.resolve(invocationCwd, options[key]);
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log('사용법: node scripts/agent.mjs <lead|worker|reviewer|escalation|codex-worker|claude-worker> [--cwd PATH] [--config-cwd PATH] [--brief FILE] [--dry-run|--herdr-spec|--print]\n       node scripts/agent.mjs cold-read --artifact FILE [--dry-run|--print]\n--dry-run / --herdr-spec은 모델을 호출하지 않습니다. --print는 단발 실행입니다.');
      return 0;
    }
    const launch = buildLaunch(options);
    if (options['herdr-spec']) {
      console.log(JSON.stringify(herdrSpec(launch, options.name), null, 2));
      return 0;
    }
    if (options['dry-run']) {
      console.log(JSON.stringify(launch, null, 2));
      return 0;
    }
    let args = [...launch.args];
    if (options.print && launch.runtime === 'claude' && /^claude-fable|^fable(?:$|\[)/.test(args[args.indexOf('--model') + 1]) &&
        !readWorkflowSettings(options.configCwd ?? launch.cwd).routing.allowFableHeadless) {
      throw new Error('Fable --print는 usage credits 차감 허용이 필요합니다. routing.allowFableHeadless를 사용자 승인 없이 켜지 마세요.');
    }
    if (options.print || options.role === 'cold-read') {
      if (launch.runtime === 'codex') args = ['exec', ...args.filter((arg, i) => arg !== '--ask-for-approval' && args[i - 1] !== '--ask-for-approval')];
      else args.push('-p');
    }
    // '--' keeps user-supplied brief text from becoming another CLI option.
    args.push('--', launch.prompt);
    const result = spawnSync(launch.runtime, args, { cwd: launch.cwd, stdio: 'inherit' });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } catch (error) {
    console.error(`agent: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
