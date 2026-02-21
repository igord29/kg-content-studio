# Agentuity Support: Deployments fail at "provision ready" with no runtime logs

## Project Info
- **Project ID:** proj_87c385afd83e4df1039fa86eb81027cc
- **Org ID:** org_38NLLzvPDBZmThuAudGCJ7iyk9Z
- **CLI Version:** 1.0.4
- **Runtime Version:** @agentuity/runtime 1.0.4
- **Platform:** Windows (win32, x64)
- **Bun Version:** 1.3.8
- **Region:** use

## Problem

All new deployments fail at the "Provision Deployment" step with the error:
```
deployment failed: provision ready
```

No runtime logs are captured — `agentuity cloud deployment logs <id>` returns "No logs found for this deployment." The container appears to crash instantly before producing any output.

## Key Details

- The **last working deployment** was `deploy_7ee5d38e75dd7fc99e048b068f508982` on **Feb 7, 2026** — it is still active and running fine.
- **Every deployment since then has failed** (8+ attempts), all with the same "provision ready" error.
- The **same code** (commit `9656d12`) that works in the active deployment fails when redeployed.
- The app **starts successfully locally** with `bun .agentuity/app.js` — it logs `Server listening on http://127.0.0.1:3500` with no errors.
- The build pipeline completes successfully: typecheck passes, client and server build, security scan passes, assets upload to CDN, encryption succeeds. Only "Provision Deployment" fails.

## Failed Deployment IDs (with trace IDs)

| Deployment ID | Trace ID | Date |
|---|---|---|
| deploy_c1875c408977e82b44219a2ecbf710cc | 7fb0f9621ee5263265bb14f15ced0487 | Feb 9, ~5:05 PM |
| deploy_7a104d4f476023058a9464226f28f8be | fdd8cbe3a6145139e0ed04e638e99f1a | Feb 9, ~4:52 PM |
| deploy_faf2186964bb544a04cc09123262a1d1 | 546850369b37213ea28a2d9ccfb6ffdf | Feb 9, 7:03 AM |
| deploy_0bbac2093133bda62d4bfc2dfa7c570f | (build failed - separate Windows path issue) | Feb 9 |

## What Changed Between Working and Broken

**Nothing in the code.** The working deployment (Feb 7) and the failing deployments (Feb 9) use the same commit. The only difference is time — something may have changed on the platform side between Feb 7 and Feb 9.

Resource config was increased from 500Mi to 1Gi memory during debugging, but both values fail.

## Separate Windows-Specific CLI Bugs (for awareness)

While debugging, we also found two Windows CLI bugs that are separate from the provision failure:

### Bug 1: registry.ts gets broken backslash import paths
When the CLI regenerates `src/generated/registry.ts` on Windows, it writes import paths with backslashes:
```typescript
import contentCreator from 'src\agent\content-creator\index.ts';
```
In JavaScript strings, `\a`, `\c`, `\t`, `\v` etc. are interpreted as escape sequences. This causes the Vite bundler to fail with errors like:
```
Could not resolve "srcagentcontent-creatorindex.ts"
Could not resolve "srcagent	ranslateindex.ts"  // \t = tab
Could not resolve "srcagentenue-prospectorindex.ts"  // \v = vertical tab
```
**Workaround:** We use a file watcher script (`fix-registry-paths.js`) that detects and fixes these paths in real-time during build.

### Bug 2: production.yaml gets broken backslash paths
The CLI rewrites `~/.config/agentuity/production.yaml` on every deploy with:
```yaml
project_dir: "C:\Development_Folder\V1_Agentuity\social-media-agent1"
```
In YAML double-quoted strings, backslashes are escape characters, causing a parse error on the next CLI invocation. The CLI then reports "Error loading config" and "You are not currently logged in."

**Workaround:** Manually fix the file after each deploy (use forward slashes or unquoted strings).

## Questions for Agentuity Team

1. Can you check the platform-side logs for why "provision ready" fails for project `proj_87c385afd83e4df1039fa86eb81027cc`? Is the container OOM-killed, timing out, or hitting another error?
2. Has anything changed on the platform between Feb 7 and Feb 9 that could affect container provisioning?
3. Are there known issues with Windows CLI path handling in v1.0.4?
