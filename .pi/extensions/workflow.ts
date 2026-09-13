import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { buildLaunch, buildPolicy, herdrSpec, POLICY_MARKER } from '../../scripts/agent.mjs';

export default function workflow(pi: ExtensionAPI) {
  pi.registerFlag('workflow-role', {
    type: 'string', default: 'lead', description: 'Paperthin Pi role: lead or worker',
  });

  function currentRole(): 'lead' | 'worker' {
    const role = pi.getFlag('workflow-role') ?? 'lead';
    if (role !== 'lead' && role !== 'worker') throw new Error('--workflow-role은 lead 또는 worker여야 합니다.');
    return role;
  }

  function requireLead() {
    if (currentRole() !== 'lead') throw new Error('위임과 cold-read는 Lead가 수행합니다. Worker는 브리프 범위의 결과를 반환하세요.');
  }

  function assertPolicyRole(systemPrompt: string, role: string) {
    const markers = systemPrompt.matchAll(/<pi-paperthin-role:([^>]+)>/g);
    if ([...markers].some((match) => match[1] !== role)) {
      throw new Error('CLI 역할 지침과 --workflow-role이 서로 다릅니다.');
    }
  }

  // Pi logs lifecycle-handler exceptions and can continue the turn. Handle the
  // input explicitly when required instructions are missing or conflicting.
  pi.on('input', (_event, ctx) => {
    try {
      const role = currentRole();
      const { config } = buildPolicy(role);
      assertPolicyRole(ctx.getSystemPrompt(), role);
      // Pi can fall back from an unavailable default model. Never let that
      // become an unintended provider/model request in this workflow.
      if (ctx.model?.provider !== config.provider || ctx.model?.id !== config.model || pi.getThinkingLevel() !== config.effort) {
        throw new Error(`역할 ${role}에는 ${config.provider}/${config.model}, thinking ${config.effort}가 필요합니다. /workflow로 현재 값을 확인하고 /model 및 thinking 설정을 맞추세요. 역할 기준을 변경하려면 .workflow/roles.json을 명시적으로 수정하세요.`);
      }
      return { action: 'continue' };
    } catch (error) {
      pi.sendMessage({ customType: 'workflow-error', content: `워크플로우 지침을 적용할 수 없어 요청을 중단했습니다. 설정을 수정하고 다시 요청하세요.\n${error instanceof Error ? error.message : String(error)}`, display: true }, { triggerTurn: false });
      return { action: 'handled' };
    }
  });

  pi.on('resources_discover', () => ({ skillPaths: buildPolicy(currentRole()).sources.skills }));

  pi.on('before_agent_start', (event) => {
    const role = currentRole();
    const marker = `${POLICY_MARKER}${role}>`;
    assertPolicyRole(event.systemPrompt, role);
    // The CLI also supplies policy for non-Pi runtimes and other checkouts.
    if (event.systemPrompt.includes(marker)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${buildPolicy(role).policy}` };
  });

  pi.on('session_start', (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus('paperthin-workflow', `Paperthin · ${currentRole()} · /workflow`);
  });

  pi.registerCommand('workflow', {
    description: '역할, 현재 모델/effort, 지침 경로, Herdr 연결 상태 확인 (모델 호출 없음)',
    handler: async (_args, ctx) => {
      const role = currentRole();
      const { config, sources } = buildPolicy(role);
      const status = {
        role, cwd: ctx.cwd,
        actualModel: { provider: ctx.model?.provider ?? null, model: ctx.model?.id ?? null, effort: pi.getThinkingLevel() },
        expected: config,
        sources,
        herdr: { insidePane: process.env.HERDR_ENV === '1', delegateAvailable: pi.getActiveTools().includes('herdr_delegate') },
        next: 'Lead에게 작업을 요청하세요. workflow_prepare → herdr_delegate 순서로 위임합니다. 현재 모델/effort가 expected와 다르면 요청을 중단합니다. 역할 기준 변경은 .workflow/roles.json에서 명시적으로 수행하세요.',
      };
      pi.sendMessage({ customType: 'workflow-status', content: JSON.stringify(status, null, 2), display: true }, { triggerTurn: false });
    },
  });

  pi.registerTool({
    name: 'workflow_prepare',
    label: 'Prepare role delegation',
    description: 'Lead 전용. 역할별 모델/effort, 공통·역할 지침, Paperthin 경로, 전체 브리프로 herdr_delegate 인자를 준비합니다. 실행하지 않습니다. 반환 JSON을 수정 없이 herdr_delegate에 전달하세요.',
    parameters: Type.Object({
      role: Type.Union([Type.Literal('worker'), Type.Literal('reviewer'), Type.Literal('escalation'), Type.Literal('codex-worker')]),
      cwd: Type.String({ description: '작업할 checkout/worktree의 절대경로' }),
      brief: Type.String({ description: '브리프 파일. 상대경로는 Lead의 현재 디렉터리 기준' }),
      name: Type.Optional(Type.String({ description: 'Herdr agent 이름, 소문자로 시작하는 최대 32자' })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      requireLead();
      signal?.throwIfAborted();
      if (!['worker', 'reviewer', 'escalation', 'codex-worker'].includes(params.role)) throw new Error('위임할 역할이 아닙니다.');
      if (!path.isAbsolute(params.cwd)) throw new Error('cwd는 worktree의 절대경로여야 합니다.');
      const launch = buildLaunch({ role: params.role, cwd: params.cwd, brief: path.resolve(ctx.cwd, params.brief) });
      const spec = herdrSpec(launch, params.name);
      return { content: [{ type: 'text', text: JSON.stringify(spec, null, 2) }], details: { spec, sources: launch.sources } };
    },
  });

  pi.registerTool({
    name: 'workflow_cold_read',
    label: 'Paperthin cold read',
    description: 'Lead 전용. shower SKILL.md를 읽은 뒤 사용합니다. 결과물 파일의 내용만 새로운 Pi에 전달합니다. 공통 지침·브리프·확장·스킬·도구·세션 저장을 제외하며 120초 제한을 둡니다.',
    parameters: Type.Object({ artifact: Type.String({ description: '읽을 결과물 파일. 상대경로는 현재 디렉터리 기준' }) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      requireLead();
      signal?.throwIfAborted();
      const launch = buildLaunch({ role: 'cold-read', cwd: ctx.cwd, artifact: path.resolve(ctx.cwd, params.artifact) });
      const result = await pi.exec(launch.runtime, [...launch.args, '-p', '--', launch.prompt], {
        cwd: launch.cwd, timeout: 120000, signal,
      });
      if (result.killed || result.code !== 0) {
        throw new Error(`cold-read ${result.killed ? '중단 또는 시간 초과' : `실패 (exit ${result.code})`}. 모델을 변경하거나 자동 재시도하지 않았습니다.\n${result.stderr || result.stdout}`);
      }
      return { content: [{ type: 'text', text: result.stdout }], details: { sources: launch.sources, exitCode: result.code } };
    },
  });
}
