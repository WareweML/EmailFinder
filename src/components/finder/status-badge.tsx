import { Badge } from "@/components/ui/badge";
import type { VerificationStatus } from "@/lib/email-finder/types";

const MAP: Record<
  VerificationStatus | "not_found",
  { label: string; variant: "success" | "warning" | "danger" | "info" | "default" | "accent" }
> = {
  valid: { label: "Verified", variant: "success" },
  catch_all: { label: "Catch-all", variant: "warning" },
  unknown: { label: "Unconfirmed", variant: "info" },
  invalid: { label: "Invalid", variant: "danger" },
  disposable: { label: "Disposable", variant: "danger" },
  role_based: { label: "Role-based", variant: "warning" },
  no_mx: { label: "No MX", variant: "danger" },
  syntax_error: { label: "Syntax error", variant: "danger" },
  not_found: { label: "Not found", variant: "default" },
};

export function StatusBadge({
  status,
}: {
  status: VerificationStatus | "not_found";
}) {
  const m = MAP[status] ?? MAP.unknown;
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

export function ConfidenceMeter({ value }: { value: number }) {
  const tone =
    value >= 85
      ? "text-success"
      : value >= 60
        ? "text-warning"
        : "text-fg-muted";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-bg-elevated border border-border">
        <div
          className={`h-full rounded-full transition-all duration-300 ${
            value >= 85
              ? "bg-success"
              : value >= 60
                ? "bg-warning"
                : "bg-fg-subtle"
          }`}
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      </div>
      <span className={`font-mono text-xs tabular-nums ${tone}`}>{value}%</span>
    </div>
  );
}
