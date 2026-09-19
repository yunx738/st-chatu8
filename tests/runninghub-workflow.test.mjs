import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunningHubOverrides as build, prepareRunningHubNodeInfo as prepare,
  parseRunningHubGraph, bindRunningHubOverrideControl as bind } from '../runninghub-workflow.mjs';

const copy = x => JSON.parse(JSON.stringify(x));
function fixture() {
  const raw = {
    '1': { class_type: 'Text', inputs: { text: '%prompt%', optional: false } },
    '2': { class_type: 'Sampler', inputs: { seed: '%seed%', steps: 8, model: ['3', 0] } },
    '3': { class_type: 'Loader', inputs: { model_name: 'local.safetensors', strength: 0.9 } }
  };
  const runtime = copy(raw); runtime['1'].inputs.text = 'a landscape'; runtime['2'].inputs.seed = 42;
  const cloud = copy(runtime); cloud['1'].inputs.text = 'cloud'; cloud['3'].inputs.model_name = 'remote.safetensors';
  return { raw, runtime, cloud };
}
const keys = out => out.map(x => `${x.nodeId}.${x.fieldName}`);
const expectCode = code => error => error.code === code;
const ok = graph => ({ ok: true, status: 200, json: async () => ({ code: 0, data: { prompt: JSON.stringify(graph) } }) });
function args(f, extra = {}) {
  return { rawJson: JSON.stringify(f.raw), promptObj: f.runtime, workflowId: '1234567890123456789',
    apiKey: 'fixture-key', fetchImpl: async () => ok(f.cloud), ...extra };
}

