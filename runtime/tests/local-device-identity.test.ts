// The local identity self-check: does this shared AIFight home belong to this
// machine, or was it copied here from another one?
//
// It exists so the copied-directory case fails in the first second, offline,
// with words that name the cause — instead of connecting, collecting a 403, and
// looking like a network fault. It is NOT a security control: the stamp file is
// the user's own, and forging it changes nothing because the server's record is
// what actually decides. These cases pin the behaviours that follow from that:
// never accuse without evidence, never erase the evidence, and never block an
// install the owner has re-authorized.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkLocalDeviceIdentity,
  getDeviceId,
  resetDeviceIdCacheForTests,
  stampLocalDeviceIdentity,
} from "../src/account/device-id";
import { getMachineId, resetMachineIdCacheForTests } from "../src/account/machine-id";
import { resetCredentialsBackendCacheForTests } from "../src/account/credentials";

const MACHINE_A = "11111111-2222-3333-4444-555555555555";
const MACHINE_B = "99999999-8888-7777-6666-555555555555";

let home: string;
let prevHome: string | undefined;
let prevForce: string | undefined;
let prevMachine: string | undefined;

/** Re-enter the process as if freshly started: caches dropped, files kept. */
function restart(machineId: string): void {
  process.env.AIFIGHT_MACHINE_ID_OVERRIDE = machineId;
  resetDeviceIdCacheForTests();
  resetMachineIdCacheForTests();
}

function stampPath(): string {
  return join(home, "device.id");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aifight-localid-"));
  prevHome = process.env.AIFIGHT_HOME;
  prevForce = process.env.AIFIGHT_FORCE_FALLBACK;
  prevMachine = process.env.AIFIGHT_MACHINE_ID_OVERRIDE;
  process.env.AIFIGHT_HOME = home;
  process.env.AIFIGHT_FORCE_FALLBACK = "1";
  resetCredentialsBackendCacheForTests();
  restart(MACHINE_A);
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AIFIGHT_HOME;
  else process.env.AIFIGHT_HOME = prevHome;
  if (prevForce === undefined) delete process.env.AIFIGHT_FORCE_FALLBACK;
  else process.env.AIFIGHT_FORCE_FALLBACK = prevForce;
  if (prevMachine === undefined) delete process.env.AIFIGHT_MACHINE_ID_OVERRIDE;
  else process.env.AIFIGHT_MACHINE_ID_OVERRIDE = prevMachine;
  resetCredentialsBackendCacheForTests();
  resetDeviceIdCacheForTests();
  resetMachineIdCacheForTests();
  rmSync(home, { recursive: true, force: true });
});

describe("checkLocalDeviceIdentity", () => {
  // Every upgrade lands here: a home that predates the stamp. It must be
  // adopted silently, not treated as suspicious.
  it("stamps an unstamped home and calls it ok", () => {
    expect(existsSync(stampPath())).toBe(false);

    expect(checkLocalDeviceIdentity()).toEqual({ status: "ok" });

    expect(readFileSync(stampPath(), "utf8").trim()).toBe(getDeviceId());
    if (process.platform !== "win32") {
      expect(statSync(stampPath()).mode & 0o777).toBe(0o600);
    }
  });

  it("stays ok across restarts on the same machine", () => {
    checkLocalDeviceIdentity();
    for (let i = 0; i < 3; i++) {
      restart(MACHINE_A);
      expect(checkLocalDeviceIdentity()).toEqual({ status: "ok" });
    }
  });

  // The case the whole check exists for: the directory was carried to another
  // computer. The stamp still names the machine that made it.
  it("reports a home carried to another machine as foreign", () => {
    checkLocalDeviceIdentity();
    const stampedHere = readFileSync(stampPath(), "utf8").trim();

    restart(MACHINE_B);
    const verdict = checkLocalDeviceIdentity();

    expect(verdict.status).toBe("foreign");
    if (verdict.status !== "foreign") throw new Error("unreachable");
    expect(verdict.stamped).toBe(stampedHere);
    expect(verdict.current).toBe(getDeviceId());
    expect(verdict.current).not.toBe(verdict.stamped);
  });

  // Overwriting on mismatch would erase the only local evidence and make the
  // second run report ok — a check that clears itself is no check at all.
  it("never overwrites a mismatching stamp", () => {
    checkLocalDeviceIdentity();
    const original = readFileSync(stampPath(), "utf8");

    restart(MACHINE_B);
    expect(checkLocalDeviceIdentity().status).toBe("foreign");
    expect(readFileSync(stampPath(), "utf8")).toBe(original);

    restart(MACHINE_B);
    expect(checkLocalDeviceIdentity().status).toBe("foreign");
  });

  // A transient failure to read the machine id must never tell users their own
  // computer is somebody else's. Without this, one flaky read would hand a
  // working install a takeover card.
  it("declines to judge when the machine will not name itself", () => {
    checkLocalDeviceIdentity();

    restart("");
    expect(checkLocalDeviceIdentity()).toEqual({ status: "unverifiable" });
  });

  it("treats a missing or malformed stamp as unstamped, not as foreign", () => {
    for (const junk of ["", "   ", "not-hex", "abc123"]) {
      rmSync(stampPath(), { force: true });
      writeFileSync(stampPath(), junk, { mode: 0o600 });
      restart(MACHINE_A);

      expect(checkLocalDeviceIdentity()).toEqual({ status: "ok" });
      expect(readFileSync(stampPath(), "utf8").trim()).toBe(getDeviceId());
    }
  });
});

