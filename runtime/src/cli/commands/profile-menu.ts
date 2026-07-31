// The Profile submenu — menu item 9 (V3 ④, design CLI_UX_V3_DESIGN §4).
//
// Several agent identities can live on this machine (one file each under
// <runtime-home>/identities/, see bridge/identities.ts); bridge.json is always
// the ACTIVE one. The submenu lists them, switches the active one, and
// registers fresh identities — the same chooser component as the main panel,
// forced single-column so the rich rows keep their hints.
//
// Behaviors (owner-confirmed):
//   * switch        → write the chosen identity over bridge.json (the outgoing
//                     active is snapshotted back to its file first), ✓ line;
//                     a running CLI bridge gets the restart offer — identity
//                     and LLM are the only true restart cases.
//   * desktop seat  → yellow warning + explicit confirm first; the seat is
//                     never silently stolen.
//   * already-active → note + no-op. Single identity → say so, no empty list.
//   * create        → the registration half of the setup wizard for a FRESH
//                     identity (stored, never clobbering bridge.json), then
//                     "switch to it now? [Y/n]".

import { resolveEffectiveDeclaredModel } from "../../bridge/declared-model";
import { readBridgeConfig, type BridgeConfig } from "../../bridge/config";
import {
  listIdentities,
  switchActiveIdentity,
  writeIdentity,
  type IdentityEntry,
} from "../../bridge/identities";
import { stampLocalDeviceIdentity } from "../../account/device-id";
import { createControlClient } from "../control-client";
import { readPort, readToken } from "../runtime-files";
import type { HandlerEnv } from "../shared";
import { t, type Locale } from "../i18n";
import { createAnsi } from "../ansi";
import { renderMenuFrame, type MenuFrame, type MenuFrameChoice } from "./menu-frame";
import type { MenuChoose } from "./menu-select";
import { agentSeatHolderPid } from "./bridge-start";
import { registerAgentConfig } from "./setup";

export interface ProfileMenuDeps {
  readonly env: HandlerEnv;
  readonly locale: () => Locale;
  /** Line input (the confirm prompts). main wires createOnboardIO.promptLine. */
  readonly prompt: (question: string) => Promise<string>;
  /** The arrow-key chooser (production). Absent in tests that drive the line
   *  fallback instead. */
  readonly choose?: MenuChoose;
  /** Called after a successful switch so the panel can refresh the
   *  identity-carrying decorations (status box, claim banner). */
  readonly onIdentitySwitched?: () => void;
  /** Test seam: a live desktop-app seat holds this machine's agent lock.
   *  Default: seat pid exists AND no CLI control API answers. */
  readonly desktopSeatActive?: () => Promise<boolean>;
  /** Test seam: a CLI bridge (aifight run / service) is answering its control
   *  API right now. Default: short-budget GET /v1/agents. */
  readonly cliBridgeRunning?: () => Promise<boolean>;
  /** Test seam for the fresh-agent registration (the network call). Default:
   *  the setup wizard's registerAgentConfig. */
  readonly registerFresh?: () => Promise<BridgeConfig>;
}

type Row =
  | { readonly kind: "identity"; readonly entry: IdentityEntry }
  | { readonly kind: "create" }
  | { readonly kind: "back" };

/** Run the Profile submenu until the user switches, creates, or backs out. */
export async function runProfileMenu(deps: ProfileMenuDeps): Promise<void> {
  const { env } = deps;
  for (;;) {
    const loc = deps.locale();
    let active: BridgeConfig;
    try {
      active = readBridgeConfig();
    } catch {
      // The panel only offers Profile when configured; a config that vanished
      // mid-session gets the plain truth instead of a crash.
      env.stdout("No active identity on this machine — run `aifight setup` first.\n");
      return;
    }
    // listIdentities seeds the store from bridge.json on first use (the
    // transparent migration), so a pre-V3 install sees itself here.
    const others = listIdentities().filter((i) => i.agentId !== active.agentId);

    const rows: Row[] = [{ kind: "identity", entry: { agentId: active.agentId, config: active } }];
    for (const entry of others) rows.push({ kind: "identity", entry });
    rows.push({ kind: "create" }, { kind: "back" });

    const frame = buildSubmenuFrame(loc, active, others, rows);
    const key = await pickKey(deps, frame, loc);
    if (key === null || key === "q") return;
    const row = rows[Number.parseInt(key, 10) - 1];
    if (row === undefined) continue; // a key that maps to no row — redraw
    if (row.kind === "back") return;
    if (row.kind === "create") {
      await createIdentityFlow(deps);
      return;
    }
    if (row.entry.agentId === active.agentId) {
      env.stdout(`${t(loc, "profile.already_active", { name: row.entry.config.agentName })}\n`);
      continue;
    }
    await switchIdentityFlow(deps, row.entry.config);
    return;
  }
}

/** The submenu frame: title, the active-identity header (+ the single-
 *  identity note when there is nothing to switch to), then the rows. */
