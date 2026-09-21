import { useEffect, useState, useTransition } from "react";
import { Download, FolderOpen, Loader2, Search, Target } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { findIcpFn, loadLastIcpFn } from "@/lib/email-finder/server";
import type { AffinityRow, IcpReport } from "@/lib/email-finder/icp-find";
import { downloadBlob, icpCsv, icpHtml } from "@/lib/email-finder/icp-export";
import { writeIcpDiscoverQuery } from "@/lib/email-finder/icp-discover-bridge";
import { icpToDiscover } from "@/lib/email-finder/icp-to-discover";
import { cn } from "@/lib/utils";

function parseCustomers(raw: string) {
  return raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => {
      const bits = line.split(/[,;|\t]/).map((s) => s.trim()).filter(Boolean);
      const email = bits.find((b) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b));
      const domainBit = bits.find((b) => !b.includes("@") && /\.[a-z]{2,}$/i.test(b));
      const acvBit = bits.find((b) => /^\$?\d+(\.\d+)?k?$/i.test(b.replace(/,/g, "")));
      let acv = 0;
      if (acvBit) {
        const n = acvBit.replace(/[$,]/g, "");
        acv = /k$/i.test(n) ? Number(n.replace(/k$/i, "")) * 1000 : Number(n);
      }
      const name = bits.find((b) => b !== email && b !== domainBit && b !== acvBit && !/^\d/.test(b));
      const domain = (email?.split("@")[1] || domainBit || "").toLowerCase();
      return {
        email,
        name,
        domain,
        acv: Number.isFinite(acv) && acv > 0 ? acv : undefined,
        _order: i,
      };
    })
    .filter((c) => c.email || c.domain);
}

