import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import { createCollector } from "./collector.js";
import { hostContract } from "./contract.js";
import { createParityService } from "./parity-service.js";

/** Owns CLI requests and temporary exports for one Burn host worker. */
export function createCodeburnHostHandlers() {
  let collector = createCollector();
  const parity = createParityService();
  let confirmations = 0;

  const handlers = {
    codeburnStatistics: (input, context) => {
      if (confirmations > 0) throw new Error("CodeBurn configuration change is in progress; retry statistics after it settles");
      return collector.statistics(input, context.signal);
    },
    codeburnReport: (input, context) => parity.report(input, context.signal),
    codeburnPreviewAction: (input, context) => parity.preview(input, context.signal),
    codeburnConfirmAction: async (input, context) => {
      confirmations++;
      collector.dispose();
      collector = createCollector();
      try {
        return await parity.confirm(input, context.signal);
      } finally {
        confirmations--;
        collector.dispose();
        collector = createCollector();
      }
    },
    codeburnExportStart: (input, context) => parity.exportStart(input, context.signal),
    codeburnExportRead: (input, context) => parity.exportRead(input, context.signal),
    codeburnExportEnd: (input, context) => parity.exportEnd(input, context.signal),
  } satisfies ExperimentalHostRpcHandlers<typeof hostContract>;

  return {
    handlers,
    dispose: async () => {
      collector.dispose();
      await parity.dispose();
    },
  };
}
