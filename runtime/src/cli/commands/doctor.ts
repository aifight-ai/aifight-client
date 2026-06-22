import {
  readBridgeConfig,
  redactBridgeConfig,
  type BridgeConfig,
} from "../../bridge/config";
import { checkBridgeUpdate, type BridgeUpdateCheck } from "../../bridge/update-check";
import { hello as defaultHello, type HelloResult } from "../../index";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { expectArity } from "../shared";

interface RuntimeProbe {
  readonly status: string;
  readonly detail?: string;
}

export async function runDoctor(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 0, 0, "usage: aifight doctor");

  let helloResult: HelloResult;
  try {
    helloResult = (env.hello ?? defaultHello)();
  } catch (e) {
    if (args.jsonMode) {
      env.stderr(JSON.stringify({ error: { code: "client_doctor_schema", message: (e as Error).message } }) + "\n");
    } else {
      env.stderr(`aifight doctor FAILED: ${(e as Error).message}\n`);
    }
    return 1;
  }

  const bridge = await probeBridge(helloResult.runtimeVersion, env.fetchImpl ?? globalThis.fetch);

  if (args.jsonMode) {
    env.stdout(JSON.stringify({
      runtimeVersion: helloResult.runtimeVersion,
      messageTypeCount: helloResult.messageTypeCount,
      schemaCount: helloResult.schemaCount,
      schemasRoot: helloResult.schemasRoot,
      node: process.versions.node,
      platform: `${process.platform}-${process.arch}`,
      bridge,
    }) + "\n");
    return 0;
  }

  const out: string[] = [];
  out.push("aifight doctor:");
  out.push(`  version        : ${helloResult.runtimeVersion}`);
  out.push(`  node           : ${process.versions.node}`);
  out.push(`  platform       : ${process.platform}-${process.arch}`);
  out.push(`  bridge config  : ${bridge.config}`);
  if (bridge.runtime !== undefined) {
    out.push(`  runtime probe  : ${bridge.runtime.status}${bridge.runtime.detail ? ` (${bridge.runtime.detail})` : ""}`);
  }
  if (bridge.update !== undefined) {
    out.push(`  version policy : ${bridge.update.message}`);
    if (bridge.update.status === "update_recommended" || bridge.update.status === "unsupported") {
      out.push("  update command : aifight update --yes");
      out.push(`  manual npm     : ${bridge.update.policy?.updateCommand ?? "npm install -g @aifight/aifight"}`);
    }
  }
  out.push("");
  env.stdout(out.join("\n"));
  return 0;
}

async function probeBridge(
  currentVersion: string,
  fetchImpl: typeof fetch,
): Promise<{
  readonly config: string;
  readonly redactedConfig?: ReturnType<typeof redactBridgeConfig>;
  readonly runtime?: RuntimeProbe;
  readonly update?: BridgeUpdateCheck;
}> {
  try {
    const config = readBridgeConfig();
    const update = await checkBridgeUpdate({
      baseUrl: config.baseUrl,
      currentVersion,
      fetchImpl,
    });
    return {
      config: `configured for ${config.agentName} (${config.runtimeType})`,
      redactedConfig: redactBridgeConfig(config),
      runtime: await probeRuntime(config),
      update,
    };
  } catch (e) {
    const message = (e as Error).message;
    if (message.includes("bridge is not configured")) {
      return { config: "not configured" };
    }
    return { config: `invalid (${message})` };
  }
}

async function probeRuntime(config: BridgeConfig): Promise<RuntimeProbe> {
  if (config.runtimeType === "mock") return { status: "mock runtime configured" };
  return {
    status: "direct-LLM configured",
    detail: "run `aifight config test` to verify the model responds",
  };
}
