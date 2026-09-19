const fs = require('node:fs');
const assert = require('node:assert/strict');
let source = fs.readFileSync('index.js', 'utf8');
function once(old, replacement) {
  assert.equal(source.split(old).length, 2, 'Anchor must occur exactly once: ' + old);
  source = source.replace(old, replacement);
}
assert.ok(!source.includes('runninghub-workflow.mjs'), 'Patch already applied');
const a = source.indexOf('function extractNodeInfoListFromWorkflow(');
const b = source.indexOf('\nasync function generateRunningHubImage(', a);
assert.ok(a > 0 && b > a, 'Upstream extraction function missing');
const old = source.slice(a, b);
assert.ok(old.includes('if (isPlaceholder || isDifferent || rawVal === void 0) {'), 'Unexpected upstream filter');
source = source.slice(0, a) + source.slice(b + 1);
for (const [template, id] of [['rawJson', 'workflowId'], ['targetWorkerJson', 'targetWorkflowId']]) {
  once(`const nodeInfoList = extractNodeInfoListFromWorkflow(${template}, promptObj);`,
    `const nodeInfoList = await prepareRunningHubNodeInfo({\n` +
    `        rawJson: ${template}, promptObj, workflowId: ${id}, apiKey,\n` +
    `        includeLiterals: settings3.runninghub_send_fixed_inputs,\n` +
    `        isTaskCancelled: () => !taskQueue.isTaskInQueue(taskId)\n` +
    `      });`);
}
once('function initRunningHubUI(settingsModal) {\n  const settings3 = extension_settings80[extensionName];',
  'function initRunningHubUI(settingsModal) {\n  const settings3 = extension_settings80[extensionName];\n' +
  '  bindRunningHubOverrideControl(settingsModal, settings3, saveSettingsDebounced53);');
source = 'import { prepareRunningHubNodeInfo, bindRunningHubOverrideControl } from "./runninghub-workflow.mjs";\n' + source;
assert.equal((source.match(/const nodeInfoList = await prepareRunningHubNodeInfo\(/g) || []).length, 2);
fs.writeFileSync('index.js', source, 'utf8');
console.log('Patched both RunningHub callers and settings UI; no workflows or personal settings modified.');
