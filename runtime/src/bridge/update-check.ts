// Bridge/CLI version check — where "is there an update?" is decided.
//
// "Latest" means the npm registry (owner decision 2026-07-30: "CLI更新不问服务
// 端，直接问npm registry最新版" — the CLI asks npm for the newest release, not
// the server). The AIFight server still supplies the hard FLOOR
// (minimum_supported_version — below it the bridge must update before joining
// matches), and the server policy remains the fallback source of truth when
// the registry is unreachable:
//
//   npm ok   + server ok   → latest = npm, floor = server minimum
//   npm FAIL + server ok   → degrade to the old behavior (server recommended)
//   npm ok   + server FAIL → compare against npm only; NEVER "unsupported"
//                            (the floor cannot be verified without the server)
//   both FAIL              → "unknown", as before

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
  /** The server policy, whenever the server arm answered (any status). */
  readonly policy?: BridgeVersionPolicy;
  /** The version treated as "latest" for update decisions, when any source
   *  answered: the npm registry's latest (preferred), else the server
   *  policy's recommended_version (fallback). */
  readonly latestVersion?: string;
  /** Which source `latestVersion` came from. */
  readonly latestSource?: "npm" | "server";
  readonly message: string;
}

export interface CheckBridgeUpdateOptions {
  readonly baseUrl: string;
  readonly currentVersion: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Override for the npm registry endpoint (tests, mirrors). */
  readonly registryUrl?: string;
}

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_UPDATE_COMMAND = "npm install -g @aifight/aifight";
const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org/@aifight%2faifight/latest";

type ServerPolicyResult =
  | { readonly ok: true; readonly policy: BridgeVersionPolicy }
  | { readonly ok: false; readonly reason: string };

type NpmLatestResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly reason: string };

export async function checkBridgeUpdate(opts: CheckBridgeUpdateOptions): Promise<BridgeUpdateCheck> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const registryUrl = opts.registryUrl ?? DEFAULT_REGISTRY_URL;
  // In parallel, each with its own timeout: a dead endpoint costs one timeout
  // total, not two in series, and one arm's failure never blocks the other.
  const [server, npm] = await Promise.all([
    fetchServerPolicy(fetchImpl, opts.baseUrl, timeoutMs),
    fetchNpmLatest(fetchImpl, registryUrl, timeoutMs),
  ]);

  if (server.ok && npm.ok) return evaluateWithNpmLatest(opts.currentVersion, server.policy, npm.version);
  if (server.ok) return evaluatePolicy(opts.currentVersion, server.policy);
  if (npm.ok) return evaluateNpmOnly(opts.currentVersion, npm.version, server.reason);
  return unknown(
    opts.currentVersion,
    `version check unavailable (platform: ${server.reason}; npm registry: ${npm.reason})`,
  );
}

/** Both sources answered: npm decides "latest", the server decides the floor. */
function evaluateWithNpmLatest(
  currentVersion: string,
  policy: BridgeVersionPolicy,
  npmLatest: string,
): BridgeUpdateCheck {
  const base = { policy, latestVersion: npmLatest, latestSource: "npm" as const };
  const minCmp = compareSemver(currentVersion, policy.minimumSupportedVersion);
  if (minCmp !== null && minCmp < 0) {
    return {
      status: "unsupported",
      currentVersion,
      ...base,
      message: `Bridge ${currentVersion} is below the minimum supported version ${policy.minimumSupportedVersion}. Update before joining matches.`,
    };
  }

  const npmCmp = compareSemver(currentVersion, npmLatest);
  if (npmCmp !== null && npmCmp < 0) {
    return {
      status: "update_recommended",
      currentVersion,
      ...base,
      message: `Bridge ${currentVersion} works, but ${npmLatest} is the latest on npm.`,
    };
  }

  if (minCmp === null || npmCmp === null) {
    return {
      status: "unknown",
      currentVersion,
      ...base,
      message: "Bridge version could not be compared with the platform policy.",
    };
  }

  return {
    status: "current",
    currentVersion,
    ...base,
    message: `Bridge ${currentVersion} is up to date with npm.`,
  };
}

