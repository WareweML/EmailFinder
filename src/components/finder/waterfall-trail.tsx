import { Check, Circle, Layers, SkipForward, X } from "lucide-react";
import type { WaterfallStage } from "@/lib/email-finder/waterfall";
import { cn } from "@/lib/utils";

export function WaterfallTrail({
  stages,
  winningProvider,
  compact,
}: {
  stages: WaterfallStage[];
  winningProvider?: string | null;
  compact?: boolean;
}) {
  if (!stages.length) return null;

  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-surface shadow-sm",
        compact ? "p-3" : "p-4 sm:p-5",
      )}
    >
      <div className="flex items-center gap-2 mb-3">
        <Layers className="size-4 text-accent" />
        <p className="text-sm font-semibold">Waterfall enrichment</p>
        <span className="text-[11px] text-fg-muted ml-auto">
          multi-source · early stop
        </span>
      </div>
      <ol className="space-y-2">
        {stages.map((s, i) => {
          const isWin =
            s.stoppedHere ||
            (winningProvider &&
              (s.id === winningProvider ||
                s.provider.toLowerCase().replace(/\s+/g, "_") ===
                  winningProvider));
          return (
            <li
              key={`${s.id}-${i}`}
              className={cn(
                "flex gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                isWin
                  ? "border-accent/40 bg-accent/5"
                  : "border-border bg-bg",
              )}
            >
              <StatusIcon status={s.status} win={Boolean(isWin)} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-mono text-fg-subtle tabular-nums">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <p className="text-sm font-medium">{s.provider}</p>
                  {isWin && (
                    <span className="rounded-full bg-accent/15 text-accent px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                      win
                    </span>
                  )}
                  {s.emailsFound > 0 && (
                    <span className="text-[11px] text-fg-muted">
                      +{s.emailsFound}
                    </span>
                  )}
                  <span className="ml-auto font-mono text-[11px] text-fg-subtle tabular-nums">
                    {s.ms}ms
                  </span>
                </div>
                <p className="text-xs text-fg-muted mt-0.5 break-words">
                  {s.detail}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function StatusIcon({
  status,
  win,
}: {
  status: WaterfallStage["status"];
  win: boolean;
}) {
  if (win || status === "hit") {
    return (
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
        <Check className="size-3" strokeWidth={3} />
      </span>
    );
  }
  if (status === "ok") {
    return (
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
        <Circle className="size-2.5 fill-current" />
      </span>
    );
  }
  if (status === "skip") {
    return (
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bg border border-border text-fg-subtle">
        <SkipForward className="size-3" />
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger">
        <X className="size-3" strokeWidth={3} />
      </span>
    );
  }
  // miss
  return (
    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bg border border-border text-fg-subtle">
      <Circle className="size-2" />
    </span>
  );
}