test('default mode retains legacy placeholder/diff selection, including old preset cruft', () => {
  const f = fixture();
  f.raw['90'] = { class_type: 'Loader', inputs: { model_name: 'unused.safetensors', strength: 0 } };
  f.runtime['90'] = copy(f.raw['90']);
  assert.deepEqual(keys(build(f.raw, f.runtime, f.cloud)), ['1.text', '2.seed']);
});
test('runtime edits still override values in default mode', () => {
  const f = fixture(); f.runtime['2'].inputs.steps = 12;
  assert.deepEqual(keys(build(f.raw, f.runtime, f.cloud)), ['1.text', '2.seed', '2.steps']);
});
test('fixed inputs are opt-in and compared to real cloud defaults', () => {
  const f = fixture();
  assert.deepEqual(keys(build(f.raw, f.runtime, f.cloud, { includeLiterals: 'true' })), ['1.text', '2.seed', '3.model_name']);
  for (const value of [false, 'false', undefined, 'yes']) {
    assert.deepEqual(keys(build(f.raw, f.runtime, f.cloud, { includeLiterals: value })), ['1.text', '2.seed']);
  }
});
test('false, zero and empty string remain valid explicit overrides', () => {
  const raw = { '1': { class_type: 'Options', inputs: { enabled: false, strength: 0, text: '' } } };
  const cloud = { '1': { class_type: 'Options', inputs: { enabled: true, strength: 1, text: 'default' } } };
  assert.deepEqual(build(raw, copy(raw), cloud, { includeLiterals: true }).map(x => x.fieldValue), [false, 0, '']);
});
for (const field of ['model_name', 'seed', 'steps']) {
  for (const fixed of [false, true]) {
    test(`missing cloud node is rejected for requested ${field} (fixed=${fixed})`, () => {
      const f = fixture();
      f.raw['90'] = { class_type: 'Absent', inputs: { [field]: field === 'seed' ? '%seed%' : 'before' } };
      f.runtime['90'] = { class_type: 'Absent', inputs: { [field]: field === 'seed' ? 7 : 'after' } };
      assert.throws(() => build(f.raw, f.runtime, f.cloud, { includeLiterals: fixed }), expectCode('RH_WORKFLOW_MISMATCH'));
    });
  }
}
test('fixed mode cannot silently drop a missing static LoRA node', () => {
  const f = fixture(); delete f.cloud['3'];
  assert.throws(() => build(f.raw, f.runtime, f.cloud, { includeLiterals: true }), /3: 云端不存在/);
});
test('missing input field fails before submission', () => {
  const f = fixture(); delete f.cloud['1'].inputs.text;
  assert.throws(() => build(f.raw, f.runtime, f.cloud), /1.text: 云端节点不存在/);
});
test('a reused node ID with a different class is rejected', () => {
  const f = fixture(); f.cloud['1'].class_type = 'Unrelated';
  assert.throws(() => build(f.raw, f.runtime, f.cloud), /另一种节点类型/);
});
test('local links are never serialized as scalar overrides', () => {
  const f = fixture();
  assert.ok(!keys(build(f.raw, f.runtime, f.cloud, { includeLiterals: true })).includes('2.model'));
});
test('fixed mode rejects incompatible local/cloud graph edges', () => {
  const f = fixture(); f.cloud['2'].inputs.model = ['1', 0];
  assert.throws(() => build(f.raw, f.runtime, f.cloud, { includeLiterals: true }), /连线不同/);
  assert.deepEqual(keys(build(f.raw, f.runtime, f.cloud)), ['1.text', '2.seed']);
});
test('runtime rewiring cannot be smuggled through legacy mode', () => {
  const f = fixture(); f.runtime['2'].inputs.model = ['1', 0];
  assert.throws(() => build(f.raw, f.runtime, f.cloud), /不能修改节点连线/);
});
test('cloud links cannot be overwritten with literals', () => {
  const f = fixture(); f.cloud['1'].inputs.text = ['3', 0];
  assert.throws(() => build(f.raw, f.runtime, f.cloud), /不能用常量覆盖/);
});
test('runtime-added nodes and runtime class changes are rejected', () => {
  const f = fixture(); f.runtime['4'] = { class_type: 'Extra', inputs: { value: 1 } };
  assert.throws(() => build(f.raw, f.runtime, f.cloud), /运行时新增节点/);
  delete f.runtime['4']; f.runtime['1'].class_type = 'Different';
  assert.throws(() => build(f.raw, f.runtime, f.cloud), /运行时修改了节点类型/);
});
test('ordinary two-string arrays and object-valued fields are not graph edges', () => {
  const raw = { '1': { class_type: 'Options', inputs: { choices: ['before', 'list'], options: { a: true } } } };
  const runtime = copy(raw); runtime['1'].inputs.choices = ['after', 'list']; runtime['1'].inputs.options.a = false;
  assert.deepEqual(build(raw, runtime, copy(raw)).map(x => x.fieldName), ['choices', 'options']);
});
test('object key ordering does not create a spurious override', () => {
  const raw = { '1': { class_type: 'Options', inputs: { data: { a: 1, b: 2 } } } };
  const runtime = { '1': { class_type: 'Options', inputs: { data: { b: 2, a: 1 } } } };
  assert.deepEqual(build(raw, runtime, copy(raw)), []);
});
for (const value of [NaN, Infinity, undefined, Number.MAX_SAFE_INTEGER + 1, '42']) {
  test(`invalid numeric runtime value is rejected: ${String(value)}`, () => {
    const f = fixture(); f.runtime['2'].inputs.seed = value;
    assert.throws(() => build(f.raw, f.runtime, f.cloud), expectCode('RH_WORKFLOW_MISMATCH'));
  });
}
for (const graph of [null, {}, [], '{bad', { nodes: [], links: [] }, { '1': { inputs: {} } }]) {
  test(`invalid/API-editor graph rejected: ${JSON.stringify(graph)}`, () => {
    assert.throws(() => parseRunningHubGraph(graph), expectCode('RH_INVALID_GRAPH'));
  });
}
test('inputs are not mutated and returned structured values are detached', () => {
  const f = fixture(); const before = JSON.stringify(f);
  build(f.raw, f.runtime, f.cloud, { includeLiterals: true });
  assert.equal(JSON.stringify(f), before);
});
test('preflight uses the production origin, exact ID and leased key without redirects', async () => {
  const f = fixture(); const calls = [];
  await prepare(args(f, { fetchImpl: async (url, init) => { calls.push([url, init]); return ok(f.cloud); } }));
  assert.equal(calls.length, 1);
  const [url, init] = calls[0];
  assert.equal(url, 'https://www.runninghub.ai/api/openapi/getJsonApiFormat');
  assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, 'Bearer fixture-key');
  assert.deepEqual(JSON.parse(init.body), { apiKey: 'fixture-key', workflowId: '1234567890123456789' });
});
test('there is no cross-key, cross-workflow or stale-success cache', async () => {
  const f = fixture(); const sent = [];
  const fetchImpl = async (_url, init) => { sent.push(JSON.parse(init.body)); return ok(f.cloud); };
  await prepare(args(f, { fetchImpl }));
  await prepare(args(f, { fetchImpl, apiKey: 'second-key', workflowId: '2' }));
  delete f.cloud['1'];
  await assert.rejects(prepare(args(f, { fetchImpl })), expectCode('RH_WORKFLOW_MISMATCH'));
  assert.deepEqual(sent.map(x => [x.workflowId, x.apiKey]), [
    ['1234567890123456789', 'fixture-key'], ['2', 'second-key'], ['1234567890123456789', 'fixture-key']]);
});
for (const [name, response, code] of [
  ['HTTP 403', { ok: false, status: 403 }, 'RH_PREFLIGHT_HTTP'],
  ['API denial', { ok: true, json: async () => ({ code: 403, msg: 'fixture-key' }) }, 'RH_PREFLIGHT_API'],
  ['bad JSON', { ok: true, json: async () => { throw Error('fixture-key'); } }, 'RH_PREFLIGHT_NETWORK'],
  ['no prompt', { ok: true, json: async () => ({ code: 0, data: {} }) }, 'RH_INVALID_GRAPH']
]) {
  test(`preflight fails closed with no raw body/key leak: ${name}`, async () => {
    await assert.rejects(prepare(args(fixture(), { fetchImpl: async () => response })), error => {
      assert.equal(error.code, code); assert.ok(!error.message.includes('fixture-key')); return true;
    });
  });
}
test('network errors are sanitized instead of falling back to unvalidated overrides', async () => {
  await assert.rejects(prepare(args(fixture(), { fetchImpl: async () => { throw Error('fixture-key'); } })), error =>
    error.code === 'RH_PREFLIGHT_NETWORK' && !error.message.includes('fixture-key'));
});
test('timeout covers a hanging fetch even when it ignores AbortSignal', async () => {
  await assert.rejects(prepare(args(fixture(), { timeoutMs: 20, fetchImpl: async () => new Promise(() => {}) })), expectCode('RH_PREFLIGHT_TIMEOUT'));
});
test('timeout also covers a hanging response body', async () => {
  await assert.rejects(prepare(args(fixture(), { timeoutMs: 20, fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }) })), expectCode('RH_PREFLIGHT_TIMEOUT'));
});
test('already cancelled tasks perform no request', async () => {
  let called = false;
  await assert.rejects(prepare(args(fixture(), { isTaskCancelled: () => true, fetchImpl: async () => { called = true; } })), expectCode('RH_CANCELLED'));
  assert.equal(called, false);
});
test('cancellation during the network call aborts promptly', async () => {
  let cancel = false, signal;
  const timer = setTimeout(() => { cancel = true; }, 10);
  await assert.rejects(prepare(args(fixture(), { isTaskCancelled: () => cancel,
    fetchImpl: async (_url, init) => { signal = init.signal; return new Promise(() => {}); } })), expectCode('RH_CANCELLED'));
  clearTimeout(timer); assert.equal(signal.aborted, true);
});
test('cancellation immediately after the graph arrives still prevents submission', async () => {
  const f = fixture(); let cancel = false;
  await assert.rejects(prepare(args(f, { isTaskCancelled: () => cancel,
    fetchImpl: async () => ({ ok: true, json: async () => { cancel = true; return { code: 0, data: { prompt: f.cloud } }; } }) })), expectCode('RH_CANCELLED'));
});
test('invalid IDs cannot be truncated or coerced through JavaScript numbers', async () => {
  for (const id of [1234567890123456789, '', 'abc']) {
    await assert.rejects(prepare(args(fixture(), { workflowId: id })), expectCode('RH_INVALID_ID'));
  }
});
test('error descriptions omit values and remove HTML from field identifiers', () => {
  const f = fixture(); f.raw['1'].inputs['<script>'] = '%prompt%'; f.runtime['1'].inputs['<script>'] = 'private prompt';
  assert.throws(() => build(f.raw, f.runtime, f.cloud), error => {
    assert.ok(!error.message.includes('<script>')); assert.ok(!error.message.includes('private prompt')); return true;
  });
});
test('fixed-input UI is default-off, saved, and not duplicated on reinitialization', () => {
  let input, sections = 0, saves = 0;
  const tab = { querySelector: () => input || null, prepend: () => { sections++; }, ownerDocument: {
    createElement: () => ({ set innerHTML(_value) { input = {}; }, querySelector: () => input })
  } };
  const root = { querySelector: () => tab }, settings = {};
  bind([root], settings, () => saves++); assert.equal(input.checked, false);
  input.checked = true; input.onchange(); assert.equal(settings.runninghub_send_fixed_inputs, true); assert.equal(saves, 1);
  bind(root, settings, () => saves++); assert.equal(sections, 1); assert.equal(input.checked, true);
  input.checked = false; input.onchange(); assert.equal(settings.runninghub_send_fixed_inputs, false); assert.equal(saves, 2);
});
