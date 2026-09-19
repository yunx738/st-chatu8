# RunningHub: explicit full-workflow transport

Modified by ChatGPT (OpenAI), 2026-09-19. Same AFPL v9 license as st-chatu8; see LICENSE.

## Root cause

The upstream `extractNodeInfoListFromWorkflow` compares a local template with its locally substituted copy. Constant model/LoRA names, weights and sampler settings do not differ and are omitted. The V2 API then executes the saved cloud workflow with only the extracted overrides. Local topology and node-class changes are not represented by this protocol either.

Sending every constant as a node override is not a safe substitute: the local node IDs may not exist in the selected cloud workflow.

## Behavior

Old presets keep the upstream V2 workflow-ID + nodeInfoList request. The change does NOT silently reinterpret all saved presets.

An API-format graph can explicitly opt into full local graph submission by including this root metadata inside `workflow`, not alongside the outer preset's `name` and `workflowId`:

```json
"_meta": {
  "st_chatu8_runninghub": { "version": 1, "mode": "local" }
}
```

The extension then sends the complete resolved graph as a `workflow` JSON string to `https://www.runninghub.ai/task/openapi/create`. Computation still runs on RunningHub, not on the user's phone or computer. According to the advanced-create documentation, supplying `workflow` ignores `workflowId` for graph selection. A configured workflowId remains required by the existing settings UI.

Client root metadata is stripped. Node input values, node classes and connections are preserved. Seed and noise_seed inputs are also sent explicitly in nodeInfoList because RunningHub documents that unlisted seeds can be reset.

Legacy create responses and `/task/openapi/outputs` results are normalized to the shape expected by the existing image, reference-video and direct-test paths. Codes 804 and 813 mean running and queued. Failures remain failures. There is no fallback to an old cloud graph and no retry of an ambiguous network failure. The original explicit queue-full retry behavior remains.

## Validation and limits

There are 29 offline regression tests, using synthetic model names and no real API credentials. They reproduce the original omission, check the full serialized request, old V2 compatibility, zero weights/seeds, graph validation, all three patched call sites, status/output normalization, error reporting and AbortSignal forwarding. The complete generated JavaScript bundle passes `node --check`.

These tests do not prove that a particular account can load a specific cloud model, that the provider currently accepts a particular graph, or that a generated image will achieve a chosen style. No account-level inference run was performed as part of this patch.

Full local mode currently requires numeric API node IDs and resolved inputs. Frontend `mode: 2/4` mute/bypass metadata is rejected rather than pretending that it has been compiled into the graph; export an API graph with bypasses already resolved. Invalid links and unresolved placeholders fail before task creation. The server remains responsible for complete node schema and model-availability validation.

No personal prompt, style preset, model selection, credential or user configuration is included in this repository change.

## Reproduce the reviewed build

The reviewed upstream base is `4e1e8f8a6cab1375d39eb806a292516dbb9c43be`.

```sh
git show 4e1e8f8a6cab1375d39eb806a292516dbb9c43be:index.js > index.upstream.js
node --test tools/rh-transport/test.mjs
cp index.upstream.js index.candidate.js
node tools/rh-transport/apply.mjs index.candidate.js
cp index.candidate.js /tmp/index-check.mjs
node --check /tmp/index-check.mjs
```

The patcher refuses already patched bundles and unexpected call-site layouts. It is not an automatic updater for future upstream versions. The build workflow publishes only to the isolated repair branch and does not modify main or the upstream repository.

## Primary API references

- Advanced create: https://www.runninghub.cn/runninghub-api-doc-cn/api-425749013
- nodeInfoList: https://pre.runninghub.ai/runninghub-api-doc-en/doc-8287464
- Outputs: https://www.runninghub.cn/runninghub-api-doc-cn/api-425749004
- Error codes: https://www.runninghub.cn/runninghub-api-doc-cn/doc-8287338
- Running/queued/failure polling example: https://www.runninghub.cn/runninghub-api-doc-cn/doc-8287340
