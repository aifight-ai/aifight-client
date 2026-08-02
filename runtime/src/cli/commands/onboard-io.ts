// Real terminal / network I/O for the interactive setup / config onboarding.
// Kept separate from onboard-llm.ts so the decision logic stays unit-testable
// without a TTY or network. Nothing here is exercised in non-TTY runs.

import type { HandlerArgs, HandlerEnv } from "../shared.js";
import type { OnboardIO } from "./onboard-llm.js";
import type { Protocol } from "../../profile/config-schema.js";
import { storeSecretFile } from "../../profile/secret-ref.js";
import { runConfigProbe } from "./config-probe.js";
import { createMenuChooser } from "./menu-select.js";
import { discoverModelsForProtocol } from "../../llm/discover-models.js";

const CTRL_C = String.fromCharCode(3); // ETX
const CTRL_D = String.fromCharCode(4); // EOT
const BACKSPACE = String.fromCharCode(127); // DEL

function readLineVisible(env: HandlerEnv, question: string): Promise<string> {
  if (question) env.stdout(question);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise<string>((resolve) => {
    process.stdin.once("data", (chunk) => {
      process.stdin.pause();
      resolve(String(chunk).replace(/[\r\n]+$/, ""));
    });
  });
}

function readYesNo(env: HandlerEnv, question: string, defaultYes: boolean): Promise<boolean> {
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  return readLineVisible(env, question + suffix).then((answer) => {
    const n = answer.trim().toLowerCase();
    if (n === "") return defaultYes;
    return n === "y" || n === "yes";
  });
}

/**
 * P4 (统一交互规范 §2, 批 U4): THE yes/no confirm. Every command that asks a
 * yes/no question goes through this one function — before U4 half a dozen of
 * them hand-rolled the same stdin read and each spelled the bracket suffix
 * into its own question text.
 *
 * The `[Y/n]` / `[y/N]` suffix is appended HERE. A caller that writes it into
 * its question shows it twice, so question strings (and their i18n entries)
 * must never contain it. `defaultYes` is what a bare Enter means: destructive
 * actions (uninstall, credential deletion) always pass false.
 */
export function promptYesNo(env: HandlerEnv, question: string, defaultYes: boolean): Promise<boolean> {
  return readYesNo(env, question, defaultYes);
}

/** The injectable shape of P4. Commands take one as a test seam so both
 *  branches of a confirmation — accept and decline — are unit-testable
 *  without a real terminal. Production passes nothing and gets promptYesNo. */
export type ConfirmFn = (question: string, defaultYes: boolean) => Promise<boolean>;

/** The injectable shape of a single free-text prompt (the typed
 *  "re-enter this to confirm" step high-risk actions use). Same seam idea as
 *  ConfirmFn; production passes nothing and gets the real terminal read. */
export type PromptLineFn = (question: string) => Promise<string>;

/** Bind P4 to an env — the default every command falls back to. */
export function bindConfirm(env: HandlerEnv): ConfirmFn {
  return (question, defaultYes) => promptYesNo(env, question, defaultYes);
}

/** Bind the visible line read to an env (the P4 counterpart for typed
 *  confirmations). */
export function bindPromptLine(env: HandlerEnv): PromptLineFn {
  return (question) => readLineVisible(env, question);
}

/** What the user meant by their answer at a default-bracket prompt. */
export type DefaultPromptAnswer =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "keep" } // bare Enter — keep the shown current value
  | { readonly kind: "cancel" }; // q / Esc — abort, change nothing

/** Pure interpretation of a default-prompt answer — unit-tested without a TTY. */
export function resolveDefaultAnswer(raw: string): DefaultPromptAnswer {
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "keep" };
  // An Esc keypress arrives as the ESC control character (line mode passes it
  // through); q is the printable cancel. Both mean "change nothing".
  if (trimmed === "q" || trimmed === "Q" || trimmed.includes("\x1b")) return { kind: "cancel" };
  return { kind: "value", value: trimmed };
}

/**
 * The 3x-ui prompting habit the owner asked for (2026-07-30): every prompt
 * shows its CURRENT value as a default — `Question [current]: ` — Enter
 * keeps it, q/Esc cancels, anything else becomes the new value. Shared so
 * every present and future prompt behaves the same way. The readLine seam
 * lets tests drive it without a real stdin.
 */
