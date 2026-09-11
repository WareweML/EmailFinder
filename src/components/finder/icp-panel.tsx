import { useState, useTransition } from "react";
import { Download, Loader2, Target } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { findIcpFn } from "@/lib/email-finder/server";
import type { AffinityRow, IcpReport } from "@/lib/email-finder/icp-find";
import { cn } from "@/lib/utils";

function parseCustomers(raw: string) {
  return raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const bits = line.split(/[,|\t]/).map((s) => s.trim());
      const domain = bits.find((b) => b.includes(".")) ?? bits[0] ?? "";
      const acv = Number((bits.find((b) => /^\d+(\.\d+)?k?$/i.test(b)) ?? "1").replace(/k$/i, "000"));
      const name = bits.find((b) => b && b !== domain && !/^\d/.test(b));
      return { name, domain, acv: Number.isFinite(acv) && acv > 0 ? acv : 1 };
    });
}

function Bar({ pct, affinity }: { pct: number; affinity: number }) {
  return (
    <div className="flex items-center gap-2 min-w-[140px]">
      <div className="h-1.5 flex-1 rounded-full bg-border overflow-hidden">
        <div className="h-full bg-fg" style={{ width: `${Math.min(100, affinity)}%` }} />
      </div>
      <span className="text-[10px] tabular-nums text-fg-muted w-16 text-right">{pct}% · {affinity}</span>
    </div>
  );
}

function Rows({ rows, empty }: { rows: AffinityRow[]; empty: string }) {
  if (!rows.length) return <p className="text-sm text-fg-muted">{empty}</p>;
  return (
    <div className="divide-y divide-border rounded-lg border border-border">
      {rows.map((r) => (
        <div key={r.name + r.source} className="flex items-start gap-3 px-3 py-2 text-sm">
          <div className="flex-1 min-w-0">
            {r.url ? (
              <a href={r.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                {r.name}
              </a>
            ) : (
              <span className="font-medium">{r.name}</span>
            )}
            <p className="text-xs text-fg-muted line-clamp-1">{r.evidence}</p>
          </div>
          <Bar pct={r.pct} affinity={r.affinity} />
        </div>
      ))}
    </div>
  );
}

const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "demo", label: "Demographics" },
  { id: "social", label: "Social" },
  { id: "sites", label: "Websites" },
  { id: "yt", label: "YouTube" },
  { id: "pods", label: "Podcasts" },
  { id: "reddit", label: "Reddit" },
  { id: "kw", label: "Keywords" },
  { id: "apps", label: "Apps & stack" },
  { id: "bio", label: "Bio phrases" },
] as const;

