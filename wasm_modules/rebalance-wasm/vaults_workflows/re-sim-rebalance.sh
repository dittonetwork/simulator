#!/usr/bin/env bash
# Read-only re-run of the YieldSplitVault rebalance simulation against LIVE mainnet,
# executed inside the runner's `simulator` pod (EKS ns `epsilon`). It mirrors what the
# runner's worker does — resolves the WASM optimizer from Mongo, runs it in the sandbox
# with live RPC, then eth_call-simulates executeRebalance from the KEEPER (AA wallet).
#
# NO writes, NO report submission, NO real transaction. Purely a simulation.
#
# Purpose: the WASM optimizer (instantaneous APY) and the on-chain ReturnEstimator
# (7-day timepoint window) diverge. As of 2026-06-15 the optimizer's proposed allocation
# was rated ~1.3% WORSE on-chain, so executeRebalance reverts at any positive gate and
# ONLY setMinRebalanceImprovementBps(0) would fire. The estimator's timepoint window was
# self-healing post-outage (~Jun 15-16); re-run this after a few days to see if the
# divergence narrows enough that a positive (real-guardrail) gate becomes viable.
#
# Usage: ./re-sim-rebalance.sh   (needs kube ctx = Delta-newprod-cluster)
set -euo pipefail
NS=epsilon
POD=$(kubectl get pods -n "$NS" -o name 2>/dev/null | grep -E '^pod/simulator-[a-z0-9]+-[a-z0-9]+$' | head -1 | cut -d/ -f2)
[ -n "$POD" ] || { echo "ABORT: no simulator pod in ns $NS (kube ctx = $(kubectl config current-context 2>/dev/null))"; exit 1; }
echo "ctx: $(kubectl config current-context)"
echo "pod: $POD"
echo "simulating (read-only)…"
kubectl exec -i "$POD" -n "$NS" -- sh -c 'cd /app && node -' <<'JS' | grep -vE '^\{"level"' || true
const { Database } = require('/app/dist/db.js');
const { getWorkflowSDKService } = require('/app/dist/integrations/workflowSDK.js');
const CID = 'Qmd3kt47g3hD5BmSNDN2Mzkn7PoYf9sYFSrzvHQbTf79h1'; // LIVE rebalance workflow (registered 2026-06-17, estimators[] payload, fixed WASM)
const br = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);
function errText(e) {
  if (!e) return '';
  const p = [];
  const push = v => { if (typeof v === 'string') p.push(v); };
  push(e.shortMessage); push(e.details); push(e.message);
  if (e.cause) { push(e.cause.details); push(e.cause.shortMessage); push(e.cause.message); }
  if (Array.isArray(e.metaMessages)) p.push(e.metaMessages.join(' '));
  return p.join(' || ');
}
(async () => {
  const db = new Database(); await db.connect();
  const sdk = getWorkflowSDKService(undefined, db);
  let token;
  try { const { reportingClient } = require('/app/dist/reportingClient.js'); await reportingClient.initialize(); token = reportingClient.getAccessToken() || undefined; } catch {}
  const wf = await sdk.loadWorkflowData(CID);
  let result, err;
  try { result = await sdk.simulateWorkflow(wf, CID, process.env.IS_PROD === 'true', process.env.IPFS_SERVICE_URL || '', token); }
  catch (e) { err = e; }

  let text = errText(err);
  if (result) { try { text += ' ' + JSON.stringify(result, br); } catch {} }

  console.log('\n========== REBALANCE SIM VERDICT (' + new Date().toISOString() + ') ==========');
  const m = text.match(/0x5e69b324([0-9a-fA-F]{192})/); // InsufficientReturnImprovement(uint256,uint256,uint16)
  if (result && result.success) {
    console.log('RESULT: executeRebalance simulation SUCCEEDS — a rebalance WOULD fire now.');
    const refs = (result.wasmRefContext && result.wasmRefContext.resolvedRefs) || [];
    for (const r of refs) console.log('proposed weights (WASM):', JSON.stringify(r.value ?? r, br));
  } else if (m) {
    const [cur, prop, min] = m[1].match(/.{64}/g).map(h => parseInt(h, 16));
    const impr = ((prop - cur) / cur) * 100;
    console.log(`GATE HIT: InsufficientReturnImprovement(current=${cur}, proposed=${prop}, minBps=${min})`);
    console.log(`optimizer proposal vs standing pat: ${impr.toFixed(2)}% (proposed is ${prop > cur ? 'BETTER' : 'WORSE'})`);
    if (prop > cur) {
      const be = Math.floor((prop / cur - 1) * 1e4);
      console.log(`=> would PASS any gate <= ${be} bps (${(be / 100).toFixed(2)}%). DIVERGENCE NARROWED — a positive gate is now viable.`);
    } else {
      console.log('=> proposed still WORSE on-chain → only setMinRebalanceImprovementBps(0) fires. Divergence persists; wait/recheck or reconcile.');
    }
  } else {
    console.log('UNEXPECTED outcome. success=', result && result.success);
    console.log((text || '(no error text)').slice(0, 1000));
  }
  console.log('========================================================\n');
  try { await db.disconnect?.(); } catch {}
  process.exit(0);
})().catch(e => { console.error('FATAL:', e && (e.stack || e.message)); process.exit(1); });
JS
