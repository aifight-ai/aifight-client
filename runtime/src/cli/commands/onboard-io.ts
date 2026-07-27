// Real terminal / network I/O for the interactive setup / config onboarding.
// Kept separate from onboard-llm.ts so the decision logic stays unit-testable
// without a TTY or network. Nothing here is exercised in non-TTY runs.

import type { HandlerArgs, HandlerEnv } from "../shared.js";
import type { OnboardIO } from "./onboard-llm.js";
import type { Protocol } from "../../profile/config-schema.js";
import { storeSecretFile } from "../../profile/secret-ref.js";
import { runConfigProbe } from "./config-probe.js";
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
  return {
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