function buildSubmenuFrame(
  loc: Locale,
  active: BridgeConfig,
  others: readonly IdentityEntry[],
  rows: readonly Row[],
): MenuFrame {
  const claimed = (c: BridgeConfig): string => t(loc, c.claimUrl === undefined ? "profile.row.claimed" : "profile.row.unclaimed");
  const subheader: string[] = [
    t(loc, "profile.active", {
      name: active.agentName,
      id: active.agentId,
      model: resolveEffectiveDeclaredModel(active).value,
    }),
  ];
  if (others.length === 0) subheader.push(t(loc, "profile.none_other"));

  const choices: MenuFrameChoice[] = rows.map((row, i) => {
    if (row.kind === "create") {
      return { key: String(i + 1), main: t(loc, "profile.row.create.main"), hint: t(loc, "profile.row.create.hint") };
    }
    if (row.kind === "back") {
      return { key: String(i + 1), main: t(loc, "profile.row.back.main"), hint: t(loc, "profile.row.back.hint") };
    }
    const isActive = row.entry.agentId === active.agentId;
    const marker = isActive ? "●" : "○";
    const tags = [
      ...(isActive ? [t(loc, "profile.row.current")] : []),
      claimed(row.entry.config),
      resolveEffectiveDeclaredModel(row.entry.config).value,
    ];
    return { key: String(i + 1), main: `${marker} ${row.entry.config.agentName}`, hint: tags.join(" · ") };
  });

  return { title: t(loc, "profile.title"), banner: [], subheader, choices };
}

/** One chooser pass (single-column), or the line-prompt fallback. q/Esc → null. */
async function pickKey(deps: ProfileMenuDeps, frame: MenuFrame, loc: Locale): Promise<string | null> {
  if (deps.choose !== undefined) {
    return (await deps.choose(frame, { locale: loc, singleColumn: true })).trim().toLowerCase();
  }
  deps.env.stdout(`\n${renderMenuFrame(frame, -1, createAnsi({ enabled: false }), 0, { singleColumn: true }).join("\n")}\n\n`);
  return (await deps.prompt(t(loc, "menu.pick"))).trim().toLowerCase();
}

/** Switch the active identity: desktop-seat guard, the store write, the ✓
 *  line, and the restart note when a CLI bridge is running. */
async function switchIdentityFlow(deps: ProfileMenuDeps, target: BridgeConfig): Promise<void> {
  const { env } = deps;
  const loc = deps.locale();
  const desktopSeat = deps.desktopSeatActive ?? (() => defaultDesktopSeatActive(env));
  if (await desktopSeat()) {
    env.stdout(`${t(loc, "profile.desktop_warn")}\n`);
    const ans = (await deps.prompt(t(loc, "profile.desktop_confirm"))).trim().toLowerCase();
    if (ans !== "y" && ans !== "yes") {
      env.stdout(`${t(loc, "prompt.cancel")}\n`);
      return;
    }
  }
  switchActiveIdentity(target);
  deps.onIdentitySwitched?.();
  env.stdout(`${t(loc, "profile.switched", { name: target.agentName })}\n`);
  const cliRunning = deps.cliBridgeRunning ?? (() => defaultCliBridgeRunning(env));
  if (await cliRunning()) {
    env.stdout(`${t(loc, "profile.restart_note", { name: target.agentName })}\n`);
  }
}

/** Create a FRESH identity through the registration half of the setup wizard:
 *  register, store it (bridge.json untouched), print the claim link, then ask
 *  whether to switch right away. */
async function createIdentityFlow(deps: ProfileMenuDeps): Promise<void> {
  const { env } = deps;
  const loc = deps.locale();
  const register = deps.registerFresh ?? (() => registerAgentConfig({ positional: [], flags: {}, jsonMode: false }, env));
  env.stdout(`${t(loc, "profile.create.working")}\n`);
  let fresh: BridgeConfig;
  try {
    fresh = await register();
  } catch (cause) {
    env.stdout(`${t(loc, "profile.create.failed", { error: cause instanceof Error ? cause.message : String(cause) })}\n`);
    return;
  }
  writeIdentity(fresh);
  // Same-machine agent, same device stamp (idempotent) — see setup.ts.
  stampLocalDeviceIdentity();
  env.stdout(`${t(loc, "profile.create.done", { name: fresh.agentName })}\n`);
  if (fresh.claimUrl !== undefined) env.stdout(`  ${fresh.claimUrl}\n`);

  const ans = (await deps.prompt(t(loc, "profile.create.switch_ask", { name: fresh.agentName }))).trim().toLowerCase();
  if (ans === "" || ans === "y" || ans === "yes") {
    await switchIdentityFlow(deps, fresh);
    return;
  }
  let activeName = fresh.agentName;
  try {
    activeName = readBridgeConfig().agentName;
  } catch {
    // Unreadable active config — the kept-identity name is a nicety only.
  }
  env.stdout(`${t(loc, "profile.create.kept", { name: activeName })}\n`);
}

/** The desktop seat: a live lock/pid holder that does NOT answer the CLI
 *  control API (the desktop app runs the bridge in-process and never starts
 *  it) — the same distinction `aifight start` makes before blaming a missing
 *  bridge. */
async function defaultDesktopSeatActive(env: HandlerEnv): Promise<boolean> {
  if (agentSeatHolderPid() === undefined) return false;
  return !(await defaultCliBridgeRunning(env));
}

/** A CLI bridge answering its local control API, with the same ~1.5s budget
 *  the panel's queue probe uses. Any failure = not running. */
async function defaultCliBridgeRunning(env: HandlerEnv): Promise<boolean> {
  try {
    const client = createControlClient({
      tokenSource: readToken,
      portSource: readPort,
      baseTimeoutMs: 1500,
      ...(env.fetchImpl !== undefined ? { fetchImpl: env.fetchImpl } : {}),
    });
    await client.get("/v1/agents");
    return true;
  } catch {
    return false;
  }
}
