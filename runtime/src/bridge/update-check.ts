export type BridgeUpdateStatus = "current" | "update_recommended" | "unsupported" | "unknown";

export interface BridgeVersionPolicy {
  readonly minimumSupportedVersion: string;
  readonly recommendedVersion: string;
  readonly latestVersion: string;
  readonly updateCommand: string;
  readonly releaseNotesUrl?: string;
  readonly policy?: string;
}

export interface BridgeUpdateCheck {
  readonly status: BridgeUpdateStatus;
  readonly currentVersion: string;
  readonly policy?: BridgeVersionPolicy;
  readonly message: string;
}

export interface CheckBridgeUpdateOptions {
  readonly baseUrl: string;
  readonly currentVersion: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_UPDATE_COMMAND = "npm install -g @aifight/aifight";

export async function checkBridgeUpdate(opts: CheckBridgeUpdateOptions): Promise<BridgeUpdateCheck> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(`${normalizeBaseUrl(opts.baseUrl)}/api/bridge/version`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!resp.ok) {
      return unknown(opts.currentVersion, `version check returned HTTP ${resp.status}`);
    }
    const raw = await resp.json().catch(() => undefined) as unknown;
    const policy = parseBridgeVersionPolicy(raw);
    if (policy === null) {
      return unknown(opts.currentVersion, "version check returned invalid policy");
    }
    return evaluatePolicy(opts.currentVersion, policy);
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    return unknown(opts.currentVersion, name === "AbortError" ? "version check timed out" : "version check unavailable");
  } finally {
    clearTimeout(timer);
  }
}

export function evaluatePolicy(currentVersion: string, policy: BridgeVersionPolicy): BridgeUpdateCheck {
  const minCmp = compareSemver(currentVersion, policy.minimumSupportedVersion);
  if (minCmp !== null && minCmp < 0) {
    return {
      status: "unsupported",
      currentVersion,
      policy,
      message: `Bridge ${currentVersion} is below the minimum supported version ${policy.minimumSupportedVersion}. Update before joining matches.`,
    };
  }

  const recommendedCmp = compareSemver(currentVersion, policy.recommendedVersion);
  if (recommendedCmp !== null && recommendedCmp < 0) {
    return {
      status: "update_recommended",
      currentVersion,
      policy,
      message: `Bridge ${currentVersion} works, but ${policy.recommendedVersion} is recommended.`,
    };
  }

  if (minCmp === null || recommendedCmp === null) {
    return {
      status: "unknown",
      currentVersion,
      policy,
      message: "Bridge version could not be compared with the platform policy.",
    };
  }

  return {
    status: "current",
    currentVersion,
    policy,
    message: `Bridge ${currentVersion} is current enough for AIFight.`,
  };
}

function unknown(currentVersion: string, message: string): BridgeUpdateCheck {
  return { status: "unknown", currentVersion, message };
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function parseBridgeVersionPolicy(raw: unknown): BridgeVersionPolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;
  const minimumSupportedVersion = root.minimum_supported_version;
  const recommendedVersion = root.recommended_version;
  const latestVersion = root.latest_version;
  if (
    typeof minimumSupportedVersion !== "string" ||
    typeof recommendedVersion !== "string" ||
    typeof latestVersion !== "string"
  ) {
    return null;
  }
  return {
    minimumSupportedVersion,
    recommendedVersion,
    latestVersion,
    updateCommand: typeof root.update_command === "string" && root.update_command.trim() !== ""
      ? root.update_command
      : DEFAULT_UPDATE_COMMAND,
    ...(typeof root.release_notes_url === "string" ? { releaseNotesUrl: root.release_notes_url } : {}),
    ...(typeof root.policy === "string" ? { policy: root.policy } : {}),
  };
}

interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

function compareSemver(a: string, b: string): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === null || pb === null) return null;
  for (const key of ["major", "minor", "patch"] as const) {
    if (pa[key] !== pb[key]) return pa[key] > pb[key] ? 1 : -1;
  }
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

function parseSemver(raw: string): ParsedSemver | null {
  const match = raw.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (match === null) return null;
  return {
    major: Number.parseInt(match[1]!, 10),
    minor: Number.parseInt(match[2]!, 10),
    patch: Number.parseInt(match[3]!, 10),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const av = a[i];
    const bv = b[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av) ? Number.parseInt(av, 10) : null;
    const bn = /^\d+$/.test(bv) ? Number.parseInt(bv, 10) : null;
    if (an !== null && bn !== null) return an > bn ? 1 : -1;
    if (an !== null) return -1;
    if (bn !== null) return 1;
    return av > bv ? 1 : -1;
  }
  return 0;
}
