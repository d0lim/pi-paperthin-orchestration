import assert from 'node:assert/strict';
import test from 'node:test';
import { submitWorkflowJob, collectWorkflowJob } from '../lib/controller.mjs';

const assessment = { recommended_tier:'standard', recommended_effort:'measured', rationale:'bounded', move_up_if:'risk', move_down_if:'simple', proof_surface:'tests' };
const planSha256 = 'a'.repeat(64);
function fixture() {
  const calls = [];
  const store = {
    prepareAttempt(runId, input) { calls.push(['prepare', runId, input]); return { attemptId:'attempt-1', cwd:'/tmp', planSha256, baseSha:null, candidateSha:null }; },
    bindAttempt(...args) { calls.push(['bind', ...args]); },
    abortAttempt(...args) { calls.push(['abort', ...args]); },
    settleAttempt(...args) { calls.push(['settle', ...args]); return { status:'PLAN_APPROVED' }; },
  };
  const jobs = {
    submit(input) { calls.push(['submit', input]); return { id:'job-1', status:'running', paths:{}, metadata:input.metadata }; },
    cancel(id) { calls.push(['cancel', id]); },
  };
  const route = { phase:'plan_review',runtime:'claude',model:'claude-fable-5-1',profile:'fable' };
  return { calls,store,jobs, route, routeTask:()=>route, buildManagedLaunch: input=>({ ...input, runtime:'claude', args:[], sources:{}, route }) };
}

test('managed implementation and review cannot bypass a named run and phase', () => {
  const f=fixture();
  assert.throws(()=>submitWorkflowJob({...f,params:{task:'implement',assessment},configCwd:'/tmp'}),/runId|phase/);
  assert.equal(f.calls.length,0);
});
test('billing refusal happens before reserving a workflow attempt', () => {
  const f=fixture(); f.route.requiresBillingAuthorization=true;
  assert.throws(()=>submitWorkflowJob({...f,params:{task:'review',phase:'plan_review',runId:'run',brief:'/tmp/brief',assessment},configCwd:'/tmp'}),/Fable|usage credits/);
  assert.equal(f.calls.length,0);
});
test('review target is derived from guarded state and persisted with the owned job', () => {
  const f=fixture();
  const job=submitWorkflowJob({...f,params:{task:'review',phase:'plan_review',runId:'run',brief:'/tmp/brief',assessment},configCwd:'/tmp'});
  assert.equal(job.id,'job-1');
  const submitted=f.calls.find(c=>c[0]==='submit')[1];
  assert.deepEqual(submitted.metadata.reviewTarget,{planSha256,baseSha:null,candidateSha:null});
  assert.equal(submitted.metadata.workflow.attemptId,'attempt-1');
  assert.equal(f.calls.at(-1)[0],'bind');
});
test('queue rejection releases the reservation and bind failure cancels only its own job', () => {
  const params={task:'review',phase:'plan_review',runId:'run',brief:'/tmp/brief',assessment};
  const f=fixture(); f.jobs.submit=()=>{throw new Error('queue full');};
  assert.throws(()=>submitWorkflowJob({...f,params,configCwd:'/tmp'}),/queue full/);
  assert.equal(f.calls.at(-1)[0],'abort');
  const g=fixture();g.store.bindAttempt=()=>{throw new Error('disk failed');};
  assert.throws(()=>submitWorkflowJob({...g,params,configCwd:'/tmp'}),/disk failed/);
  assert.ok(g.calls.some(c=>c[0]==='cancel'&&c[1]==='job-1'));
});
test('only terminal owned workflow jobs are settled; process completion alone is preserved', () => {
  const f=fixture();
  const job={id:'job-1',status:'running',metadata:{workflow:{runId:'run',attemptId:'attempt-1'}}};
  collectWorkflowJob(job,f.store);
  assert.equal(f.calls.length,0);
  const result=collectWorkflowJob({...job,status:'failed',exitCode:1},f.store);
  assert.equal(result.status,'failed');
  assert.equal(f.calls.at(-1)[0],'settle');
});


test('configuration drift between preparation and launch aborts before submission', () => {
  const f=fixture();
  f.buildManagedLaunch=input=>({...input,route:{...f.route,model:'unexpected-model'}});
  assert.throws(()=>submitWorkflowJob({...f,params:{task:'review',phase:'plan_review',runId:'run',brief:'/tmp/brief',assessment},configCwd:'/tmp'}),/Route changed/);
  assert.ok(!f.calls.some(call=>call[0]==='submit'));
  assert.equal(f.calls.at(-1)[0],'abort');
});


test('provider drift aborts a prepared job before submission', () => {
  const f = fixture();
  Object.assign(f.route, { runtime: 'pi', provider: 'openai-codex', model: 'gpt-5.6-sol', profile: 'sol', phase: 'implement' });
  f.buildManagedLaunch = input => ({ ...input, route: { ...f.route, provider: 'other-provider' } });
  assert.throws(() => submitWorkflowJob({ ...f, params: { task: 'implement', phase: 'implement', runId: 'run', brief: '/tmp/brief', assessment }, configCwd: '/tmp' }), /Route changed/);
  assert.ok(!f.calls.some(call => call[0] === 'submit'));
  assert.equal(f.calls.at(-1)[0], 'abort');
});