export function IcpPanel() {
  const [website, setWebsite] = useState("");
  const [brief, setBrief] = useState("");
  const [customers, setCustomers] = useState("");
  const [competitors, setCompetitors] = useState("");
  const [pending, start] = useTransition();
  const [report, setReport] = useState<IcpReport | null>(null);
  const [sec, setSec] = useState<(typeof SECTIONS)[number]["id"]>("overview");

  function run() {
    if (!website.trim()) {
      toast.error("Your website is required");
      return;
    }
    start(async () => {
      try {
        const r = await findIcpFn({
          data: {
            website: website.trim(),
            brief: brief.trim() || undefined,
            customers: parseCustomers(customers),
            competitors: competitors.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean),
          },
        });
        setReport(r);
        setSec("overview");
        toast.success(`ICP report · ${r.durationMs}ms · ${r.sources.length} sources`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "ICP failed");
      }
    });
  }

  function exportJson() {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `icp-${report.company.domain}.json`;
    a.click();
  }

  return (
    <div className="grid lg:grid-cols-[320px_1fr] gap-6">
      <div className="space-y-3 rounded-xl border border-border bg-surface p-4">
        <div className="flex items-center gap-2">
          <Target className="size-4" />
          <h2 className="font-medium">ICP Finder</h2>
        </div>
        <p className="text-xs text-fg-muted">
          SparkToro-style: where paying customers actually hang out. Weighted by ACV — not a generic “VP of SaaS” card.
        </p>
        <div>
          <Label>Your website</Label>
          <Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="kubex.ai" />
        </div>
        <div>
          <Label>What you do</Label>
          <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={3} placeholder="AI that cuts Kubernetes cloud spend for platform teams" />
        </div>
        <div>
          <Label>Customers who paid (domain, ACV)</Label>
          <Textarea
            value={customers}
            onChange={(e) => setCustomers(e.target.value)}
            rows={5}
            placeholder={"ghd.com, 80000\nstripe.com, 25000"}
          />
        </div>
        <div>
          <Label>Competitors</Label>
          <Textarea value={competitors} onChange={(e) => setCompetitors(e.target.value)} rows={3} placeholder={"cast.ai\nkubecost.com"} />
        </div>
        <Button onClick={run} disabled={pending} className="w-full">
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Target className="size-4" />}
          Build report
        </Button>
      </div>

      <div>
        {!report && !pending && (
          <p className="text-sm text-fg-muted">
            Report sections: demographics, social, websites, YouTube, podcasts, Reddit, keywords, apps, bio phrases — each with % of revenue-weighted audience and affinity.
          </p>
        )}
        {pending && (
          <p className="text-sm text-fg-muted flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" /> Crawling your site, customers, competitors, iTunes, HN, jobs, suggest…
          </p>
        )}
        {report && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-xl">{report.company.name}</h2>
                <p className="text-xs text-fg-muted">
                  {report.spend.weightedCustomers} paying logos · {report.durationMs}ms · {report.sources.join(" · ")}
                </p>
              </div>
              <Button size="sm" variant="secondary" onClick={exportJson}>
                <Download className="size-3.5" /> JSON
              </Button>
            </div>
            <div className="flex flex-wrap gap-1">
              {SECTIONS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSec(s.id)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs",
                    sec === s.id ? "bg-fg text-bg border-fg" : "border-border text-fg-muted",
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>

            {sec === "overview" && (
              <div className="space-y-4">
                <p className="text-sm">{report.company.brief}</p>
                <div>
                  <h3 className="text-sm font-semibold mb-2">Revenue-weighted segments</h3>
                  <div className="space-y-2">
                    {report.segments.map((s) => (
                      <div key={s.name} className="rounded-lg border border-border p-3">
                        <div className="flex justify-between text-sm">
                          <span className="font-medium">{s.name}</span>
                          <span className="tabular-nums text-fg-muted">{s.shareOfRevenue}% of named ACV</span>
                        </div>
                        <p className="text-xs mt-1">{s.who}</p>
                        <p className="text-xs text-fg-muted mt-1">Show up: {s.whereToShowUp.join(" · ") || "—"}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <h3 className="text-sm font-semibold mb-2">Take action</h3>
                  <ul className="list-disc pl-5 text-sm space-y-1">
                    {report.takeAction.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            {sec === "demo" && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold">Job titles (from who your customers are hiring)</h3>
                <Rows rows={report.demographics.titles} empty="No hiring titles" />
                <h3 className="text-sm font-semibold">Seniority</h3>
                <Rows rows={report.demographics.seniority} empty="—" />
                <h3 className="text-sm font-semibold">Locations</h3>
                <Rows rows={report.demographics.locations} empty="—" />
              </div>
            )}
            {sec === "social" && <Rows rows={report.social} empty="No public social on customer/competitor sites" />}
            {sec === "sites" && <Rows rows={report.websites} empty="No overlap sites" />}
            {sec === "yt" && <Rows rows={report.youtube} empty="No YouTube overlap" />}
            {sec === "pods" && <Rows rows={report.podcasts} empty="No iTunes matches for this category" />}
            {sec === "reddit" && <Rows rows={report.reddit} empty="No indexed subreddits" />}
            {sec === "kw" && <Rows rows={report.keywords} empty="No autocomplete" />}
            {sec === "apps" && <Rows rows={report.apps} empty="No stack detected" />}
            {sec === "bio" && <Rows rows={report.bioPhrases} empty="No title phrases" />}
          </div>
        )}
      </div>
    </div>
  );
}
