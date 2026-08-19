import {
  Check,
  Copy,
  Mail,
  Server,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ConfidenceMeter, StatusBadge } from "./status-badge";
import { WaterfallTrail } from "./waterfall-trail";
import { sourceLabel } from "@/lib/email-finder/score";
import type { WaterfallFindResult } from "@/lib/email-finder/waterfall";
import { toast } from "sonner";

export function ResultCard({ result }: { result: WaterfallFindResult }) {
  const best = result.best;
  const [copied, setCopied] = useState(false);

  if (!best) {
    return (
      <div className="space-y-4">
        {result.waterfall?.length ? (
          <WaterfallTrail
            stages={result.waterfall}
            winningProvider={result.winningProvider}
          />
        ) : null}
        <Card className="border-dashed shadow-sm">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-bg border border-border">
              <Mail className="size-5 text-fg-subtle" />
            </div>
            <div>
              <p className="font-medium text-fg">No email found</p>
              <p className="mt-1 text-sm text-fg-muted max-w-sm">
                Waterfall exhausted local index, knowledge base, live crawl,
                patterns, and SMTP. Try another domain or name spelling.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(best.email);
      setCopied(true);
      toast.success("Email copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy");
    }
  };

  return (
    <div className="space-y-4">
      {result.waterfall?.length ? (
        <WaterfallTrail
          stages={result.waterfall}
          winningProvider={result.winningProvider}
        />
      ) : null}

      <Card className="overflow-hidden shadow-sm">
        <div className="h-1 bg-accent" />
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1 min-w-0">
              <p className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
                Best match
                {result.winningProvider
                  ? ` · via ${result.winningProvider.replace(/_/g, " ")}`
                  : ""}
              </p>
              <CardTitle className="font-mono text-xl sm:text-2xl break-all">
                {best.email}
              </CardTitle>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status={best.status} />
              <Button variant="secondary" size="sm" onClick={copy}>
                {copied ? (
                  <Check className="size-3.5" />
                ) : (
                  <Copy className="size-3.5" />
                )}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Metric
              label="Confidence"
              value={<ConfidenceMeter value={best.confidence} />}
            />
            <Metric
              label="Pattern"
              value={
                <span className="font-mono text-sm">{best.patternLabel}</span>
              }
            />
            <Metric
              label="MX provider"
              value={
                <span className="text-sm truncate">
                  {result.domainIntel.mxProvider ?? "Custom"}
                </span>
              }
            />
            <Metric
              label="Latency"
              value={
                <span className="font-mono text-sm tabular-nums">
                  {result.durationMs}ms
                </span>
              }
            />
          </div>

          <Separator />

          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
              Evidence
            </p>
            <ul className="space-y-1.5">
              {best.reasons.map((r) => (
                <li
                  key={r}
                  className="flex items-start gap-2 text-sm text-fg-muted"
                >
                  <ShieldCheck className="size-3.5 mt-0.5 shrink-0 text-accent" />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-wrap gap-2">
            {best.sources.map((s) => (
              <span
                key={s}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-bg px-2.5 py-1 text-xs text-fg-muted"
              >
                <Sparkles className="size-3" />
                {sourceLabel(s)}
              </span>
            ))}
          </div>

          {result.indexStats && (
            <p className="text-[11px] text-fg-subtle">
              Index: {result.indexStats.totalEmails} emails ·{" "}
              {result.indexStats.domains} domains (grows with every search)
            </p>
          )}
        </CardContent>
      </Card>

      {result.alternatives.length > 0 && (
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Alternatives</CardTitle>
          </CardHeader>
          <CardContent className="space-y-0 divide-y divide-border">
            {result.alternatives.map((alt) => (
              <div
                key={alt.email}
                className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="font-mono text-sm break-all">{alt.email}</p>
                  <p className="text-xs text-fg-subtle mt-0.5">
                    {alt.patternLabel}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <ConfidenceMeter value={alt.confidence} />
                  <StatusBadge status={alt.status} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Server className="size-4 text-fg-muted" />
              Domain intelligence
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="Domain" value={result.domainIntel.domain} mono />
            <Row
              label="MX hosts"
              value={result.domainIntel.mxHosts.slice(0, 2).join(", ") || "—"}
              mono
            />
            <Row
              label="Pattern samples"
              value={String(result.domainIntel.sampleSize)}
            />
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Pipeline</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {result.pipeline.map((s) => (
              <div
                key={s.id}
                className="flex gap-3 rounded-lg border border-border bg-bg px-3 py-2.5"
              >
                <span
                  className={`mt-1.5 size-2 shrink-0 rounded-full ${
                    s.status === "ok"
                      ? "bg-success"
                      : s.status === "warn"
                        ? "bg-warning"
                        : s.status === "error"
                          ? "bg-danger"
                          : "bg-fg-subtle"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">{s.label}</p>
                    <span className="font-mono text-[11px] text-fg-subtle tabular-nums">
                      {s.ms}ms
                    </span>
                  </div>
                  <p className="text-xs text-fg-muted mt-0.5 break-words">
                    {s.detail}
                  </p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] uppercase tracking-wider text-fg-subtle">
        {label}
      </p>
      <div className="text-fg">{value}</div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-fg-subtle shrink-0">{label}</span>
      <span
        className={`text-right break-all ${mono ? "font-mono text-xs" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}