describe("stampLocalDeviceIdentity", () => {
  // Pairing and registering both call this. Without it, a machine the owner has
  // just authorized from the Dashboard would keep being refused by its own
  // local check — the recovery would appear to succeed and change nothing.
  it("re-stamps a foreign home so the authorized machine can start", () => {
    checkLocalDeviceIdentity();
    restart(MACHINE_B);
    expect(checkLocalDeviceIdentity().status).toBe("foreign");

    stampLocalDeviceIdentity();

    expect(checkLocalDeviceIdentity()).toEqual({ status: "ok" });
    expect(readFileSync(stampPath(), "utf8").trim()).toBe(getDeviceId());
  });

  it("writes nothing when there is no machine id to stamp with", () => {
    restart("");
    stampLocalDeviceIdentity();
    expect(existsSync(stampPath())).toBe(false);
  });
});

describe("getDeviceId when the machine will not name itself", () => {
  // The fingerprint needs both halves. Hashing an empty machine id would produce
  // a perfectly well-formed value meaning "I don't know which machine this is"
  // that is indistinguishable from "I am certain which machine this is" — and the
  // server, which cannot see the inputs, would bind it trust-on-first-use.
  it("sends nothing rather than a confident-looking guess", () => {
    restart("");
    expect(getDeviceId()).toBe("");
  });

  // The one that matters. A blank read on a machine that normally answers must
  // be a gap in identification, never a CHANGE of identity: if the failed round
  // bound a different fingerprint, the same laptop would be refused as another
  // computer the moment the read recovered — and the user would be sent through a
  // pairing code they did nothing to deserve.
  it("does not change this machine's identity when a read fails and recovers", () => {
    const before = getDeviceId();
    expect(before).not.toBe("");

    restart("");
    expect(getDeviceId()).toBe("");

    restart(MACHINE_A);
    expect(getDeviceId()).toBe(before);
  });

  it("still reports unverifiable rather than accusing anyone", () => {
    checkLocalDeviceIdentity();
    restart("");
    expect(checkLocalDeviceIdentity()).toEqual({ status: "unverifiable" });
  });
});

describe("getMachineId caching", () => {
  // The bridge's standby loop runs for weeks without restarting. Caching a
  // failure would freeze the machine into "cannot name itself" until someone
  // restarted the service, long after whatever broke the read had passed.
  it("does not cache a failed read, so the next attempt recovers on its own", () => {
    restart("");
    expect(getMachineId()).toBe("");

    process.env.AIFIGHT_MACHINE_ID_OVERRIDE = MACHINE_A;
    expect(getMachineId()).toBe(MACHINE_A);
  });

  // The counterpart: a value the platform did give up cannot change under a
  // running process, and re-reading it would spawn a subprocess per reconnect.
  it("caches a successful read for the process", () => {
    restart(MACHINE_A);
    expect(getMachineId()).toBe(MACHINE_A);

    process.env.AIFIGHT_MACHINE_ID_OVERRIDE = MACHINE_B;
    expect(getMachineId()).toBe(MACHINE_A);
  });
});
