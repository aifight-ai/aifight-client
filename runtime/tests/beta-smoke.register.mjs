#!/usr/bin/env node
// runtime/tests/beta-smoke.register.mjs
//
// ⚠️  MANUAL SMOKE TEST — NOT run in CI, NOT run by build.sh.
//
// ⚠️  SIDE EFFECT: each execution CREATES A REAL PRIVATE BOOTSTRAP
//     identity on beta.aifight.ai. One run = one persistent row in the
//     beta DB. The suggested name embeds Date.now() so runs don't
//     collide, but the rows do accumulate. Roy understands this trade-off; don't
//     expand the script's blast radius without re-consenting.
//
// ⚠️  PROD IS EXPLICITLY BLOCKED. The target base URL is hard-coded
//     to beta.aifight.ai. There is no env var, CLI flag, or config
//     file that can point this script at https://aifight.ai or any
//     other host. If you are changing this to hit a different server,
//     stop — that is M5 private-beta / M6 public-launch work, not
//     M1-03. See ADR-007/009.
//
// OUTPUT: prints JSON with api_key_prefix / claim_token_prefix only.
//     Full api_key and claim_token are NEVER printed. 6-char prefix
//     with length is enough to eyeball "looks like a real value"
//     without leaking the secret into terminal scrollback.
//
// PREREQUISITE: `cd runtime && ./build.sh` must have run, because this
//     script imports from dist/index.mjs (not src/, to avoid the
//     --experimental-strip-types flag).
//
// USAGE:
//   cd runtime && ./build.sh && node tests/beta-smoke.register.mjs

import { registerAgent } from "../dist/index.mjs";

// DO NOT CHANGE. Single source of truth for the beta-only target.
const ALLOWED_BASE_URL = "https://beta.aifight.ai";

const name = `m1-03-smoke-${Date.now()}`;
console.log(`[beta-smoke] target: ${ALLOWED_BASE_URL}`);
console.log(`[beta-smoke] registering suggested name: ${name}`);
console.log(`[beta-smoke] WARNING: this creates a real private bootstrap identity on beta.`);

const result = await registerAgent({
  baseUrl: ALLOWED_BASE_URL,
  request: { name },
});

function prefix(s, n = 6) {
  if (typeof s !== "string" || s.length === 0) return "<empty>";
  return s.slice(0, n) + "…";
}

// Redact the full claim_token that normally appears at the end of
// claim_url. We still want to eyeball "URL shape looks right" without
// leaking the secret into terminal scrollback.
function redactClaimUrl(url, token) {
  if (typeof url !== "string" || typeof token !== "string") return "<invalid>";
  const idx = url.indexOf(token);
  if (idx === -1) return url; // Token not found; nothing to redact.
  return url.slice(0, idx) + prefix(token);
}

const report = {
  ok: true,
  agent_id: result.agentId,
  name: result.response.agent.name,
  public_no: result.response.agent.public_no,
  identity_status: result.response.agent.identity_status,
  auto_confirm: result.response.agent.auto_confirm,
  api_key_prefix: prefix(result.apiKey),
  api_key_length: result.apiKey.length,
  claim_token_prefix: prefix(result.claimToken),
  claim_token_length: result.claimToken.length,
  claim_url_redacted: redactClaimUrl(result.claimUrl, result.claimToken),
};

console.log(JSON.stringify(report, null, 2));
