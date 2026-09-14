import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { buildLaunch, buildPolicy, herdrSpec, POLICY_MARKER, readRoles } from '../lib/runtime.mjs';

type Role = 'lead' | 'worker';
const ENTRY = 'paperthin-workflow';

export default function workflow(pi: ExtensionAPI) {
  pi.registerFlag('workflow-role', { type: 'string', description: 'Explicit role: lead or worker; otherwise activate with /lead' });
  pi.registerFlag('workflow-config', { type: 'string', description: 'Originating project directory for child role settings' });
  let sessionRole: Role | null = null;
  let activating = false;

  function currentRole(): Role | null {
    const flag = pi.getFlag('workflow-role');
    if (flag !== undefined && flag !== 'lead' && flag !== 'worker') throw new Error('--workflow-role은 lead 또는 worker여야 합니다.');
    return (flag as Role | undefined) ?? sessionRole;
  }

  function configCwd(ctx: ExtensionContext) {
    const flag = pi.getFlag('workflow-config');
    if (flag !== undefined && (typeof flag !== 'string' || !path.isAbsolute(flag))) throw new Error('--workflow-config에는 프로젝트 절대경로가 필요합니다.');
    return typeof flag === 'string' ? flag : ctx.cwd;
  }

  function trusted(ctx: ExtensionContext) {
    return pi.getFlag('workflow-config') !== undefined || ctx.isProjectTrusted();
  }

  function assertProjectPolicy(ctx: ExtensionContext) {
    if (trusted(ctx)) return;
    if (existsSync(path.join(ctx.cwd, 'AGENTS.md')) || existsSync(path.join(configCwd(ctx), '.pi/paperthin.json'))) {
      throw new Error('프로젝트 지침·설정을 읽으려면 Pi의 /trust에서 이 프로젝트를 신뢰한 뒤 Pi를 종료하고 다시 실행하세요.');
    }
  }

  function policy(role: Role, ctx: ExtensionContext) {
    assertProjectPolicy(ctx);
    return buildPolicy(role, { cwd: ctx.cwd, configCwd: configCwd(ctx) });
  }

  function requireLead() {
    if (currentRole() !== 'lead') throw new Error('Lead를 먼저 /lead로 시작하세요. Worker는 자신의 브리프 범위만 수행합니다.');
  }

  function assertConfiguredRole(ctx: ExtensionContext) {
    const role = currentRole();
    if (!role) return;
    const { config } = policy(role, ctx);
    const markers = ctx.getSystemPrompt().matchAll(/<pi-paperthin-role:([^>]+)>/g);
    if ([...markers].some((match) => match[1] !== role)) throw new Error('역할 지침과 현재 역할이 서로 다릅니다.');
    if (ctx.model?.provider !== config.provider || ctx.model?.id !== config.model || pi.getThinkingLevel() !== config.effort) {
      throw new Error(`역할 ${role}에는 ${config.provider}/${config.model}, thinking ${config.effort}가 필요합니다. /workflow로 확인하고 /model 및 /thinking 설정을 맞추세요. 설정 파일은 .pi/paperthin.json입니다.`);
    }
  }

  function message(type: string, content: string) {
    pi.sendMessage({ customType: type, content, display: true }, { triggerTurn: false });
  }
  function reportError(error: unknown) {
    message('workflow-error', `워크플로우 요청을 중단했습니다.\n${error instanceof Error ? error.message : String(error)}`);
  }
  function statusLabel(ctx: ExtensionContext) {
    if (ctx.hasUI) ctx.ui.setStatus(ENTRY, currentRole() ? `Paperthin · ${currentRole()} · /workflow` : undefined);
  }
  function persist(role: Role | null, ctx: ExtensionContext) {
    sessionRole = role;
    pi.appendEntry(ENTRY, { role, cwd: path.resolve(ctx.cwd) });
    statusLabel(ctx);
  }

  pi.on('session_start', (_event, ctx) => {
    sessionRole = null;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== 'custom' || entry.customType !== ENTRY) continue;
      const data = entry.data as { role?: unknown; cwd?: unknown } | undefined;
      if (data?.cwd === path.resolve(ctx.cwd) && (data.role === 'lead' || data.role === null)) sessionRole = data.role;
    }
    statusLabel(ctx);
  });

  // Global installation must not change ordinary Pi requests before activation.
  pi.on('input', (_event, ctx) => {
    try {
      assertConfiguredRole(ctx);
      return { action: 'continue' };
    } catch (error) {
      reportError(error);
      return { action: 'handled' };
    }
  });
  pi.on('before_agent_start', (event, ctx) => {
    const role = currentRole();
    if (!role) return;
    assertConfiguredRole(ctx);
    if (event.systemPrompt.includes(`${POLICY_MARKER}${role}>`)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${policy(role, ctx).policy}` };
  });
  // Native skills come from the package manifest, respecting --no-skills.

  function showLeadHelp() {
    message('workflow-help', '이 프로젝트에서 원하는 결과를 요청하세요.\n\n/lead 로그인 실패 원인을 분석하고 수정·테스트·리뷰까지 진행해줘\n/lead docs/spec.md를 읽고 구현 계획을 검토해줘\n\n/lead만 입력하면 여러 줄 입력창이 열립니다. Lead는 계획 검토 후 단계별 구현·코드 리뷰를 진행합니다. 처음 실행할 때 설정된 Lead 모델과 effort를 선택합니다. /workflow는 상태, /workflow off는 역할 해제입니다.');
  }

  pi.registerCommand('lead', {
    description: '현재 프로젝트에서 Lead 시작: /lead <목표> (생략하면 여러 줄 입력창)',
    handler: async (args, ctx) => {
      if (['--help', '-h', 'help'].includes(args.trim())) return showLeadHelp();
      if (activating) return reportError(new Error('Lead 활성화 중입니다. 잠시 후 다시 요청하세요.'));
      activating = true;
      try {
        if (currentRole() === 'worker') throw new Error('/lead는 Worker 세션에서 사용할 수 없습니다.');
        let request = args;
        if (!request.trim()) {
          if (!ctx.hasUI) return showLeadHelp();
          request = (await ctx.ui.editor('Lead에게 요청할 작업')) ?? '';
          if (!request.trim()) return;
        }
        if (currentRole() === 'worker') throw new Error('/lead는 Worker 세션에서 사용할 수 없습니다.');
        if (!currentRole()) {
          if (!ctx.isIdle()) throw new Error('진행 중인 Pi 작업이 끝난 후 /lead로 활성화하세요.');
          const { config } = policy('lead', ctx);
          const model = ctx.modelRegistry.find(config.provider, config.model);
          if (!model) throw new Error(`설정된 모델 ${config.provider}/${config.model}을 찾지 못했습니다. 다른 모델로 전환하지 않았습니다.`);
          if (!await pi.setModel(model)) throw new Error(`모델 ${config.provider}/${config.model} 인증을 확인하세요. 다른 모델로 전환하지 않았습니다.`);
          pi.setThinkingLevel(config.effort);
          persist('lead', ctx);
        }
        assertConfiguredRole(ctx);
        pi.sendUserMessage(request, { deliverAs: 'followUp', expandPromptTemplates: false });
      } catch (error) {
        reportError(error);
      } finally {
        activating = false;
      }
    },
  });

  pi.registerCommand('workflow', {
    description: '상태 확인; /workflow off로 역할 해제 (모델 호출 없음)',
    handler: async (args, ctx) => {
      try {
        if (args.trim() === 'off') {
          if (!ctx.isIdle() || activating) throw new Error('진행 중인 작업이 끝난 후 역할을 해제하세요.');
          if (pi.getFlag('workflow-role') !== undefined) throw new Error('CLI로 역할을 고정한 세션입니다. --workflow-role 없이 새 Pi를 실행하세요.');
          persist(null, ctx);
          message('workflow-status', 'Paperthin 역할을 해제했습니다. 현재 모델은 유지되며 일반 Pi 대화를 계속할 수 있습니다.');
          return;
        }
        if (!['', 'status'].includes(args.trim())) throw new Error('사용법: /workflow 또는 /workflow off');
        const role = currentRole();
        const roles = readRoles(configCwd(ctx), { projectTrusted: trusted(ctx) });
        message('workflow-status', JSON.stringify({
          active: role !== null, role, cwd: ctx.cwd,
          actualModel: { provider: ctx.model?.provider ?? null, model: ctx.model?.id ?? null, effort: pi.getThinkingLevel() },
          expected: roles[role ?? 'lead'],
          config: path.join(configCwd(ctx), '.pi/paperthin.json'), projectTrusted: trusted(ctx),
          herdr: { insidePane: process.env.HERDR_ENV === '1', delegateAvailable: pi.getActiveTools().includes('herdr_delegate') },
          next: '/lead 원하는 작업을 입력하세요. 설정 파일은 선택 사항입니다. /workflow off는 역할을 해제합니다.',
        }, null, 2));
      } catch (error) { reportError(error); }
    },
  });

  pi.registerTool({
    name: 'workflow_prepare', label: 'Prepare role delegation',
    description: '활성 Lead 전용. 대상 프로젝트의 역할별 모델·지침·Paperthin·브리프로 herdr_delegate 인자를 준비합니다. 반환 JSON을 그대로 herdr_delegate에 전달하세요.',
    parameters: Type.Object({
      role: Type.Union([Type.Literal('worker'), Type.Literal('reviewer'), Type.Literal('escalation'), Type.Literal('codex-worker')]),
      cwd: Type.String({ description: '대상 checkout/worktree 절대경로' }),
      brief: Type.String({ description: '브리프 경로. 상대경로는 Lead 프로젝트 기준' }),
      name: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      requireLead();
      assertConfiguredRole(ctx);
      signal?.throwIfAborted();
      if (!['worker', 'reviewer', 'escalation', 'codex-worker'].includes(params.role)) throw new Error('위임할 역할이 아닙니다.');
      if (!path.isAbsolute(params.cwd)) throw new Error('cwd는 worktree 절대경로여야 합니다.');
      const launch = buildLaunch({ role: params.role, cwd: params.cwd, configCwd: configCwd(ctx), brief: path.resolve(ctx.cwd, params.brief) });
      const spec = herdrSpec(launch, params.name);
      return { content: [{ type: 'text', text: JSON.stringify(spec, null, 2) }], details: { spec, sources: launch.sources } };
    },
  });

  pi.registerTool({
    name: 'workflow_cold_read', label: 'Paperthin cold read',
    description: '활성 Lead 전용. shower 지침을 읽은 후 결과물 내용만 독립 Pi에 전달합니다. 도구·확장·기존 문맥 없이 최대120초 실행합니다.',
    parameters: Type.Object({ artifact: Type.String() }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      requireLead();
      assertConfiguredRole(ctx);
      signal?.throwIfAborted();
      const launch = buildLaunch({ role: 'cold-read', cwd: ctx.cwd, configCwd: configCwd(ctx), artifact: path.resolve(ctx.cwd, params.artifact) });
      const result = await pi.exec(launch.runtime, [...launch.args, '-p', '--', launch.prompt], { cwd: launch.cwd, timeout: 120000, signal });
      if (result.killed || result.code !== 0) throw new Error(`cold-read ${result.killed ? '중단 또는 시간 초과' : `실패 (exit ${result.code})`}. 자동 재시도하지 않았습니다.\n${result.stderr || result.stdout}`);
      return { content: [{ type: 'text', text: result.stdout }], details: { sources: launch.sources, exitCode: result.code } };
    },
  });
}
