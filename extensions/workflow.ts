import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { buildLaunch, buildPolicy, herdrSpec, POLICY_MARKER, readSkillCatalog, readWorkflowSettings } from '../lib/runtime.mjs';
import { buildManagedLaunch } from '../lib/routing.mjs';
import { JobManager } from '../lib/jobs.mjs';
import { WorkflowStore } from '../lib/workflow-state.mjs';
import { submitWorkflowJob, collectWorkflowJob } from '../lib/controller.mjs';
import { createHerdrTaskTab } from '../lib/herdr.mjs';
import { summarizeJobs } from '../lib/metrics.mjs';

type Role = 'lead' | 'worker';
const ENTRY = 'paperthin-workflow';

export default function workflow(pi: ExtensionAPI, createJobManager = (options) => new JobManager(options)) {
  pi.registerFlag('workflow-role', { type: 'string', description: 'Explicit role: lead or worker; otherwise activate with /lead' });
  pi.registerFlag('workflow-config', { type: 'string', description: 'Originating project directory for child role settings' });
  pi.registerFlag('workflow-effort', { type: 'string', description: 'Assessed effort for a managed Pi worker' });
  let sessionRole: Role | null = null;
  let activating = false;
  let jobs: JobManager | undefined;
  const stores = new Map<string, WorkflowStore>();
  function workflowStore(ctx: ExtensionContext) {
    const cwd = configCwd(ctx);
    if (!stores.has(cwd)) stores.set(cwd, new WorkflowStore({ cwd }));
    return stores.get(cwd)!;
  }
  function collect(job, ctx: ExtensionContext) {
    return collectWorkflowJob(job, job.metadata?.workflow ? workflowStore(ctx) : undefined);
  }
  async function dispose(ctx?: ExtensionContext) {
    if (jobs) {
      await jobs.dispose();
      if (ctx) for (const job of jobs.list()) {
        try { collect(job, ctx); } catch (error) { reportError(error); }
      }
      jobs = undefined;
    }
    await Promise.all([...stores.values()].map(store => store.close()));
    stores.clear();
  }

  function jobList() {
    return (jobs?.list() ?? []).map(job => ({ id: job.id, status: job.status, label: job.label, cwd: job.cwd, route: job.metadata?.route, paths: job.paths }));
  }

  function manager(ctx: ExtensionContext) {
    if (jobs) return jobs;
    const settings = readWorkflowSettings(configCwd(ctx));
    const outputRoot = path.join(ctx.cwd, '.agent-runs', 'jobs');
    mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
    try { writeFileSync(path.join(outputRoot, '.gitignore'), '*\n', { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    jobs = createJobManager({ directory: path.join(outputRoot, randomUUID()), ...settings.jobs });
    return jobs;
  }

  function submit(launch: ReturnType<typeof buildManagedLaunch>, ctx: ExtensionContext, label?: string) {
    const job = manager(ctx).submit({ launch, label, metadata: { route: launch.route, sources: launch.sources } });
    return { id: job.id, status: job.status, route: launch.route, paths: job.paths,
      artifactSha256: launch.sources.artifactSha256 ?? null,
      next: 'workflow_jobs의 get/wait로 결과를 회수하세요. 프로세스 종료는 리뷰 승인이나 작업 완료의 증명이 아닙니다.' };
  }

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
    const effort = pi.getFlag('workflow-effort');
    if (effort !== undefined && (role !== 'worker' || typeof effort !== 'string')) throw new Error('--workflow-effort는 관리되는 Worker 전용입니다.');
    return buildPolicy(role, { cwd: ctx.cwd, configCwd: configCwd(ctx), effort });
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

  pi.on('session_start', async (_event, ctx) => {
    await dispose(ctx);
    sessionRole = null;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== 'custom' || entry.customType !== ENTRY) continue;
      const data = entry.data as { role?: unknown; cwd?: unknown } | undefined;
      if (data?.cwd === path.resolve(ctx.cwd) && (data.role === 'lead' || data.role === null)) sessionRole = data.role;
    }
    statusLabel(ctx);
  });
  pi.on('session_shutdown', async (_event, ctx) => { await dispose(ctx); });

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
    description: '상태·jobs·skills 확인, cancel <id>, off (모델 호출 없음)',
    handler: async (args, ctx) => {
      try {
        if (args.trim() === 'jobs') return message('workflow-jobs', JSON.stringify(jobList(), null, 2));
        if (args.trim() === 'metrics') return message('workflow-metrics', JSON.stringify(summarizeJobs((jobs?.list() ?? []).map(job => collect(job, ctx))), null, 2));
        if (args.trim() === 'runs') { requireLead(); assertConfiguredRole(ctx); return message('workflow-runs', JSON.stringify(workflowStore(ctx).list(), null, 2)); }
        if (args.trim() === 'skills') return message('workflow-skills', JSON.stringify(readSkillCatalog().map(({ name, invocation, when }) => ({ name, invocation, when })), null, 2));
        if (args.trim().startsWith('cancel ')) {
          if (!jobs) throw new Error('현재 세션이 소유한 job이 없습니다.');
          return message('workflow-jobs', JSON.stringify(jobs.cancel(args.trim().slice(7).trim()), null, 2));
        }
        if (args.trim() === 'off') {
          if (!ctx.isIdle() || activating) throw new Error('진행 중인 작업이 끝난 후 역할을 해제하세요.');
          if (jobList().some(job => ['running', 'queued'].includes(job.status))) throw new Error('하위 작업이 실행 중입니다. 완료를 기다리거나 /workflow cancel <id>로 취소하세요.');
          if (pi.getFlag('workflow-role') !== undefined) throw new Error('CLI로 역할을 고정한 세션입니다. --workflow-role 없이 새 Pi를 실행하세요.');
          persist(null, ctx);
          message('workflow-status', 'Paperthin 역할을 해제했습니다. 현재 모델은 유지되며 일반 Pi 대화를 계속할 수 있습니다.');
          return;
        }
        if (!['', 'status'].includes(args.trim())) throw new Error('사용법: /workflow, /workflow jobs, /workflow skills, /workflow runs, /workflow metrics, /workflow cancel <id>, /workflow off');
        const role = currentRole();
        const settings = readWorkflowSettings(configCwd(ctx), { projectTrusted: trusted(ctx) });
        const roles = settings.roles;
        message('workflow-status', JSON.stringify({
          active: role !== null, role, cwd: ctx.cwd,
          actualModel: { provider: ctx.model?.provider ?? null, model: ctx.model?.id ?? null, effort: pi.getThinkingLevel() },
          expected: roles[role ?? 'lead'],
          config: path.join(configCwd(ctx), '.pi/paperthin.json'), personalConfig: settings.personalConfig, projectTrusted: trusted(ctx),
          routing: settings.routing, jobs: { ...settings.jobs, active: jobList().filter(job => ['running', 'queued'].includes(job.status)).length },
          herdr: { insidePane: process.env.HERDR_ENV === '1', delegateAvailable: pi.getActiveTools().includes('herdr_delegate') },
          next: '/lead 원하는 작업을 입력하세요. 설정 파일은 선택 사항입니다. /workflow off는 역할을 해제합니다.',
        }, null, 2));
      } catch (error) { reportError(error); }
    },
  });

  pi.registerTool({
    name: 'workflow_prepare', label: 'Prepare role delegation',
    description: '대화형 Herdr 위임을 위한 호환 도구. 새 pane을 만들 수 있습니다. 일반 하위 작업은 bounded headless workflow_spawn을 사용하세요.',
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

  const assessmentSchema = Type.Object({
    recommended_tier: Type.Union([Type.Literal('fast'), Type.Literal('standard'), Type.Literal('frontier')]),
    recommended_effort: Type.Union([Type.Literal('glance'), Type.Literal('measured'), Type.Literal('thorough'), Type.Literal('exhaustive')]),
    rationale: Type.String(), move_up_if: Type.String(), move_down_if: Type.String(), proof_surface: Type.String(),
  }, { additionalProperties: false });

  pi.registerTool({
    name: 'workflow_skills', label: 'Paperthin catalog',
    description: 'Paperthin 전체 목록과 상황·역할·호출 조건을 조회합니다. user 스킬은 Lead의 명시적인 사용자 요청에서만 사용합니다.',
    parameters: Type.Object({ name: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      const all = readSkillCatalog();
      const selected = params.name ? all.filter(skill => skill.name === params.name) : all;
      if (!selected.length) throw new Error(`알 수 없는 스킬: ${params.name}`);
      return { content: [{ type: 'text', text: JSON.stringify(selected, null, 2) }], details: { skills: selected } };
    },
  });

  pi.registerTool({
    name: 'workflow_spawn', label: 'Spawn bounded subagent',
    description: 'Lead 전용. modelchk 여섯 필드로 실행 profile·effort를 선택하고 독립 headless 작업을 큐에 넣습니다. 새 pane을 만들지 않으며 결과는 workflow_jobs로 회수합니다.',
    parameters: Type.Object({
      task: Type.Union([Type.Literal('implement'), Type.Literal('review'), Type.Literal('analyze')]),
      cwd: Type.Optional(Type.String({ description: '관리 작업은 실행기가 정한 worktree와 일치해야 함; analyze는 절대경로 필수' })),
      runId: Type.Optional(Type.String()), taskId: Type.Optional(Type.String()),
      phase: Type.Optional(Type.Union([Type.Literal('plan_review'), Type.Literal('implement'), Type.Literal('code_review')])),
      brief: Type.String({ description: '작업 브리프 경로. 상대경로는 Lead 프로젝트 기준' }),
      assessment: assessmentSchema,
      profile: Type.Optional(Type.Union([Type.Literal('sol'), Type.Literal('opus'), Type.Literal('fable'), Type.Literal('codex')])),
      skills: Type.Optional(Type.Array(Type.String({ description: '현재 역할에 적합한 model-invoked 스킬 이름' }))),
      label: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      requireLead(); assertConfiguredRole(ctx); signal?.throwIfAborted();
      let result;
      const resolved = { ...params, brief: path.resolve(ctx.cwd, params.brief) };
      if (params.task === 'analyze') {
        if (!params.cwd || !path.isAbsolute(params.cwd)) throw new Error('analyze cwd는 절대경로여야 합니다.');
        if (params.runId || params.phase || params.taskId) throw new Error('analyze는 승인 작업이 아닙니다. runId/phase/taskId를 지정하지 마세요.');
        result = submit(buildManagedLaunch({ ...resolved, configCwd: configCwd(ctx) }), ctx, params.label);
      } else {
        if (!params.runId || !params.phase) throw new Error('구현·리뷰에는 workflow_run의 runId와 phase가 필요합니다.');
        result = submitWorkflowJob({ params: resolved, store: workflowStore(ctx), jobs: manager(ctx), configCwd: configCwd(ctx) });
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: result };
    },
  });

  pi.registerTool({
    name: 'workflow_jobs', label: 'Manage owned subagents',
    description: '현재 Lead가 소유한 headless 작업만 list/get/wait/cancel합니다. wait는 최대10초이며 대기 시간 초과는 작업 취소가 아닙니다.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('list'), Type.Literal('get'), Type.Literal('wait'), Type.Literal('cancel')]),
      id: Type.Optional(Type.String()), waitMs: Type.Optional(Type.Number({ minimum: 0, maximum: 10000 })) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      requireLead(); assertConfiguredRole(ctx); signal?.throwIfAborted();
      if (params.action === 'list') {
        const results = (jobs?.list() ?? []).map(job => collect(job, ctx));
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }], details: { jobs: results } };
      }
      if (!jobs || !params.id) throw new Error('현재 세션이 소유한 job id가 필요합니다.');
      let job;
      if (params.action === 'cancel') job = jobs.cancel(params.id);
      else if (params.action === 'wait') job = await jobs.wait(params.id, { timeoutMs: params.waitMs ?? 10000, signal });
      else if (params.action === 'get') job = jobs.get(params.id);
      else throw new Error('지원하지 않는 job 동작입니다.');
      const result = collect(job, ctx);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: result };
    },
  });

  pi.registerTool({
    name: 'workflow_run', label: 'Gated workflow state',
    description: '계획 승인·worktree·후보·검증·통합을 관리합니다. check는 argv를 직접 실행해 근거를 남깁니다. complete는 통합 후보 검사와 최종 코드 리뷰 승인을 요구합니다. 리뷰 판정은 workflow_jobs에서만 회수합니다.',
    parameters: Type.Object({
      action: Type.Union(['start','list','get','plan','task','freeze','check','recover','integrate','complete'].map(value => Type.Literal(value))),
      runId: Type.Optional(Type.String()), plan: Type.Optional(Type.String()),
      taskId: Type.Optional(Type.String()), files: Type.Optional(Type.Array(Type.String())),
      dependsOn: Type.Optional(Type.Array(Type.String())), brief: Type.Optional(Type.String()),
      argv: Type.Optional(Type.Array(Type.String())), timeoutMs: Type.Optional(Type.Number({ minimum: 1, maximum: 60000 })),
      phase: Type.Optional(Type.String()), reason: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      requireLead(); assertConfiguredRole(ctx); signal?.throwIfAborted();
      const store = workflowStore(ctx);
      let result;
      const planPath = params.plan ? path.resolve(ctx.cwd, params.plan) : undefined;
      if (params.action === 'list') result = store.list();
      else if (params.action === 'start') result = store.start({ runId: params.runId, planPath });
      else {
        if (!params.runId) throw new Error('runId가 필요합니다.');
        if (params.action === 'get') result = store.get(params.runId);
        else if (params.action === 'plan') result = store.snapshotPlan(params.runId, { planPath });
        else if (params.action === 'task') result = store.addTask(params.runId, { taskId: params.taskId, files: params.files, dependsOn: params.dependsOn, briefPath: params.brief ? path.resolve(ctx.cwd, params.brief) : undefined });
        else if (params.action === 'freeze') result = store.freezeTask(params.runId, params.taskId);
        else if (params.action === 'check') result = await store.recordChecks(params.runId, { taskId: params.taskId, argv: params.argv, timeoutMs: params.timeoutMs, signal });
        else if (params.action === 'recover') result = store.recoverTask(params.runId, { taskId: params.taskId, phase: params.phase, reason: params.reason });
        else if (params.action === 'integrate') result = store.integrate(params.runId);
        else if (params.action === 'complete') result = store.complete(params.runId);
        else throw new Error('Unknown workflow action.');
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: result };
    },
  });

  pi.registerTool({
    name: 'workflow_tab', label: 'Open interactive task tab',
    description: 'Herdr 내부에서 명시한 workspace에 새 대화형 보조 세션을 엽니다. 기존 headless job을 이동하지 않으며 탭 결과를 승인 근거로 자동 등록하지 않습니다.',
    parameters: Type.Object({ workspaceId: Type.String(), cwd: Type.String(), label: Type.String(),
      role: Type.Union([Type.Literal('worker'), Type.Literal('codex-worker'), Type.Literal('reviewer'), Type.Literal('escalation')]),
      brief: Type.String() }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      requireLead(); assertConfiguredRole(ctx); signal?.throwIfAborted();
      const launch = buildLaunch({ role: params.role, cwd: params.cwd, brief: path.resolve(ctx.cwd, params.brief), configCwd: configCwd(ctx) });
      try {
        const result = await createHerdrTaskTab({ workspaceId: params.workspaceId, cwd: params.cwd, label: params.label, launch });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: result };
      } catch (error) {
        if (!error.createdTab) throw error;
        const details = { error: error.message, stage: error.stage, createdTab: error.createdTab };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(details, null, 2) }], details };
      }
    },
  });

  pi.registerTool({
    name: 'workflow_cold_read', label: 'Paperthin cold read',
    description: 'Lead 전용. artifact 내용만 보는 독립 세션을 같은 bounded queue에 등록합니다. shower 및 명시적으로 요청한 독립 관점 읽기에 사용하고 workflow_jobs로 해석·해시를 회수하세요.',
    parameters: Type.Object({ artifact: Type.String(), lens: Type.Optional(Type.String({ description: '중립 검토 질문만 전달. 부모 의도·대화·답안은 금지' })),
      assessment: Type.Optional(assessmentSchema), profile: Type.Optional(Type.Union([Type.Literal('sol'), Type.Literal('opus'), Type.Literal('fable')])) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      requireLead();
      assertConfiguredRole(ctx);
      signal?.throwIfAborted();
      const assessment = params.assessment ?? { recommended_tier: 'standard', recommended_effort: 'measured',
        rationale: '단일 산출물의 독립 이해도 점검', move_up_if: '고위험 의사결정 또는 복합 산출물의 해석',
        move_down_if: '짧고 기계적으로 검증 가능한 문구', proof_surface: '독립 해석, 읽은 범위, 실제 산출물 해시를 의도와 대조' };
      const launch = buildManagedLaunch({ ...params, task: 'probe', assessment, cwd: ctx.cwd, configCwd: configCwd(ctx), artifact: path.resolve(ctx.cwd, params.artifact) });
      const result = submit(launch, ctx, 'independent-read');
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: result };
    },
  });
}
