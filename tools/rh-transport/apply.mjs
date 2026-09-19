// AFPL v9. Applies only the reviewed upstream call sites; unknown layouts fail closed.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const MARK = '// ST-CHATU8-RH-FULL-WORKFLOW-TRANSPORT v1';
export function applyPatch(source) {
  if (source.includes(MARK)) throw new Error('Already patched; use the original index.js, not a second patch layer.');
  let creates = 0;
  let queries = 0;
  const createPattern = /const createRes = await fetch\(`https:\/\/www\.runninghub\.ai\/openapi\/v2\/run\/workflow\/\$\{(workflowId|targetWorkflowId)\}`, \{[\s\S]*?\n\s*\}\);\n\s*const createData = await createRes\.json\(\);/g;
  source = source.replace(createPattern, (old, id) => {
    const direct = old.includes('signal: abortSignal');
    const raw = direct ? 'workflowJson' : id === 'targetWorkflowId' ? 'targetWorkerJson' : 'rawJson';
    creates++;
    return `const createData = await rhCreateTask({ rawJson: ${raw}, promptObj, workflowId: ${id}, apiKey, payload, log: addLog${direct ? ', signal: abortSignal' : ''} });`;
  });
  const queryPattern = /const statRes = await fetch\("https:\/\/www\.runninghub\.ai\/openapi\/v2\/query", \{[\s\S]*?\n\s*\}\);\n\s*const statData = await statRes\.json\(\);/g;
  const rawNames = ['rawJson', 'targetWorkerJson', 'workflowJson'];
  source = source.replace(queryPattern, (old) => {
    const direct = old.includes('signal: abortSignal');
    const raw = rawNames[queries++];
    return `const statData = await rhQueryTask({ rawJson: ${raw}, apiKey, taskId: ${direct ? 'taskId' : 'runTaskId'}${direct ? ', signal: abortSignal' : ''} });`;
  });
  if (creates !== 3 || queries !== 3) throw new Error(`Unsupported source: expected 3 create + 3 query call sites, got ${creates}/${queries}. No file written.`);
  const anchor = 'function extractNodeInfoListFromWorkflow(rawJson, promptObj) {';
  if (source.split(anchor).length !== 2) throw new Error('Unsupported source: extractor anchor not unique.');
  const helper = fs.readFileSync(new URL('./transport.mjs', import.meta.url), 'utf8').replace(/^export /gm, '');
  const notice = '/* Modified by ChatGPT (OpenAI), 2026-09-19.\n * Purpose: opt-in RunningHub full API workflow transport and response compatibility.\n * Original st-chatu8 authorship and AFPL v9 license are retained; see LICENSE.\n */\n';
  return notice + source.replace(anchor, MARK + '\n' + helper + '\n' + anchor);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: node apply.mjs path/to/index.js');
  const result = applyPatch(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, result);
  console.log('Patched: three request paths + three result paths; V2 presets remain default.');
}
