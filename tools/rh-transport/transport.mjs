/*
 * RunningHub full-workflow transport, 2026-09-19.
 * Modification to st-chatu8; same AFPL v9 license as the parent project.
 * Existing presets retain the upstream V2 parameter-only behavior.
 * Opt in inside the API graph (not the outer preset envelope):
 * _meta.st_chatu8_runninghub = { version: 1, mode: "local" }
 * No credentials, model choices or personal presets are stored in this module.
 */
export function rhTransportConfig(rawJson) {
  const raw = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
  const config = raw?._meta?.st_chatu8_runninghub;
  if (config == null) return { mode: "cloud" };
  if (config.version !== 1 || !["local", "cloud"].includes(config.mode)) {
    throw new Error("[RunningHub] 无效的 st_chatu8_runninghub 配置；需要 version: 1 和 mode: local/cloud。");
  }
  return { mode: config.mode };
}

export function rhPrepareLocalGraph(rawJson, promptObj) {
  const raw = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
  if (!promptObj || typeof promptObj !== "object" || Array.isArray(promptObj)) {
    throw new Error("[RunningHub local] 需要 ComfyUI API 格式节点图。");
  }
  const graph = {};
  const seeds = [];
  for (const [id, node] of Object.entries(promptObj)) {
    if (id === "_meta") continue; // Client transport metadata must never become a ComfyUI node.
    if (!/^\d+$/.test(id) || !node || typeof node.class_type !== "string" || !node.class_type.trim() ||
        !node.inputs || typeof node.inputs !== "object" || Array.isArray(node.inputs)) {
      throw new Error(`[RunningHub local] 节点 ${id} 不是有效的 API 节点；请勿导入 UI/画布格式。`);
    }
    if (node.mode != null && Number(node.mode) !== 0) {
      throw new Error(`[RunningHub local] 节点 ${id} 使用静音/旁路 mode=${node.mode}；请先导出已展开旁路的 API 图。未提交任务。`);
    }
    // Copy, never mutate the user's saved preset or the builder's graph.
    graph[id] = { class_type: node.class_type, inputs: JSON.parse(JSON.stringify(node.inputs)) };
    if (node._meta && typeof node._meta === "object") graph[id]._meta = node._meta;
    for (const [field, value] of Object.entries(node.inputs)) {
      const original = raw?.[id]?.inputs?.[field];
      if (typeof original === "string" && typeof value === "string") {
        for (const placeholder of original.match(/%[^%\r\n]+%/g) || []) {
          if (value.includes(placeholder)) throw new Error(`[RunningHub local] ${id}.${field} 的占位符 ${placeholder} 尚未替换。未提交任务。`);
        }
      }
      if (/^(seed|noise_seed)$/.test(field) && !Array.isArray(value)) {
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new Error(`[RunningHub local] ${id}.${field} 必须是非负安全整数。`);
        }
        // RunningHub may reset seeds unless they are explicitly overridden.
        seeds.push({ nodeId: id, fieldName: field, fieldValue: value });
      }
    }
  }
  if (!Object.keys(graph).length) throw new Error("[RunningHub local] 工作流为空。未提交任务。");
  for (const [id, node] of Object.entries(graph)) {
    for (const [field, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && value.length === 2 &&
          (typeof value[0] === "string" || typeof value[0] === "number") && Number.isInteger(value[1])) {
        if (!Object.hasOwn(graph, String(value[0])) || value[1] < 0) {
          throw new Error(`[RunningHub local] 无效连线 ${id}.${field} -> ${value[0]}:${value[1]}。未提交任务。`);
        }
      }
    }
  }
  return { graph, seeds };
}

function rhSafeError(data, apiKey, fallback) {
  const detail = data?.data?.failedReason || data?.failedReason;
  const parts = [data?.errorMessage || data?.msg || fallback];
  if (detail?.node_id || detail?.node_name) parts.push(`节点 ${detail.node_id || detail.node_name}`);
  if (detail?.exception_message) parts.push(detail.exception_message);
  if (data?.data?.promptTips) parts.push(String(data.data.promptTips));
  return parts.filter(Boolean).join(" | ").split(apiKey || "\u0000").join("[REDACTED]");
}