function Bar({ pct, affinity }: { pct: number; affinity: number }) {
  return (
    <div className="flex items-center gap-2 min-w-[140px]">
      <div className="h-1.5 flex-1 rounded-full bg-border overflow-hidden">
        <div className="h-full bg-fg" style={{ width: `${Math.min(100, affinity)}%` }} />
      </div>
      <span className="text-[10px] tabular-nums text-fg-muted w-16 text-right">
        {pct}% · {affinity}
      </span>
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
  { id: "buyers", label: "Buyers" },
  { id: "demo", label: "Demographics" },
  { id: "social", label: "Social" },
  { id: "sites", label: "Websites" },
  { id: "press", label: "Press" },
  { id: "nets", label: "Networks" },
  { id: "yt", label: "YouTube" },
  { id: "pods", label: "Podcasts" },
  { id: "reddit", label: "Reddit" },
  { id: "kw", label: "Keywords" },
  { id: "apps", label: "Apps & stack" },
  { id: "prompts", label: "Prompts" },
  { id: "bio", label: "Bio phrases" },
  { id: "tam", label: "TAM" },
  { id: "likes", label: "Lookalikes" },
] as const;

export function IcpPanel() {
  const [website, setWebsite] = useState("");
  const [brief, setBrief] = useState("");
  const [customers, setCustomers] = useState("");
  const [competitors, setCompetitors] = useState("");
  const [pending, start] = useTransition();
  const [report, setReport] = useState<IcpReport | null>(null);
  const [sec, setSec] = useState<(typeof SECTIONS)[number]["id"]>("overview");

  function applySaved(r: IcpReport, silent = false) {
    setReport(r);
    setSec("overview");
    if (!website) setWebsite(r.company.domain);
    if (!brief) setBrief(r.company.brief);
    if (!customers && r.buyers.length) {
      setCustomers(r.buyers.map((b) => [b.email || b.domain, b.acv].filter(Boolean).join(", ")).join("\n"));
    }
    writeIcpDiscoverQuery({ ...icpToDiscover(r, "people"), autoSearch: false }, { open: false });
    if (!silent) toast.success(`Loaded SparkToro ${r.sparkToro?.reportId ?? "report"} · 0 new credits`);
  }

  function sendToDiscover(kind: "people" | "companies") {
    if (!report) {
      toast.error("Open or build an ICP first");
      return;
    }
    const q = icpToDiscover(report, kind);
    writeIcpDiscoverQuery({ ...q, autoSearch: true }, { open: true });
    toast.success(`Discover ${kind} filters filled from ICP`);
  }

  useEffect(() => {
    let live = true;
    loadLastIcpFn()
      .then((r) => {
        if (!live || !r) return;
        applySaved(r, true);
      })
      .catch(() => {
        /* first visit */
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openLast() {
    start(async () => {
      try {
        const r = await loadLastIcpFn();
        if (!r) {
          toast.error("No saved report on disk");
          return;
        }
        applySaved(r);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Load failed");
      }
    });
  }

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
            competitors: competitors
              .split(/[\n,]+/)
              .map((s) => s.trim())
              .filter(Boolean),
          },
        });
        setReport(r);
        setSec("overview");
        toast.success(`ICP · ${r.buyers.length} buyers · ${r.durationMs}ms`);
        downloadBlob(`icp-${r.company.domain}.html`, "text/html;charset=utf-8", icpHtml(r));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "ICP failed");
      }
    });
  }

  function stem() {
    return `icp-${report?.company.domain || "report"}`;
  }

  function exportJson() {
    if (!report) return;
    downloadBlob(`${stem()}.json`, "application/json", JSON.stringify(report, null, 2));
  }
  function exportCsv() {
    if (!report) return;
    downloadBlob(`${stem()}.csv`, "text/csv;charset=utf-8", icpCsv(report));
  }
  function exportHtml() {
    if (!report) return;
    downloadBlob(`${stem()}.html`, "text/html;charset=utf-8", icpHtml(report));
  }

  return (
    <div className="grid lg:grid-cols-[320px_1fr] gap-6">
      <div className="space-y-3 rounded-xl border border-border bg-surface p-4">
        <div className="flex items-center gap-2">
          <Target className="size-4" />
          <h2 className="font-medium">ICP Finder</h2>
        </div>
        <p className="text-xs text-fg-muted">
          Full SparkToro v3 report (create + demographics, networks, YouTube, podcasts, websites, press, apps, social, Reddit, prompts, bios, TAM, keywords) on an audience built from the people who paid you. Plus person + company enrich for ROAS weights.
        </p>
        <div>
          <Label>Your website</Label>
          <Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="emailverifier.io" />
        </div>
        <div>
          <Label>What you do</Label>
          <Textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={3}
            placeholder="Email verification, email finder, search leads SaaS"
          />
        </div>
        <div>
          <Label>Paying customer emails (highest ACV first)</Label>
          <Textarea
            value={customers}
            onChange={(e) => setCustomers(e.target.value)}
            rows={6}
            placeholder={"ayrton@curaeducation.com, 120000\nbaki@lookfor.ai, 80000\nmarketing@kubex.ai, 40000\nray@lendpilot.com, 25000\nchris@qualityhealth.io, 12000"}
          />
          <p className="text-[11px] text-fg-muted mt-1">One per line: email or email, ACV. Role inboxes (marketing@) count as that function at the company.</p>
        </div>
        <div>
          <Label>Competitors</Label>
          <Textarea
            value={competitors}
            onChange={(e) => setCompetitors(e.target.value)}
            rows={3}
            placeholder={"emaillistverify.com\nzerobounce.net\nfindymail.com"}
          />
        </div>
        <Button onClick={run} disabled={pending} className="w-full">
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Target className="size-4" />}
          Build report
        </Button>
        <Button onClick={openLast} disabled={pending} variant="secondary" className="w-full">
          <FolderOpen className="size-4" />
          Open last report (0 credits)
        </Button>
        <Button onClick={() => sendToDiscover("people")} disabled={!report || pending} className="w-full">
          <Search className="size-4" />
          Search this ICP in Discover · people
        </Button>
        <Button onClick={() => sendToDiscover("companies")} disabled={!report || pending} variant="secondary" className="w-full">
          <Search className="size-4" />
          Search this ICP in Discover · companies
        </Button>
        <div className="grid grid-cols-3 gap-1">
          <Button size="sm" variant="secondary" disabled={!report} onClick={exportHtml} className="text-xs">
            <Download className="size-3.5" /> HTML
          </Button>
          <Button size="sm" variant="secondary" disabled={!report} onClick={exportCsv} className="text-xs">
            <Download className="size-3.5" /> CSV
          </Button>
          <Button size="sm" variant="secondary" disabled={!report} onClick={exportJson} className="text-xs">
            <Download className="size-3.5" /> JSON
          </Button>
        </div>
        {!report && <p className="text-[11px] text-fg-muted">Last SparkToro report 0afc9e4d337d is on disk. Open it — no new credits.</p>}
      </div>

      <div>
        {!report && !pending && (
          <p className="text-sm text-fg-muted">
            We enrich each buyer, then score titles, seniority, industry, LinkedIn, stack, lookalikes, Reddit, and podcasts that match those industries — not your product’s Google autocomplete.
          </p>
        )}
        {pending && (
          <p className="text-sm text-fg-muted flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" /> Enriching buyers and loading the SparkToro report already paid for (no new credits).
          </p>
        )}
        {report && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-xl">{report.company.name}</h2>
                <p className="text-xs text-fg-muted">
                  {report.spend.weightedCustomers} paying people · {report.durationMs}ms
                  {report.sparkToro ? ` · SparkToro ${report.sparkToro.reportId}` : ""} · {report.sources.filter((s) => s.startsWith("sparktoro") || s.includes("enrich")).slice(0, 8).join(" · ")}
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                <Button size="sm" onClick={exportHtml}>
                  <Download className="size-3.5" /> Download HTML
                </Button>
                <Button size="sm" variant="secondary" onClick={exportCsv}>
                  CSV
                </Button>
                <Button size="sm" variant="secondary" onClick={exportJson}>
                  JSON
                </Button>
              </div>
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
                      <div key={s.name + s.who} className="rounded-lg border border-border p-3">
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
            {sec === "buyers" && (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-surface text-xs text-fg-muted">
                    <tr>
                      {["Buyer", "Title", "Company", "Industry", "Location", "ACV %"].map((h) => (
                        <th key={h} className="text-left font-medium px-3 py-2">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {report.buyers.map((b) => (
                      <tr key={b.email || b.domain}>
                        <td className="px-3 py-2">
                          <div className="font-medium">{b.name || "—"}</div>
                          <div className="text-xs text-fg-muted">{b.email}</div>
                        </td>
                        <td className="px-3 py-2">{b.title || b.role || "—"}</td>
                        <td className="px-3 py-2">
                          {b.linkedin ? (
                            <a href={b.linkedin} className="hover:underline" target="_blank" rel="noreferrer">
                              {b.company}
                            </a>
                          ) : (
                            b.company
                          )}
                        </td>
                        <td className="px-3 py-2">{b.industry || "—"}</td>
                        <td className="px-3 py-2">{b.location || "—"}</td>
                        <td className="px-3 py-2 tabular-nums">{b.sharePct}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {sec === "demo" && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold">Job titles (people who paid)</h3>
                <Rows rows={report.demographics.titles} empty="No buyer titles — add emails, not just domains" />
                <h3 className="text-sm font-semibold">SparkToro audience titles</h3>
                <Rows rows={report.demographics.audienceTitles} empty="—" />
                <h3 className="text-sm font-semibold">Function</h3>
                <Rows rows={report.demographics.functions} empty="—" />
                <h3 className="text-sm font-semibold">Seniority</h3>
                <Rows rows={report.demographics.seniority} empty="—" />
                <h3 className="text-sm font-semibold">Industry</h3>
                <Rows rows={report.demographics.industries} empty="—" />
                <h3 className="text-sm font-semibold">Company size</h3>
                <Rows rows={report.demographics.sizes} empty="—" />
                <h3 className="text-sm font-semibold">Age / gender / salary (SparkToro)</h3>
                <Rows rows={[...report.demographics.age, ...report.demographics.gender, ...report.demographics.salary]} empty="—" />
                <h3 className="text-sm font-semibold">Locations (paying people)</h3>
                <Rows rows={report.demographics.locations} empty="—" />
              </div>
            )}
            {sec === "social" && <Rows rows={report.social} empty="No social" />}
            {sec === "sites" && <Rows rows={report.websites} empty="No websites" />}
            {sec === "press" && <Rows rows={report.press} empty="No press" />}
            {sec === "nets" && <Rows rows={report.networks} empty="No networks" />}
            {sec === "yt" && <Rows rows={report.youtube} empty="No YouTube" />}
            {sec === "pods" && <Rows rows={report.podcasts} empty="No podcasts" />}
            {sec === "reddit" && <Rows rows={report.reddit} empty="No subreddits" />}
            {sec === "kw" && <Rows rows={report.keywords} empty="No keywords" />}
            {sec === "apps" && <Rows rows={report.apps} empty="No apps" />}
            {sec === "prompts" && <Rows rows={report.prompts} empty="No AI prompts" />}
            {sec === "likes" && <Rows rows={report.lookalikes} empty="No lookalikes from paying logos" />}
            {sec === "bio" && <Rows rows={report.bioPhrases} empty="No bio phrases" />}
            {sec === "tam" && (
              <div className="space-y-3">
                {report.tam ? (
                  <>
                    <p className="text-2xl font-display">{report.tam.estimated_population?.toLocaleString()} people</p>
                    <p className="text-sm text-fg-muted">
                      Market value {report.tam.currency} {report.tam.estimated_market_value?.toLocaleString()} · YoY {report.tam.year_over_year_growth_pct ?? 0}%
                    </p>
                    <p className="text-sm">{report.tam.rationale}</p>
                  </>
                ) : (
                  <p className="text-sm text-fg-muted">TAM is a SparkToro premium section — it will fill once the report is created.</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
