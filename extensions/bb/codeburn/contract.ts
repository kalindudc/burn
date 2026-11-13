import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  actionQuerySchema, actionReplySchema, confirmQuerySchema, executableSchema,
  exportChunkSchema, exportEndSchema, exportLeaseSchema, exportReadSchema, exportStartSchema,
  previewReplySchema, reportQuerySchema, reportReplySchema,
} from "./parity-contract.js";

export const TABLES = ["daily", "activity", "models", "projects", "sessions", "tools", "mcp", "shellCommands", "records"] as const;
export const PAGE_SIZE = 50;
export const querySchema = z.object({
  period: z.enum(["today", "7d", "30d"]).default("30d"),
  table: z.enum(TABLES).default("daily"),
  page: z.number().int().min(0).max(1_000_000).default(0),
  search: z.string().max(200).default(""),
  refresh: z.boolean().default(false),
}).strict();
export type StatsQuery = z.infer<typeof querySchema>;
export type TableName = typeof TABLES[number];

const count = z.number().int().nonnegative();
const amount = z.number().finite().nonnegative();
export const rowSchema = z.record(z.string().max(200), z.json());
export type StatsRow = z.infer<typeof rowSchema>;
export const statsSchema = z.object({
  schema: z.literal("codeburn.export.v3"),
  generated: z.string(),
  from: z.string(),
  to: z.string(),
  currency: z.object({ code: z.string().min(1).max(20), symbol: z.string().max(20) }),
  summary: z.object({ cost: amount, saved: amount, apiCalls: count, sessions: count, projects: count }),
  tokens: z.object({ input: count, output: count, cacheRead: count, cacheWrite: count }),
  columns: z.array(z.string().max(200)).max(100),
  rows: z.array(rowSchema).max(PAGE_SIZE),
  totalRows: count,
  page: count,
  pageSize: z.literal(PAGE_SIZE),
});
export type StatsReply = z.infer<typeof statsSchema>;

export const codeburnHostMethods = {
  codeburnStatistics: {
    input: querySchema.extend({ cliPath: z.string().trim().min(1).max(4096) }),
    output: statsSchema,
  },
  codeburnReport: { input: reportQuerySchema.extend({ cliPath: executableSchema }), output: reportReplySchema },
  codeburnPreviewAction: { input: actionQuerySchema.extend({ cliPath: executableSchema }), output: previewReplySchema },
  codeburnConfirmAction: { input: confirmQuerySchema.extend({ cliPath: executableSchema }), output: actionReplySchema },
  codeburnExportStart: { input: exportStartSchema.extend({ cliPath: executableSchema }), output: exportLeaseSchema },
  codeburnExportRead: { input: exportReadSchema.extend({ cliPath: executableSchema }), output: exportChunkSchema },
  codeburnExportEnd: { input: exportEndSchema.extend({ cliPath: executableSchema }), output: z.object({ released: z.boolean() }) },
};
export const hostContract = defineRpcContract(codeburnHostMethods);

export const codeburnMethods = {
  codeburnMachines: {
    input: z.null(),
    output: z.object({ machines: z.array(z.object({ id: z.string(), name: z.string(), connected: z.boolean() })) }),
  },
  codeburnStatistics: {
    input: querySchema.extend({ hostId: z.string().min(1).max(100) }),
    output: statsSchema,
  },
  codeburnReport: { input: reportQuerySchema.extend({ hostId: z.string().min(1).max(100) }), output: reportReplySchema },
  codeburnPreviewAction: { input: actionQuerySchema.extend({ hostId: z.string().min(1).max(100) }), output: previewReplySchema },
  codeburnConfirmAction: { input: confirmQuerySchema.extend({ hostId: z.string().min(1).max(100) }), output: actionReplySchema },
  codeburnExportStart: { input: exportStartSchema.extend({ hostId: z.string().min(1).max(100) }), output: exportLeaseSchema },
  codeburnExportRead: { input: exportReadSchema.extend({ hostId: z.string().min(1).max(100) }), output: exportChunkSchema },
  codeburnExportEnd: { input: exportEndSchema.extend({ hostId: z.string().min(1).max(100) }), output: z.object({ released: z.boolean() }) },
};
export const rpcContract = defineRpcContract(codeburnMethods);