async function rhFetchJson(url, body, apiKey, signal, fetchImpl) {
  signal?.throwIfAborted?.();
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {})
    });
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw error;
    // Never retry a create request here: it may already have created a paid task.
    throw new Error("[RunningHub] 请求中断；没有自动重发。请先查看 RunningHub 任务记录，避免重复计费。");
  }
  let data;
  try { data = await response.json(); }
  catch (_) { throw new Error(`[RunningHub] HTTP ${response.status} 返回非 JSON；没有自动重发。`); }
  if (!response.ok) {
    throw new Error(`[RunningHub] HTTP ${response.status}: ${rhSafeError(data, apiKey, "请求失败")}`);
  }
  if (!data || typeof data !== "object") throw new Error("[RunningHub] 接口返回格式无效。没有自动重发。");
  return data;
}

export async function rhCreateTask({ rawJson, promptObj, workflowId, apiKey, payload, signal, log = () => {}, fetchImpl = globalThis.fetch }) {
  const { mode } = rhTransportConfig(rawJson);
  if (mode === "cloud") {
    return rhFetchJson(`https://www.runninghub.ai/openapi/v2/run/workflow/${workflowId}`, payload, apiKey, signal, fetchImpl);
  }
  const { graph, seeds } = rhPrepareLocalGraph(rawJson, promptObj);
  const body = { apiKey, workflowId: String(workflowId), workflow: JSON.stringify(graph), nodeInfoList: seeds };
  for (const key of ["addMetadata", "instanceType", "usePersonalQueue", "retainSeconds"]) {
    if (payload[key] !== undefined) body[key] = payload[key];
  }
  log(`[RunningHub local] 提交完整 API 图：${Object.keys(graph).length} 个节点，${seeds.length} 个显式种子。固定模型、LoRA、权重、步数和连线均包含在 workflow 中；不向旧云端图套用本地节点覆盖。`);
  const data = await rhFetchJson("https://www.runninghub.ai/task/openapi/create", body, apiKey, signal, fetchImpl);
  if (Number(data.code) !== 0 || !data.data?.taskId) {
    return { code: data.code ?? -1, errorCode: data.code ?? -1,
      errorMessage: rhSafeError(data, apiKey, "本地完整工作流创建失败；未退回旧云端图") };
  }
  const taskId = data.data.taskId;
  if (typeof taskId === "number" && !Number.isSafeInteger(taskId)) {
    throw new Error("[RunningHub local] 已创建任务，但服务器以不安全数字返回 taskId；请在站内查任务。没有重发。");
  }
  if (data.data.taskStatus === "FAILED") {
    return { code: 805, errorCode: 805, errorMessage: rhSafeError(data, apiKey, "工作流创建后校验失败") };
  }
  return { taskId: String(taskId), status: data.data.taskStatus, promptTips: data.data.promptTips };
}

export async function rhQueryTask({ rawJson, apiKey, taskId, signal, fetchImpl = globalThis.fetch }) {
  if (rhTransportConfig(rawJson).mode === "cloud") {
    return rhFetchJson("https://www.runninghub.ai/openapi/v2/query", { taskId }, apiKey, signal, fetchImpl);
  }
  const data = await rhFetchJson("https://www.runninghub.ai/task/openapi/outputs", { apiKey, taskId }, apiKey, signal, fetchImpl);
  const code = Number(data.code);
  if (code === 804) return { status: "RUNNING" };
  if (code === 813) return { status: "QUEUED" };
  if (code !== 0) return { status: "FAILED", errorCode: data.code,
    errorMessage: `[${data.code}] ${rhSafeError(data, apiKey, "查询任务失败")}` };
  if (!Array.isArray(data.data) || data.data.length === 0 || data.data.some(item => !item || typeof item.fileUrl !== "string" || !item.fileUrl)) {
    return { status: "FAILED", errorMessage: "[RunningHub local] 任务返回成功但缺少有效输出文件；没有自动重新生成。" };
  }
  const first = data.data[0];
  return { status: "SUCCESS", results: data.data.map(item => ({ url: item.fileUrl, outputType: item.fileType, nodeId: item.nodeId })),
    taskCostTime: first.taskCostTime ?? data.taskCostTime ?? null,
    consumeCoins: first.consumeCoins ?? data.consumeCoins ?? null };
}
