// Central server/CLI error → friendly, localized message. A zh user should never
// see a raw English string or a bare "failed"; every call site that surfaces an
// error routes through here. Known categories (the claim/name gate, auth, rate
// limit, offline bridge, …) map to actionable copy; everything else falls back to
// a localized generic, or the call site's category default when it knows the op.
//
// Uses the i18n singleton (not a component `t`) so it works in plain helpers
// (useBridge) as well as inside render; the message is resolved at call time in
// the current language. Errors are transient — freezing the string at throw time
// is fine (the user isn't switching languages mid-error).

import i18n from "./i18n";

/** A call site's operation, used as the fallback when the raw text carries no
 *  recognizable signal — so e.g. a key-save failure still reads "couldn't save
 *  the key" rather than a bare generic. */
export type ErrorCategory =
  | "challengeCreate"
  | "challengeAccept"
  | "matchRequest"
  | "save"
  | "keySave"
  | "delete"
  | "policy"
  | "avatarSet"
  | "avatarClear"
  | "avatarUpload"
  | "loadMatches";

/** True when the error is the server's "claim + set an official name first" gate
 *  (auth.go ClaimRequiredForPlayMessage). Lets a call site offer a claim button
 *  right at the point of failure (D4) instead of leaving the user with a cryptic
 *  message. */
export function isClaimNameError(raw?: string | null): boolean {
  const s = (raw ?? "").toLowerCase();
  return /must be claimed|official name|claim_url|claim the agent/.test(s) || /认领|正式名字/.test(s);
}

export function localizeServerError(raw?: string | null, category?: ErrorCategory): string {
  const t = i18n.t.bind(i18n);
  const s = (raw ?? "").toLowerCase().trim();

  // Cross-cutting categories recognized from the message itself (call-site
  // agnostic). Order matters: the claim/name gate is the most actionable, so it
  // wins even when the text also carries a wrapper code like challenge_create_failed.
  if (isClaimNameError(s)) return t("errors.needClaim");
  if (/challenge_create_failed/.test(s)) return t("errors.challengeCreate");
  if (/challenge_accept_failed/.test(s)) return t("errors.challengeAccept");
  if (/\b401\b|unauthor|invalid pairing|pairing code|pairing_failed|invalid api[_ ]?key|授权|配对码/.test(s))
    return t("errors.auth");
  if (/\b429\b|rate[ _-]?limit|too many requests/.test(s)) return t("errors.rateLimit");
  if (/bridge unavailable|not configured|run inside the app|未就绪/.test(s)) return t("errors.offline");

  // No recognizable signal → the call site's default (actionable), else a
  // localized generic. Never leak the raw English string to the user.
  if (category !== undefined) return t(`errors.${category}`);
  return t("errors.generic");
}
