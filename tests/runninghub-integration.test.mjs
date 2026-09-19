// Exercise the actual submit/retry/finally blocks from the shipped bundle.
// The network is mocked, not the override preparation or lifecycle implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { prepareRunningHubNodeInfo } from '../runninghub-workflow.mjs';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const callers = [
  ['image', 'async function generateRunningHubImage(', '\nasync function runninghubgenerate('],
  ['reference-video', 'async function generateRunningHubRefVideo(', '\nasync function executeRunningHubVideoDirectTest(']
];
function lifecycle(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, 'actual production caller must exist');
  const fn = source.slice(a, b);
  const lease = fn.indexOf('  let keyLease = null;');
  assert.ok(lease >= 0, 'production key lease / cleanup block must exist');
  return fn.slice(lease, fn.lastIndexOf('}'));
}
async function runProduction(code, scenario = {}) {
  const raw = { '1': { class_type: 'Text', inputs: { text: '%prompt%', strength: 0 } } };
  const runtime = { '1': { class_type: 'Text', inputs: { text: 'fixture prompt', strength: 0 } } };
  const cloud = { '1': { class_type: 'Text', inputs: { text: 'default', strength: 1 } } };
  if (scenario.missing) { delete cloud['1']; cloud['2'] = { class_type: 'Other', inputs: { value: 0 } }; }
  // An unchanged stale node must stay inert in legacy mode.
  raw['90'] = { class_type: 'Loader', inputs: { value: 1 } };
  runtime['90'] = { class_type: 'Loader', inputs: { value: 1 } };
  if (scenario.fixed) { delete raw['90']; delete runtime['90']; }
  const calls = [], completions = [], logs = [];
  let leases = 0, releases = 0, active = true, creates = 0;
  const fetchMock = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (url.endsWith('/getJsonApiFormat')) {
      if (scenario.httpFailure) return { ok: false, status: 403 };
      if (scenario.networkFailure) throw Error('do-not-log-fixture-key');
      if (scenario.timeout) return new Promise(() => {});
      if (scenario.cancel) active = false;
      const graph = scenario.rejectSecondKey && leases === 2 ? { '2': { class_type: 'Other', inputs: {} } } : cloud;
      return { ok: true, json: async () => ({ code: 0, data: { prompt: JSON.stringify(graph) } }) };
    }
    if (url.includes('/run/workflow/')) {
      creates++;
      if (scenario.queueRetry && creates === 1) return { json: async () => ({ errorMessage: 'TASK_QUEUE_MAXED' }) };
      return { json: async () => ({ taskId: 'remote-fixture-task' }) };
    }
    if (url.endsWith('/query')) return { json: async () => ({ status: 'FAILED', errorMessage: 'fixture-stop-after-submit' }) };
    throw Error(`Unexpected endpoint: ${url}`);
  };
  const context = {
    Error, console: { error() {}, warn() {} },
    rawJson: JSON.stringify(raw), targetWorkerJson: JSON.stringify(raw), promptObj: runtime,
    workflowId: '1234567890123456789', targetWorkflowId: '1234567890123456789', taskId: 'local-fixture-task',
    settings3: { runninghub_send_fixed_inputs: scenario.fixed || false },
    taskQueue: { isTaskInQueue: () => active, updateStatus() {}, completeTask: (...x) => completions.push(x) },
    acquireRunningHubKey: async () => { leases++; return { apiKey: `do-not-log-fixture-key-${leases}`, releaseKey: () => { releases++; } }; },
    prepareRunningHubNodeInfo: options => prepareRunningHubNodeInfo({ ...options, fetchImpl: fetchMock, timeoutMs: 20 }),
    fetch: fetchMock, sleep: async () => {}, TaskStatus: { QUEUED: 'queued' },
    addLog: message => logs.push(message), toastr: { error() {} }, recordImageGeneration() {},
    formatRunningHubApiError: data => data.errorMessage || 'fixture-error', currentTaskId4: 'local-fixture-task'
  };
  let error;
  try { await vm.runInNewContext(`(async () => { ${code} })()`, context); }
  catch (e) { error = e; }
  return { calls, completions, logs, leases, releases, creates, error };
}

test('both production callers await cloud validation and settings UI is connected', () => {
  assert.equal((source.match(/const nodeInfoList = await prepareRunningHubNodeInfo\(/g) || []).length, 2);
  assert.ok(source.includes('bindRunningHubOverrideControl(settingsModal, settings3, saveSettingsDebounced53);'));
  assert.ok(!source.includes('function extractNodeInfoListFromWorkflow('));
  assert.ok(!source.includes('RH_LITERAL_OVERRIDES_FIX_V1'));
});
for (const [name, start, end] of callers) {
  const code = lifecycle(start, end);
  for (const fixed of [false, true]) {
    test(`${name}: actual submit payload is validated, leased key is consistent, fixed=${fixed}`, async () => {
      const r = await runProduction(code, { fixed });
      assert.equal(r.creates, 1); assert.equal(r.error.message, 'fixture-stop-after-submit');
      const preflight = r.calls[0], create = r.calls.find(x => x.url.includes('/run/workflow/'));
      assert.ok(preflight.url.endsWith('/getJsonApiFormat'));
      assert.equal(preflight.init.headers.Authorization, create.init.headers.Authorization);
      assert.equal(preflight.body.workflowId, create.url.split('/').at(-1));
      assert.deepEqual(create.body.nodeInfoList.map(x => x.fieldName), fixed ? ['text', 'strength'] : ['text']);
      assert.ok(create.body.nodeInfoList.every(x => x.nodeId === '1'));
      assert.equal(r.releases, 1); assert.equal(r.leases, 1);
      assert.ok(r.logs.every(line => !line.includes('do-not-log-fixture-key')));
    });
  }
  for (const [scenario, errorCode] of [
    ['missing', 'RH_WORKFLOW_MISMATCH'], ['httpFailure', 'RH_PREFLIGHT_HTTP'],
    ['networkFailure', 'RH_PREFLIGHT_NETWORK'], ['timeout', 'RH_PREFLIGHT_TIMEOUT'], ['cancel', 'RH_CANCELLED']
  ]) {
    test(`${name}: ${scenario} prevents creation and releases the key`, async () => {
      const r = await runProduction(code, { [scenario]: true });
      assert.equal(r.creates, 0); assert.equal(r.error.code, errorCode);
      assert.equal(r.releases, 1); assert.equal(r.leases, 1);
      if (scenario === 'cancel') assert.equal(r.completions.length, 0);
      else assert.ok(r.completions.some(x => x[1] === false));
      assert.ok(!r.error.message.includes('do-not-log-fixture-key'));
    });
  }
  test(`${name}: queue retry revalidates with the second key`, async () => {
    const r = await runProduction(code, { queueRetry: true, rejectSecondKey: true });
    assert.equal(r.creates, 1); assert.equal(r.leases, 2); assert.equal(r.releases, 2);
    assert.equal(r.error.code, 'RH_WORKFLOW_MISMATCH');
    assert.deepEqual(r.calls.filter(x => x.url.endsWith('/getJsonApiFormat')).map(x => x.body.apiKey),
      ['do-not-log-fixture-key-1', 'do-not-log-fixture-key-2']);
  });
}