export async function promptDefault(
  env: HandlerEnv,
  question: string,
  current: string,
  readLine: (env: HandlerEnv, question: string) => Promise<string> = readLineVisible,
): Promise<DefaultPromptAnswer> {
  return resolveDefaultAnswer(await readLine(env, `${question} [${current}]: `));
}

/**
 * promptDefault + in-place re-ask (统一交互规范 P3, 2026-08-02): an invalid
 * answer prints `validate`'s reason and asks AGAIN instead of kicking the user
 * back to the panel — the pattern the daily-cap prompt pioneered, extracted so
 * every text prompt behaves identically. A resolved "value" answer is
 * guaranteed to have passed `validate`; Enter keeps, q/Esc cancels, as ever.
 * Prompt lines stay ANSI-free by design — readline editing over colored text
 * mis-measures in some terminals; the color identity lives in frames/output.
 */
export async function promptValidatedDefault(
  env: HandlerEnv,
  question: string,
  current: string,
  validate: (value: string) => string | null,
  readLine: (env: HandlerEnv, question: string) => Promise<string> = readLineVisible,
): Promise<DefaultPromptAnswer> {
  for (;;) {
    const answer = await promptDefault(env, question, current, readLine);
    if (answer.kind !== "value") return answer;
    const reason = validate(answer.value);
    if (reason === null) return answer;
    env.stdout(`${reason}\n`);
  }
}

// Masked secret input. Uses raw mode so the key is never echoed to the
// terminal or scrollback. Falls back to a plain read when raw mode is
// unavailable (the caller only invokes this on a TTY).
function readHidden(env: HandlerEnv, question: string): Promise<string> {
  env.stdout(question);
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (b: boolean) => void };
  const canRaw = typeof stdin.setRawMode === "function" && stdin.isTTY === true;
  if (!canRaw) {
    return readLineVisible(env, "").then((v) => {
      env.stdout("\n");
      return v;
    });
  }
  return new Promise<string>((resolve) => {
    let buf = "";
    const prevEncoding = (stdin as NodeJS.ReadStream).readableEncoding;
    stdin.setRawMode!(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode!(false);
      stdin.pause();
      if (prevEncoding) stdin.setEncoding(prevEncoding);
    };
    const onData = (data: string): void => {
      for (const ch of data) {
        if (ch === "\n" || ch === "\r" || ch === CTRL_D) {
          cleanup();
          env.stdout("\n");
          resolve(buf);
          return;
        }
        if (ch === CTRL_C) {
          cleanup();
          env.stdout("\n");
          process.exit(130);
        }
        if (ch === BACKSPACE || ch === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        if (ch >= " ") buf += ch; // collect printable input, ignore other control chars
      }
    };
    stdin.on("data", onData);
  });
}

export async function discoverModels(
  env: HandlerEnv,
  input: { protocol: Protocol; baseURL: string; apiKey: string },
): Promise<string[] | null> {
  // Implementation lives in llm/discover-models.ts so the desktop app can reuse
  // it over IPC without importing CLI terminal machinery.
  return discoverModelsForProtocol({ ...(env.fetchImpl ? { fetchImpl: env.fetchImpl } : {}) }, input);
}

/** Build the real-terminal OnboardIO used by `aifight setup` / `aifight config` in a TTY. */
export function createOnboardIO(env: HandlerEnv): OnboardIO {
  // The arrow-key chooser is wired only for a REAL terminal (U3): the raw-mode
  // repaint math needs both streams, and a piped/scripted host must keep the
  // printed-frame + numbered-line fallback. Same gate as the panel's.
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  return {
    ...(interactive ? { choose: createMenuChooser(env) } : {}),
    promptLine: (q) => readLineVisible(env, q),
    promptHidden: (q) => readHidden(env, q),
    promptYesNo: (q, d) => readYesNo(env, q, d),
    discoverModels: (input) => discoverModels(env, input),
    storeKey: (filePath, value) => storeSecretFile(filePath, value),
    probe: async (slug) => {
      const args: HandlerArgs = { positional: [slug], flags: {}, jsonMode: false };
      try {
        return (await runConfigProbe(args, env)) === 0;
      } catch {
        return false;
      }
    },
  };
}
