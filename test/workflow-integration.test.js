import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { WorkflowStore } from '../lib/workflow-state.mjs';
import { JobManager } from '../lib/jobs.mjs';
import { buildManagedLaunch } from '../lib/routing.mjs';
import { submitWorkflowJob, collectWorkflowJob } from '../lib/controller.mjs';

process.env.PAPERTHIN_SETTINGS_PATH = path.join(os.tmpdir(), 'paperthin-integration-no-settings-' + process.pid + '.json');
const assessment={recommended_tier:'standard',recommended_effort:'measured',rationale:'bounded fixture',move_up_if:'new risk',move_down_if:'simple',proof_surface:'real git and process checks'};
function git(cwd,...args){return execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}

test('real Git/worktree/process chain enforces plan, task, integration reviews and completion', async t=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'paperthin integrated '));
  const cwd=path.join(directory,'project'); mkdirSync(cwd);
  git(cwd,'init','-q'); git(cwd,'config','user.name','Test'); git(cwd,'config','user.email','test@example.invalid');
  mkdirSync(path.join(cwd,'.pi'));
  writeFileSync(path.join(cwd,'.pi','paperthin.json'),JSON.stringify({routing:{allowFableHeadless:true}}));
  writeFileSync(path.join(cwd,'feature.txt'),'before\n');
  git(cwd,'add','.pi/paperthin.json','feature.txt'); git(cwd,'commit','-qm','baseline');
  const original=git(cwd,'rev-parse','HEAD');
  const brief=path.join(directory,'brief.md');writeFileSync(brief,'Implement and verify the requested feature.');
  const plan=path.join(directory,'plan.md');writeFileSync(plan,'Change feature.txt to after; verify exact output.');
  const store=new WorkflowStore({cwd});
  const jobs=new JobManager({directory:path.join(directory,'jobs')});
  t.after(async()=>{await jobs.dispose();await store.close();rmSync(directory,{recursive:true,force:true});});
  const run=store.start({runId:'integration',planPath:plan});
  const task=store.addTask(run.runId,{taskId:'feature',files:['feature.txt']});
  const launchMock=options=>{
    const real=buildManagedLaunch(options);
    assert.equal(options.workflowContext.planSnapshot, readFileSync(plan, 'utf8'));
    assert.equal(real.args.at(-1), real.prompt);
    assert.ok(real.prompt.includes(JSON.stringify(options.workflowContext)));
    if(options.phase==='code_review') {
      assert.ok(options.workflowContext.checks.length > 0);
      assert.ok(options.workflowContext.checks.every(check=>check.status==='passed' && check.candidateSha===options.reviewTarget.candidateSha && check.argv.length));
    }
    const output=options.task==='review' ? JSON.stringify({result:JSON.stringify({phase:options.phase,...options.reviewTarget,verdict:'approve',findings:[]}),modelUsage:{[real.route.model]:{}},is_error:false})
      : JSON.stringify({type:'item.completed',model:real.route.model,item:{type:'agent_message',text:'Implementation finished.'}});
    return {...real,runtime:process.execPath,args:['-e',`process.stdout.write(${JSON.stringify(output+'\n')})`,'--',real.prompt]};
  };
  async function execute(phase,taskId){
    const job=submitWorkflowJob({store,jobs,configCwd:cwd,buildManagedLaunch:launchMock,params:{task:phase==='implement'?'implement':'review',phase,runId:run.runId,taskId,brief,assessment}});
    let raw=await jobs.wait(job.id); while(['running','queued'].includes(raw.status))raw=await jobs.wait(job.id);
    const result=collectWorkflowJob(raw,store);
    assert.equal(result.runtimeError,false); assert.equal(result.exitCode,0);
    assert.equal(result.workflow.status,'succeeded', JSON.stringify(result));
    return result;
  }
  assert.throws(()=>submitWorkflowJob({store,jobs,configCwd:cwd,buildManagedLaunch:launchMock,params:{task:'implement',phase:'implement',runId:run.runId,taskId:'feature',brief,assessment}}),/plan approval/i);
  await execute('plan_review');
  await execute('implement','feature');
  writeFileSync(path.join(task.worktree,'feature.txt'),'after\n');
  git(task.worktree,'add','feature.txt');git(task.worktree,'commit','-qm','implement feature');
  store.freezeTask(run.runId,'feature');
  assert.throws(()=>store.prepareAttempt(run.runId,{phase:'code_review',taskId:'feature'}),/checks/);
  const argv=[process.execPath,'-e',"if(require('node:fs').readFileSync('feature.txt','utf8')!=='after\\n')process.exit(1)"];
  assert.equal((await store.recordChecks(run.runId,{taskId:'feature',argv})).status,'passed');
  await execute('code_review','feature');
  const integrated=store.integrate(run.runId);
  assert.equal(git(cwd,'rev-parse','HEAD'),original,'original user branch stays untouched');
  assert.equal(readFileSync(path.join(integrated.worktree,'feature.txt'),'utf8'),'after\n');
  assert.throws(()=>store.complete(run.runId),/checks|review|approval/);
  assert.equal((await store.recordChecks(run.runId,{argv})).status,'passed');
  assert.throws(()=>store.complete(run.runId),/review|approval/);
  await execute('code_review');
  assert.equal(store.complete(run.runId).status,'completed');
});
