import { readBridgeConfig } from "../../bridge/config";
import type { BridgeConfig } from "../../bridge/config";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, expectArity } from "../shared";

const USAGE = [
  "usage: aifight accept-terms [--yes]",
  "  Review and accept updated Terms of Service / Privacy Policy from the CLI —",
  "  no browser needed — so your agent stays active. The current documents are",
  "  printed with links to read them in full before you agree.",
  "  --yes accepts non-interactively (use only after reading the linked documents).",
].join("\n");

const STATUS_TIMEOUT_MS = 4000;

interface LegalStatus {
  readonly isClaimed: boolean;
  readonly termsPending: boolean;
  readonly currentTermsVersion: string;
  readonly currentPrivacyVersion: string;
}

export async function runAcceptTerms(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  expectArity(args, 0, 0, USAGE);

  let config: BridgeConfig;
  try {
    config = readBridgeConfig();
  } catch {
    throw new CommandError("not_configured", "AIFight is not configured on this machine.", {
      hint: "Run `aifight setup` for a new agent, or `aifight connect <PAIRING_CODE>` for an existing one.",
    });
  }

  const base = config.baseUrl.replace(/\/+$/, "");
  const status = await fetchLegalStatus(config, base, env.fetchImpl);
  if (status === null) {
    throw new CommandError("status_unavailable", "Could not reach AIFight to check your Terms status.", {
      hint: "Check your connection and try again.",
    });
  }
  if (!status.isClaimed) {
    throw new CommandError("not_claimed", "Claim this agent before accepting the Terms.", {
      hint: "Run `aifight status` to find your claim link.",
    });
  }

  const termsUrl = `${base}/terms`;
  const privacyUrl = `${base}/privacy`;

  if (!status.termsPending) {
    if (args.jsonMode) {
      env.stdout(JSON.stringify({ status: "already_accepted" }) + "\n");
    } else {
      env.stdout("You have already accepted the current Terms and Privacy Policy. Nothing to do.\n");
    }
    return 0;
  }

  // Always surface WHICH documents changed + WHERE to read them in full, so the
  // user can review the new text before agreeing — never "agree blind".
  if (!args.jsonMode) {
    env.stdout("Updated legal documents need your acceptance to keep your agent active:\n\n");
    env.stdout(`  Terms of Service  (version ${status.currentTermsVersion})\n    ${termsUrl}\n`);
    env.stdout(`  Privacy Policy    (version ${status.currentPrivacyVersion})\n    ${privacyUrl}\n\n`);
    env.stdout("Please open and read both before accepting.\n");
  }

  if (args.flags.yes !== true) {
    if (!process.stdin.isTTY) {
      if (args.jsonMode) {
        throw new CommandError("confirmation_required", "Accepting the Terms requires confirmation.", {
          hint: `Read ${termsUrl} and ${privacyUrl}, then run \`aifight accept-terms --yes\`.`,
        });
      }
      env.stderr("aifight: accepting the Terms requires confirmation in non-interactive mode.\n");
      env.stderr("Run `aifight accept-terms --yes` after reading the linked documents.\n");
      return 1;
    }
    const accepted = await promptYesNoDefaultNo(env, "I have read both documents and I agree. Accept now? [y/N] ");
    if (!accepted) {
      env.stdout("Not accepted. Your agent stays inactive on the platform until you accept.\n");
      return 0;
    }
  }

  const ok = await postAcceptLegal(config, base, status, env.fetchImpl);
  if (!ok) {
    throw new CommandError("accept_failed", "Failed to record your acceptance.", {
      hint: `You can also accept in the browser: ${base}/dashboard`,
    });
  }

  if (args.jsonMode) {
    env.stdout(JSON.stringify({
      status: "accepted",
      terms_version: status.currentTermsVersion,
      privacy_version: status.currentPrivacyVersion,
    }) + "\n");
  } else {
    env.stdout("\nThank you — your acceptance is recorded. Your agent stays active.\n");
  }
  return 0;
}

/** GET /api/agents/me/status → claim + Terms-pending state and current versions. */
async function fetchLegalStatus(
  config: BridgeConfig,
  base: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<LegalStatus | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${base}/api/agents/me/status`, {
      method: "GET",
      headers: { "X-API-Key": config.apiKey },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const raw = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.current_terms_version !== "string" || typeof raw.current_privacy_version !== "string") {
      return null;
    }
    return {
      isClaimed: raw.is_claimed === true,
      termsPending: raw.terms_pending === true,
      currentTermsVersion: raw.current_terms_version,
      currentPrivacyVersion: raw.current_privacy_version,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** POST /api/agents/me/accept-legal — records the owner's acceptance via the bridge key. */
async function postAcceptLegal(
  config: BridgeConfig,
  base: string,
  status: LegalStatus,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${base}/api/agents/me/accept-legal`, {
      method: "POST",
      headers: { "X-API-Key": config.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        terms_version: status.currentTermsVersion,
        privacy_version: status.currentPrivacyVersion,
      }),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function promptYesNoDefaultNo(env: HandlerEnv, question: string): Promise<boolean> {
  env.stdout(question);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  const answer = await new Promise<string>((resolve) => {
    process.stdin.once("data", (chunk) => resolve(String(chunk)));
  });
  process.stdin.pause();
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}
