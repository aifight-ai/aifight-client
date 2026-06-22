// Real terminal / network I/O for the interactive setup / config onboarding.
// Kept separate from onboard-llm.ts so the decision logic stays unit-testable
// without a TTY or network. Nothing here is exercised in non-TTY runs.

import type { HandlerArgs, HandlerEnv } from "../shared.js";
import type { OnboardIO } from "./onboard-llm.js";
import type { Protocol } from "../../profile/config-schema.js";
import { storeSecretFile } from "../../profile/secret-ref.js";
import { runConfigProbe } from "./config-probe.js";

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

async function discoverModels(
  env: HandlerEnv,
  input: { protocol: Protocol; baseURL: string; apiKey: string },
): Promise<string[] | null> {
  const fetchImpl = env.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;

  const parseIds = (json: unknown): string[] => {
    const out: string[] = [];
    const data = (json as { data?: unknown })?.data;
    if (Array.isArray(data)) {
      for (const m of data) {
        const id = (m as { id?: unknown })?.id;
        if (typeof id === "string") out.push(id);
      }
    }
    return out;
  };

  const attempt = async (url: string, headers: Record<string, string>): Promise<string[] | null> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetchImpl(url, { method: "GET", headers, signal: ctrl.signal });
      if (!res.ok) return null;
      const ids = parseIds(await res.json());
      return ids.length > 0 ? ids : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const base = input.baseURL.replace(/\/+$/, "");
  try {
    if (input.protocol === "anthropic_messages") {
      return await attempt(`${base}/v1/models`, {
        "x-api-key": input.apiKey,
        "anthropic-version": "2023-06-01",
      });
    }
    if (input.protocol === "openai_responses" || input.protocol === "openai_chat_compat") {
      const bearer = { Authorization: `Bearer ${input.apiKey}` };
      return (await attempt(`${base}/models`, bearer)) ?? (await attempt(`${base}/v1/models`, bearer));
    }
    // gemini_generate_content and others: skip discovery (different shape).
    return null;
  } catch {
    return null;
  }
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