/** Only npm answered: the floor is unverifiable, so this arm can recommend an
 *  update but must NEVER report "unsupported". */
function evaluateNpmOnly(currentVersion: string, npmLatest: string, serverReason: string): BridgeUpdateCheck {
  const base = { latestVersion: npmLatest, latestSource: "npm" as const };
  const npmCmp = compareSemver(currentVersion, npmLatest);
  if (npmCmp === null) {
    return {
      status: "unknown",
      currentVersion,
      ...base,
      message: "Bridge version could not be compared with the npm registry latest.",
    };
  }
  const degraded = ` (platform policy ${serverReason} — minimum supported version unverified)`;
  if (npmCmp < 0) {
    return {
      status: "update_recommended",
      currentVersion,
      ...base,
      message: `Bridge ${currentVersion} works, but ${npmLatest} is the latest on npm.${degraded}`,
    };
  }
  return {
    status: "current",
    currentVersion,
    ...base,
    message: `Bridge ${currentVersion} is up to date with npm.${degraded}`,
  };
}

/** Only the server answered: the pre-2026-07-30 behavior, kept as the
 *  documented fallback — recommended_version plays the role of "latest". */
export function evaluatePolicy(currentVersion: string, policy: BridgeVersionPolicy): BridgeUpdateCheck {
  const base = { policy, latestVersion: policy.recommendedVersion, latestSource: "server" as const };
  const minCmp = compareSemver(currentVersion, policy.minimumSupportedVersion);
  if (minCmp !== null && minCmp < 0) {
    return {
      status: "unsupported",
      currentVersion,
      ...base,
      message: `Bridge ${currentVersion} is below the minimum supported version ${policy.minimumSupportedVersion}. Update before joining matches.`,
    };
  }

  const recommendedCmp = compareSemver(currentVersion, policy.recommendedVersion);
  if (recommendedCmp !== null && recommendedCmp < 0) {
    return {
      status: "update_recommended",
      currentVersion,
      ...base,
      message: `Bridge ${currentVersion} works, but ${policy.recommendedVersion} is recommended.`,
    };
  }

  if (minCmp === null || recommendedCmp === null) {
    return {
      status: "unknown",
      currentVersion,
      ...base,
      message: "Bridge version could not be compared with the platform policy.",
    };
  }

  return {
    status: "current",
    currentVersion,
    ...base,
    message: `Bridge ${currentVersion} is current enough for AIFight.`,
  };
}

async function fetchServerPolicy(
  fetchImpl: typeof fetch,
  baseUrl: string,
  timeoutMs: number,
): Promise<ServerPolicyResult> {
  try {
    const resp = await fetchWithTimeout(fetchImpl, `${normalizeBaseUrl(baseUrl)}/api/bridge/version`, timeoutMs);
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
    const raw = await resp.json().catch(() => undefined) as unknown;
    const policy = parseBridgeVersionPolicy(raw);
    return policy === null ? { ok: false, reason: "invalid policy" } : { ok: true, policy };
  } catch (e) {
    return { ok: false, reason: fetchFailureReason(e) };
  }
}

async function fetchNpmLatest(
  fetchImpl: typeof fetch,
  registryUrl: string,
  timeoutMs: number,
): Promise<NpmLatestResult> {
  try {
    const resp = await fetchWithTimeout(fetchImpl, registryUrl, timeoutMs);
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
    const raw = await resp.json().catch(() => undefined) as unknown;
    const version = (raw as { version?: unknown } | undefined)?.version;
    // A "latest" we cannot compare is no latest at all — treat it as a failed
    // arm so the server policy takes over.
    if (typeof version !== "string" || parseSemver(version) === null) {
      return { ok: false, reason: "invalid version" };
    }
    return { ok: true, version };
  } catch (e) {
    return { ok: false, reason: fetchFailureReason(e) };
  }
}

function fetchWithTimeout(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetchImpl(url, { method: "GET", signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

function fetchFailureReason(e: unknown): string {
  return (e as { name?: string } | null)?.name === "AbortError" ? "timed out" : "unreachable";
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
