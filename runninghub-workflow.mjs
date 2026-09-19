// RunningHub overrides target a remote graph; a local template is not proof of existence.
const ORIGIN = 'https://www.runninghub.ai';
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const enabled = value => value === true || value === 'true';
const label = value => String(value).replace(/[<>&"'\r\n]/g, '').slice(0, 90);

export class RunningHubWorkflowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RunningHubWorkflowError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new RunningHubWorkflowError(code, message); };
const cancelled = () => new RunningHubWorkflowError('RH_CANCELLED', '任务已取消');

/** Accept only ComfyUI API-format graphs, not editor JSON or preset wrappers. */
export function parseRunningHubGraph(value, source = '工作流') {
  let graph = value;
  try { if (typeof graph === 'string') graph = JSON.parse(graph); }
  catch { fail('RH_INVALID_GRAPH', `${source} JSON 无法解析；请使用 API 格式导出。`); }
  if (!record(graph) || Object.keys(graph).length === 0 ||
      Object.values(graph).some(node => !record(node) || !record(node.inputs) ||
        typeof node.class_type !== 'string' || !node.class_type.trim())) {
    fail('RH_INVALID_GRAPH', `${source}不是有效的 API 格式节点图；不能把编辑器 JSON 或整个预设作为节点图。`);
  }
  return graph;
}

function same(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => own(b, key) && same(a[key], b[key]));
}
function connection(value, graph) {
  return Array.isArray(value) && value.length === 2 &&
    (typeof value[0] === 'string' || typeof value[0] === 'number') &&
    Number.isInteger(value[1]) && value[1] >= 0 && own(graph, String(value[0]));
}
function jsonValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const ok = Object.values(value).every(item => jsonValue(item, seen));
  seen.delete(value);
  return ok;
}
function kind(value) { return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value; }

/**
 * Legacy mode selects the same placeholder/runtime-diff fields as upstream.
 * Explicit fixed-input mode also sends literals, but never rewires/adds nodes.
 * All selected fields must exist in the freshly fetched remote graph.
 */
export function buildRunningHubOverrides(rawValue, runtimeValue, cloudValue, { includeLiterals = false, workflowId = '' } = {}) {
  const raw = parseRunningHubGraph(rawValue, '本地模板');
  const runtime = parseRunningHubGraph(runtimeValue, '生成参数');
  const cloud = parseRunningHubGraph(cloudValue, '云端工作流');
  const fixed = enabled(includeLiterals);
  const result = [], problems = [];
  const problem = (id, field, reason) => problems.push(`${label(id)}${field ? '.' + label(field) : ''}: ${reason}`);
  for (const [id, node] of Object.entries(runtime)) {
    if (!own(raw, id)) { problem(id, '', '运行时新增节点，覆盖接口不能创建节点'); continue; }
    const original = raw[id], remote = own(cloud, id) ? cloud[id] : null;
    if (node.class_type !== original.class_type) { problem(id, '', '运行时修改了节点类型'); continue; }
    // In fixed mode every local node is intentional. Do not silently drop a LoRA.
    if (fixed && (!remote || remote.class_type !== node.class_type)) {
      problem(id, '', remote ? '云端节点类型不同' : '云端不存在该节点');
      continue;
    }
    for (const [field, value] of Object.entries(node.inputs)) {
      const originalValue = original.inputs[field];
      const wasLink = connection(originalValue, raw);
      const isLink = connection(value, runtime);
      if (wasLink || isLink) {
        if (!same(value, originalValue)) problem(id, field, '覆盖接口不能修改节点连线');
        else if (fixed && (!own(remote.inputs, field) || !same(value, remote.inputs[field]))) {
          problem(id, field, '本地与云端连线不同；必须在云端编辑并保存工作流');
        }
        continue;
      }
      const placeholder = typeof originalValue === 'string' && /%[^%]+%/.test(originalValue);
      const selected = fixed || placeholder || !same(value, originalValue) || !own(original.inputs, field);
      if (!selected) continue;
      if (!remote) { problem(id, field, '云端不存在该节点'); continue; }
      if (remote.class_type !== node.class_type) { problem(id, field, '相同编号在云端属于另一种节点类型'); continue; }
      if (!own(remote.inputs, field)) { problem(id, field, '云端节点不存在该输入字段'); continue; }
      if (connection(remote.inputs[field], cloud)) { problem(id, field, '云端字段是连线，不能用常量覆盖'); continue; }
      if (!jsonValue(value)) { problem(id, field, '值不是安全的 JSON 数据（或整数超出精确范围）'); continue; }
      if (remote.inputs[field] !== null && kind(value) !== kind(remote.inputs[field])) {
        problem(id, field, `字段类型不符，需要 ${kind(remote.inputs[field])}`);
        continue;
      }
      // Do not send unchanged static cloud defaults, but keep explicit runtime inputs.
      if (fixed && !placeholder && same(value, originalValue) && same(value, remote.inputs[field])) continue;
      result.push({ nodeId: String(id), fieldName: field, fieldValue: JSON.parse(JSON.stringify(value)) });
    }
  }
  if (problems.length) {
    fail('RH_WORKFLOW_MISMATCH', `工作流 ${label(workflowId)} 校验未通过，未创建生图任务。` +
      problems.slice(0, 8).join('；') + (problems.length > 8 ? `；另有 ${problems.length - 8} 项` : '') +
      '。请核对预设绑定的 Workflow ID，并从该云端工作流重新导出 API JSON；不要只改本地节点编号。');
  }
  return result;
}

