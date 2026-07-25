// runtime/src/account/machine-id.ts
//
// The machine's own identifier, mixed into the device id so that copying the
// AIFight home directory does not copy the machine's identity with it.
//
// device.key alone cannot tell the two apart: its secret is a file, so anyone
// who copies the whole directory to another laptop presents a byte-identical
// device id and the server has nothing to distinguish them by. Hashing a value
// the OS holds — not the directory — closes that: the copy lands on a machine
// whose id differs, so the hash differs, so the server refuses it.
//
// The value is used LOCALLY ONLY, as one input to a hash. It is never written
// to disk, never put in a config file, and never sent anywhere: the server sees
// sha256(secret + ":" + machineId) and cannot recover either half. Pairing with
// the random per-install secret is deliberate — it keeps a reinstall a genuinely
// fresh identity that cannot be correlated with the previous one, which a raw
// hardware id alone would not.
//
// Failing to read it is NOT an error. Containers frequently have no machine id,
// and a machine that cannot produce one must still be able to play. What it does
// NOT do is invent one: an empty read makes getDeviceId() return "" so the header
// is omitted entirely and the connection is simply unidentified. Hashing the
// empty string instead would produce a confident-looking fingerprint that is
// neither reproducible (the next read may succeed, and then it "moves machine")
// nor meaningful (it is exactly the copy-the-directory value this file exists to
// retire). Unidentified is a state the server already understands.
//
// Known blind spots, accepted: Linux VMs cloned from one golden image share
// /etc/machine-id and read as the same machine; reinstalling the OS reads as a
// new machine and needs one re-pair.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Read at most this many bytes of a command's output — these ids are tens of
 *  bytes and the buffer only exists to bound a misbehaving tool. */
const MAX_OUTPUT_BYTES = 1 << 20;

/** Give a platform tool this long before deciding this machine has no id. Long
 *  enough for a loaded machine, short enough that a wedged tool cannot hold up
 *  the bridge's start. */
const READ_TIMEOUT_MS = 3_000;

let cached: string | null = null;

/** Test/container escape hatch. Setting it makes the machine id whatever it
 *  says, which is how the tests simulate moving to another machine. It is NOT a
 *  security boundary — the local check it feeds is a courtesy that fails fast
 *  offline, and the server's own record is what actually refuses a stolen
 *  credential. */
const MACHINE_ID_OVERRIDE_ENV = "AIFIGHT_MACHINE_ID_OVERRIDE";

/** Test-only: drop the process cache. Not re-exported from the package root. */
export function resetMachineIdCacheForTests(): void {
  cached = null;
}

/**
 * This machine's identifier, or "" when the platform will not give one up.
 *
 * A successful read is cached for the process: the platform value cannot change
 * under a running process (short of a reboot), and re-reading it would spawn a
 * subprocess on every reconnect.
 *
 * A FAILED read is deliberately not cached. The bridge's standby loop runs for
 * weeks without restarting, so caching a failure would freeze this machine into
 * "cannot name itself" until someone restarts the service — long after whatever
 * broke the read had passed. Re-reading costs a subprocess on a machine that is
 * already misbehaving, and buys back automatic recovery on the next reconnect.
 */
export function getMachineId(): string {
  if (cached !== null) return cached;
  const id = resolveMachineId();
  if (id !== "") cached = id;
  return id;
}

function resolveMachineId(): string {
  const override = process.env[MACHINE_ID_OVERRIDE_ENV];
  if (override !== undefined) return override.trim();

  // Try twice before concluding this machine has no id. An empty result is a
  // SUPPORTED state, but it is not a harmless one for a machine that normally
  // does answer: the id feeds the device fingerprint, so one blank read changes
  // the fingerprint, and the server refuses the connection as coming from
  // another machine. The cost of that is a re-pair the user did nothing to
  // deserve. Two of these reads spawn a subprocess, which is exactly the kind of
  // thing that fails once under memory pressure and works immediately after, so
  // one retry buys a real reduction for a few milliseconds.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const id = readPlatformMachineId();
      if (id !== "") return id;
    } catch {
      // Fall through to the retry, then to the supported empty state.
    }
  }
  return "";
}

function readPlatformMachineId(): string {
  switch (process.platform) {
    case "darwin":
      return readDarwinMachineId();
    case "linux":
      return readLinuxMachineId();
    case "win32":
      return readWindowsMachineId();
    default:
      return "";
  }
}

/** macOS: the hardware UUID out of the IOKit registry. `ioreg` is present on
 *  every install, needs no privileges, and raises no authorization prompt. */
function readDarwinMachineId(): string {
  const out = runCapture("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
  // The line looks like:  "IOPlatformUUID" = "0A1B2C3D-..."
  const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
  return m?.[1]?.trim() ?? "";
}

/** Linux: systemd's /etc/machine-id, falling back to the older D-Bus location
 *  that non-systemd distributions still use. */
function readLinuxMachineId(): string {
  for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const v = readFileSync(path, "utf8").trim();
      if (v !== "") return v;
    } catch {
      // Try the next location.
    }
  }
  return "";
}

/** Windows: the MachineGuid the OS writes at install time. Query the 64-bit
 *  view explicitly so a 32-bit Node build isn't silently redirected to the
 *  WOW6432Node copy and made to look like a different machine; older `reg`
 *  builds reject /reg:64, so fall back to the plain query. */
function readWindowsMachineId(): string {
  const key = "HKLM\\SOFTWARE\\Microsoft\\Cryptography";
  for (const args of [
    ["query", key, "/v", "MachineGuid", "/reg:64"],
    ["query", key, "/v", "MachineGuid"],
  ]) {
    try {
      const out = runCapture("reg", args);
      const m = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(out);
      const v = m?.[1]?.trim();
      if (v) return v;
    } catch {
      // Try the next form.
    }
  }
  return "";
}

/** Run a platform tool and return its stdout. stdin is closed and stderr is
 *  discarded so nothing can block on input or leak onto our own output. */
function runCapture(file: string, args: readonly string[]): string {
  return execFileSync(file, [...args], {
    encoding: "utf8",
    timeout: READ_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
  });
}
