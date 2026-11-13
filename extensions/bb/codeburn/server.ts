import { experimental_PluginRpcRefusal, type BbPluginApi, type ExperimentalPluginRpcHandlersWithContext } from "@get-bb/plugin-sdk";
import { hostContract, rpcContract } from "./contract.js";

/** Register these beside Burn's own RPC methods, without changing its accounting or settings lifecycle. */
export function createCodeburnHandlers(bb: BbPluginApi, getCliPath: () => Promise<string>): ExperimentalPluginRpcHandlersWithContext<typeof rpcContract> {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const connectedCli = async (hostId: string) => {
    const machine = (await bb.sdk.hosts.list()).find((item) => item.id === hostId);
    if (!machine) throw new experimental_PluginRpcRefusal({ code: "not_found", message: "This machine is no longer enrolled in BB." });
    if (machine.status !== "connected") throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Connect the selected machine before using CodeBurn." });
    return getCliPath();
  };
  return {
    codeburnMachines: async () => ({
      machines: (await bb.sdk.hosts.list()).map((machine) => ({
        id: machine.id,
        name: machine.name,
        connected: machine.status === "connected",
      })),
    }),
    codeburnStatistics: async ({ hostId, ...query }, context) => {
      const cliPath = await connectedCli(hostId);
      return host.call("codeburnStatistics", { ...query, cliPath }, { hostId, timeoutMs: 120_000, signal: context.experimental_signal });
    },
    codeburnReport: async ({ hostId, ...query }, context) => {
      const cliPath = await connectedCli(hostId);
      return host.call("codeburnReport", { ...query, cliPath }, { hostId, timeoutMs: 120_000, signal: context.experimental_signal });
    },
    codeburnPreviewAction: async ({ hostId, ...query }, context) => {
      const cliPath = await connectedCli(hostId);
      return host.call("codeburnPreviewAction", { ...query, cliPath }, { hostId, timeoutMs: 120_000, signal: context.experimental_signal });
    },
    codeburnConfirmAction: async ({ hostId, ...query }, context) => {
      const cliPath = await connectedCli(hostId);
      return host.call("codeburnConfirmAction", { ...query, cliPath }, { hostId, timeoutMs: 120_000, signal: context.experimental_signal });
    },
    codeburnExportStart: async ({ hostId, ...query }, context) => {
      const cliPath = await connectedCli(hostId);
      return host.call("codeburnExportStart", { ...query, cliPath }, { hostId, timeoutMs: 120_000, signal: context.experimental_signal });
    },
    codeburnExportRead: async ({ hostId, ...query }, context) => {
      const cliPath = await connectedCli(hostId);
      return host.call("codeburnExportRead", { ...query, cliPath }, { hostId, timeoutMs: 120_000, signal: context.experimental_signal });
    },
    codeburnExportEnd: async ({ hostId, ...query }, context) => {
      const cliPath = await connectedCli(hostId);
      return host.call("codeburnExportEnd", { ...query, cliPath }, { hostId, timeoutMs: 120_000, signal: context.experimental_signal });
    },
  };
}
