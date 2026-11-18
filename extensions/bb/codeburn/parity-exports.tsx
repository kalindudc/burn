import { useEffect, useRef, useState } from "react";
import { experimental_saveFile, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract.js";
import type { ExportLease, ReportScope } from "./parity-contract.js";
import { exportStartSchema } from "./parity-contract.js";

const button = "min-h-10 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";
const integer = new Intl.NumberFormat();

type Progress = { name: string; bytes: number; total: number };

export function ParityExports({ hostId, scope }: { hostId: string; scope: ReportScope }) {
  const rpc = useRpc<typeof rpcContract>();
  const [lease, setLease] = useState<ExportLease | null>(null);
  const leaseRef = useRef<ExportLease | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [working, setWorking] = useState(false);
  const [handoff, setHandoff] = useState<string | null>(null);
  const epoch = useRef(0);

  useEffect(() => {
    const currentEpoch = epoch;
    return () => {
      currentEpoch.current++;
      const active = leaseRef.current;
      leaseRef.current = null;
      if (active) void rpc.call("codeburnExportEnd", { hostId, id: active.id }).catch(() => { /* Component has unmounted; no visible error surface remains. */ });
    };
  }, [hostId, rpc]);

  async function release() {
    epoch.current++;
    const active = leaseRef.current;
    leaseRef.current = null;
    setLease(null);
    setProgress(null);
    setHandoff(null);
    if (active) await rpc.call("codeburnExportEnd", { hostId, id: active.id });
  }

  async function start(format: "csv" | "json") {
    if (working) return;
    setWorking(true);
    setError(null);
    const beforeRelease = epoch.current;
    try {
      await release();
      if (epoch.current !== beforeRelease + 1) return;
      const generation = epoch.current;
      const query = exportStartSchema.parse({ ...scope, format });
      const next = await rpc.call("codeburnExportStart", { ...query, hostId });
      if (epoch.current !== generation) {
        await rpc.call("codeburnExportEnd", { hostId, id: next.id });
        return;
      }
      leaseRef.current = next;
      setLease(next);
    } catch (cause: unknown) {
      if (epoch.current === beforeRelease + 1) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (epoch.current === beforeRelease + 1) setWorking(false);
    }
  }

  async function download(file: ExportLease["files"][number]) {
    const current = leaseRef.current;
    if (!current || working) return;
    const generation = epoch.current;
    setWorking(true);
    setError(null);
    setHandoff(null);
    setProgress({ name: file.name, bytes: 0, total: file.size });
    try {
      const chunks: BlobPart[] = [];
      let offset = 0;
      while (true) {
        const chunk = await rpc.call("codeburnExportRead", { hostId, id: current.id, name: file.name, offset });
        if (epoch.current !== generation) return;
        const binary = atob(chunk.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        if (chunk.totalSize !== file.size || chunk.nextOffset !== offset + bytes.length || chunk.nextOffset > file.size || (!chunk.eof && bytes.length === 0) || (chunk.eof !== (chunk.nextOffset === file.size))) throw new Error("Native export returned an inconsistent file chunk.");
        chunks.push(bytes);
        offset = chunk.nextOffset;
        setProgress({ name: file.name, bytes: offset, total: file.size });
        if (chunk.eof) break;
      }
      if (epoch.current !== generation) return;
      const fileName = file.name.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g, "_") || "codeburn-export";
      const outcome = await experimental_saveFile({ fileName, blob: new Blob(chunks, { type: file.mime }) });
      if (epoch.current !== generation) return;
      if (outcome === "failed") throw new Error("BB could not start saving this export. Inspect BB's download error and retry.");
      setHandoff(fileName);
    } catch (cause: unknown) {
      if (epoch.current === generation) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (epoch.current === generation) { setProgress(null); setWorking(false); }
    }
  }

  return <section aria-label="Native exports" className="min-w-0 space-y-4">
    <div><h2 className="text-lg font-semibold">Native exports</h2><p className="mt-1 text-sm text-muted-foreground">Export the selected period, provider and project filters using CodeBurn CLI. Downloads contain the exact native CSV or JSON bytes.</p></div>
    <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={working} onClick={() => void start("csv")}>Create CSV export</button><button type="button" className={button} disabled={working} onClick={() => void start("json")}>Create JSON export</button></div>
    {error && <p role="alert" className="rounded-md border border-destructive px-3 py-2 text-sm text-destructive">Export failed: {error}{/expired|not found|unknown/i.test(error) && " Create a new export to continue."}</p>}
    {working && <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{progress ? `Downloading ${progress.name}: ${integer.format(progress.bytes)} / ${integer.format(progress.total)} bytes` : "Running native export…"}</p>}
    {handoff && <p role="status" className="text-sm text-muted-foreground">Save requested: {handoff}. BB handles download/share completion.</p>}
    {lease && <div className="space-y-3"><p className="text-xs text-muted-foreground">{lease.files.length} native file{lease.files.length === 1 ? "" : "s"} · lease expires {new Date(lease.expiresAt).toLocaleString()}</p>
      {lease.files.length === 0 ? <p className="text-sm text-muted-foreground">CodeBurn produced no files.</p> : <ul className="divide-y divide-border border-y border-border">{lease.files.map((file) => <li key={file.name} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2 text-sm"><span className="min-w-0 break-all">{file.name} <span className="text-muted-foreground">· {integer.format(file.size)} bytes · {file.mime}</span></span><button type="button" className={button} disabled={working} onClick={() => void download(file)}>Download {file.name}</button></li>)}</ul>}
      <button type="button" className={button} disabled={working} onClick={() => { setError(null); void release().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))); }}>Release export</button>
    </div>}
  </section>;
}