/** No cache: validate the exact workflow/key used by the following run attempt. */
export async function prepareRunningHubNodeInfo({ rawJson, promptObj, workflowId, apiKey,
  includeLiterals = false, isTaskCancelled = () => false,
  fetchImpl = globalThis.fetch, timeoutMs = 20000 }) {
  if (isTaskCancelled()) throw cancelled();
  const id = typeof workflowId === 'string' ? workflowId.trim() : '';
  if (!/^\d+$/.test(id)) fail('RH_INVALID_ID', 'Workflow ID 必须是完整的数字字符串；未创建生图任务。');
  if (typeof apiKey !== 'string' || !apiKey.trim()) fail('RH_NO_KEY', '缺少 RunningHub API Key；未创建生图任务。');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail('RH_INVALID_TIMEOUT', '云端校验超时设置无效。');
  // Snapshot before awaiting network I/O; never mutate the user's saved preset.
  const raw = JSON.parse(JSON.stringify(parseRunningHubGraph(rawJson, '本地模板')));
  const runtime = promptObj;
  const controller = new AbortController();
  let timer, poll, stopError;
  const stop = new Promise((_, reject) => {
    const interrupt = error => {
      if (stopError) return;
      stopError = error;
      controller.abort();
      reject(error);
    };
    timer = setTimeout(() => interrupt(new RunningHubWorkflowError('RH_PREFLIGHT_TIMEOUT',
      '读取云端工作流超时；未创建生图任务。请检查网络后重试。')), timeoutMs);
    poll = setInterval(() => { if (isTaskCancelled()) interrupt(cancelled()); }, 100);
  });
  try {
    const request = (async () => {
      const response = await fetchImpl(`${ORIGIN}/api/openapi/getJsonApiFormat`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ apiKey, workflowId: id })
      });
      if (!response.ok) {
        const status = Number.isInteger(response.status) ? response.status : '未知';
        fail('RH_PREFLIGHT_HTTP', `读取云端工作流失败（HTTP ${status}）；未创建生图任务。请检查网络和当前 Key 的访问权限。`);
      }
      const data = await response.json();
      if (!data || (data.code !== 0 && data.code !== '0')) {
        fail('RH_PREFLIGHT_API', 'RunningHub 未允许读取该云端工作流；未创建生图任务。请检查当前 Key、Workflow ID 和工作流访问权限。');
      }
      return parseRunningHubGraph(data.data?.prompt, '云端返回值');
    })();
    const cloud = await Promise.race([request, stop]);
    if (isTaskCancelled()) throw cancelled();
    return buildRunningHubOverrides(raw, runtime, cloud, { includeLiterals, workflowId: id });
  } catch (error) {
    if (stopError) throw stopError;
    if (isTaskCancelled()) throw cancelled();
    if (error instanceof RunningHubWorkflowError) throw error;
    // Never log/forward raw transport errors or server bodies: they may echo the key.
    fail('RH_PREFLIGHT_NETWORK', '无法读取云端工作流（网络、跨域或响应格式异常）；未创建生图任务，也未退回未经校验的参数发送。');
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
    controller.abort();
  }
}

/** A single explicit, default-off control; no personal workflow data is embedded. */
export function bindRunningHubOverrideControl(modal, settings, saveSettings) {
  const root = modal?.[0] || modal;
  const tab = root?.querySelector?.('#ch-tab-runninghub');
  if (!tab) return;
  let input = tab.querySelector('[data-rh-fixed-inputs]');
  if (!input) {
    const section = tab.ownerDocument.createElement('div');
    section.className = 'st-chatu8-settings-section';
    section.innerHTML = '<h3 class="st-chatu8-section-title">云端参数校验</h3>' +
      '<label class="st-chatu8-field"><input type="checkbox" data-rh-fixed-inputs>发送本地工作流中的固定参数（图片与视频共用）</label>' +
      '<p>默认关闭，保留旧预设的占位符与运行时参数覆盖方式。开启后也发送固定模型、LoRA 权重等参数，并严格校验本地与云端节点及连线。此开关不创建节点、不修改云端工作流。校验读取失败时不会发起生成任务。</p>';
    tab.prepend(section);
    input = section.querySelector('[data-rh-fixed-inputs]');
  }
  input.checked = enabled(settings.runninghub_send_fixed_inputs);
  input.onchange = () => {
    settings.runninghub_send_fixed_inputs = input.checked;
    saveSettings();
  };
}
