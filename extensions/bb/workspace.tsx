import { type PluginNavPanelProps, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { CodeBurnWorkspace } from "./codeburn/app.js";
import { SpendPage } from "./spend/page.js";

/** Burn's two independent accounting scopes share one navigation entry, never one total. */
export function BurnWorkspace(props: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const machine = props.subPath === "machine";

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background text-foreground">
      <nav aria-label="Burn usage scope" className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-4 py-2 md:px-5">
        {([
          { label: "BB threads", subPath: "", selected: !machine },
          { label: "Machine usage", subPath: "machine", selected: machine },
        ] as const).map(({ label, subPath, selected }) => (
          <button
            key={subPath}
            type="button"
            aria-current={selected ? "page" : undefined}
            onClick={() => navigate.toPluginPanel("spend", { subPath })}
            className={`min-h-9 rounded-md px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${selected ? "bg-state-hover font-medium" : "text-muted-foreground hover:bg-state-hover"}`}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1">{machine ? <CodeBurnWorkspace /> : <SpendPage {...props} />}</div>
    </div>
  );
}
