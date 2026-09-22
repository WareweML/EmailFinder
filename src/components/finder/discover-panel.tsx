import { useEffect, useState, useTransition } from "react";
import { Building2, Download, Loader2, RotateCcw, Search, User } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  COMPANY_SIZES,
  COMPANY_TYPES,
  GEO_COUNTRIES,
  INDUSTRIES,
  LANGUAGES,
  TENURE,
  YEARS_EXPERIENCE,
  LINKEDIN_FUNCTIONS,
} from "@/lib/email-finder/linkedin-facets";
import {
  discoverCompaniesFn,
  discoverCountFn,
  discoverPeopleFn,
  enrichPeopleFn,
} from "@/lib/email-finder/server";
import {
  clearIcpDiscoverAutoSearch,
  ICP_DISCOVER_EVENT,
  readIcpDiscoverQuery,
} from "@/lib/email-finder/icp-discover-bridge";
import type { DiscoverFilterState, IcpDiscoverQuery } from "@/lib/email-finder/icp-to-discover";
import { cn } from "@/lib/utils";

type Tab = "people" | "companies";

export function DiscoverPanel() {
  const [tab, setTab] = useState<Tab>("people");
  const [listTab, setListTab] = useState<"all" | "dm">("all");
  const [pending, start] = useTransition();
  const [total, setTotal] = useState<number | null>(null);
  const [ms, setMs] = useState<number | null>(null);
  const [detail, setDetail] = useState("");

  const [keywords, setKeywords] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [title, setTitle] = useState("");
  const [pastTitle, setPastTitle] = useState("");
  const [skills, setSkills] = useState("");
  const [school, setSchool] = useState("");
  const [language, setLanguage] = useState("");
  const [yearsExp, setYearsExp] = useState("");
  const [tenure, setTenure] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [pastCompanyName, setPastCompanyName] = useState("");
  const [pastCompanyId, setPastCompanyId] = useState("");
  const [companyKeywords, setCompanyKeywords] = useState("");
  const [domain, setDomain] = useState("");
  const [geoId, setGeoId] = useState("");
  const [hqGeoId, setHqGeoId] = useState("");
  const [industryId, setIndustryId] = useState("");
  const [sizeId, setSizeId] = useState("");
  const [companyType, setCompanyType] = useState("");
  const [revenueBand, setRevenueBand] = useState("");
  const [growthBand, setGrowthBand] = useState("");
  const [hiringOnly, setHiringOnly] = useState(false);
  const [icpMeta, setIcpMeta] = useState<{ source: string; rationale: Record<string, string> } | null>(null);

  const [people, setPeople] = useState<
    Array<{
      name: string;
      title?: string;
      location?: string;
      url: string;
      source?: string;
      company?: string;
      domain?: string;
      linkedinUrl?: string;
      department?: string;
      seniority?: "decision" | "ic";
    }>
  >([]);
  const [companies, setCompanies] = useState<
    Array<{
      name: string;
      industry?: string;
      location?: string;
      url: string;
      companyId?: string;
      headcount?: number;
      headcountGrowthPct?: number;
      growthSource?: string;
      revenueLabel?: string;
      revenueSource?: string;
      jobsOpen?: number;
    }>
  >([]);

  const payload = {
    keywords,
    firstName,
    lastName,
    title,
    pastTitle,
    skills,
    school,
    language,
    yearsExp,
    tenure,
    companyId,
    companyName,
    pastCompanyId,
    pastCompanyName,
    companyKeywords,
    domain,
    geoId,
    hqGeoId,
    industryId,
    sizeId,
    companyType,
    revenueBand,
    growthBand,
    hiringOnly,
  };

  function applyFilters(f: DiscoverFilterState) {
    setKeywords(f.keywords);
    setFirstName(f.firstName);
    setLastName(f.lastName);
    setTitle(f.title);
    setPastTitle(f.pastTitle);
    setSkills(f.skills);
    setSchool(f.school);
    setLanguage(f.language);
    setYearsExp(f.yearsExp);
    setTenure(f.tenure);
    setCompanyName(f.companyName);
    setCompanyId(f.companyId);
    setPastCompanyName(f.pastCompanyName);
    setPastCompanyId(f.pastCompanyId);
    setCompanyKeywords(f.companyKeywords);
    setDomain(f.domain);
    setGeoId(f.geoId);
    setHqGeoId(f.hqGeoId);
    setIndustryId(f.industryId);
    setSizeId(f.sizeId);
    setCompanyType(f.companyType);
    setRevenueBand(f.revenueBand);
    setGrowthBand(f.growthBand);
    setHiringOnly(f.hiringOnly);
  }

  function ingestQuery(q: IcpDiscoverQuery, runSearch: boolean) {
    applyFilters(q.filters);
    setTab(q.kind);
    setIcpMeta({ source: q.source, rationale: q.rationale });
    if (runSearch && q.autoSearch) {
      searchWith(q.kind, q.filters);
      clearIcpDiscoverAutoSearch();
    }
  }

  useEffect(() => {
    const q = readIcpDiscoverQuery();
    if (q) ingestQuery(q, Boolean(q.autoSearch));
    const on = (e: Event) => {
      const next = (e as CustomEvent<IcpDiscoverQuery>).detail || readIcpDiscoverQuery();
      if (next) ingestQuery(next, Boolean(next.autoSearch));
    };
    window.addEventListener(ICP_DISCOVER_EVENT, on);
    return () => window.removeEventListener(ICP_DISCOVER_EVENT, on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function reset() {
    setKeywords("");
    setFirstName("");
    setLastName("");
    setTitle("");
    setPastTitle("");
    setSkills("");
    setSchool("");
    setLanguage("");
    setYearsExp("");
    setTenure("");
    setCompanyName("");
    setCompanyId("");
    setPastCompanyName("");
    setPastCompanyId("");
    setCompanyKeywords("");
    setDomain("");
    setGeoId("");
    setHqGeoId("");
    setIndustryId("");
    setSizeId("");
    setCompanyType("");
    setRevenueBand("");
    setGrowthBand("");
    setHiringOnly(false);
    setTotal(null);
    setPeople([]);
    setCompanies([]);
    setDetail("");
    setIcpMeta(null);
  }

  function searchWith(kind: Tab, f: typeof payload) {
    start(async () => {
      try {
        if (kind === "people") {
          const r = await discoverPeopleFn({ data: { ...f, pages: 2 } });
          setPeople(r.hits);
          setCompanies([]);
          setTotal(r.total);
          setMs(r.ms);
          setDetail(r.detail);
          toast[r.hits.length ? "success" : "error"](
            r.hits.length
              ? `${r.hits.length} named · ${r.total.toLocaleString()} on LinkedIn · ${r.ms}ms`
              : r.detail || "No named people matched",
          );
        } else {
          const r = await discoverCompaniesFn({
            data: { ...f, pages: 8, count: 10 },
          });
          setCompanies(r.hits);
          setPeople([]);
          setTotal(r.total);
          setMs(r.ms);
          setDetail(r.detail);
          toast.success(`${r.hits.length} companies · ${r.total.toLocaleString()} · ${r.ms}ms`);
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Search failed");
      }
    });
  }

  function count() {
    start(async () => {
      try {
        const r = await discoverCountFn({ data: { kind: tab, ...payload } });
        setTotal(r.total);
        setMs(r.ms);
        setDetail(r.detail);
        toast.success(`${r.total.toLocaleString()} live on LinkedIn · ${r.ms}ms`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Count failed");
      }
    });
  }

  function search() {
    searchWith(tab, payload);
  }

  function csvCell(v: string | undefined) {
    const s = v ?? "";
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function exportRows() {
    start(async () => {
      try {
        let rows = people;
        if (people.length) {
          toast.info("Resolving missing LinkedIn fields…");
          const r = await enrichPeopleFn({ data: { people } });
          rows = r.hits;
          setPeople(r.hits);
        }
        const header = [
          "Name",
          "Position",
          "Company",
          "Domain",
          "Location",
          "Function",
          "Seniority",
          "LinkedIn",
        ];
        const lines = [header.join(",")];
        if (rows.length) {
          for (const p of rows) {
            lines.push(
              [
                csvCell(p.name),
                csvCell(p.title),
                csvCell(p.company),
                csvCell(p.domain),
                csvCell(p.location),
                csvCell(p.department),
                csvCell(p.seniority === "decision" ? "decision" : "ic"),
                csvCell(p.linkedinUrl || p.url),
              ].join(","),
            );
          }
        } else {
          for (const c of companies) {
            lines.push(
              [
                csvCell(c.name),
                csvCell(c.industry),
                csvCell(c.name),
                csvCell(""),
                csvCell(c.location),
                csvCell(c.url),
              ].join(","),
            );
          }
        }
        const blob = new Blob(["\uFEFF" + lines.join("\n")], {
          type: "text/csv;charset=utf-8",
        });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `mailgraph-${rows.length ? "people" : "companies"}-${Date.now()}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast.success(`Exported ${rows.length || companies.length} rows`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Export failed");
      }
    });
  }

  return (
    <div className="mx-auto mt-6 grid w-full max-w-6xl gap-4 lg:grid-cols-[340px_1fr]">
      <aside className="rounded-xl border border-border bg-surface p-4 space-y-3 max-h-[80vh] overflow-y-auto">
        <div className="flex rounded-lg bg-bg p-1 text-sm">
          <button
            type="button"
            onClick={() => setTab("people")}
            className={cn(
              "flex-1 rounded-md py-1.5 font-medium",
              tab === "people" ? "bg-surface shadow-sm" : "text-fg-muted",
            )}
          >
            <User className="inline size-3.5 mr-1" />
            Profiles
          </button>
          <button
            type="button"
            onClick={() => setTab("companies")}
            className={cn(
              "flex-1 rounded-md py-1.5 font-medium",
              tab === "companies" ? "bg-surface shadow-sm" : "text-fg-muted",
            )}
          >
            <Building2 className="inline size-3.5 mr-1" />
            Companies
          </button>
        </div>
        {icpMeta && (
          <div className="rounded-lg border border-border bg-bg px-3 py-2 space-y-1">
            <p className="text-[11px] font-medium">ICP filters · {icpMeta.source}</p>
            <p className="text-[11px] text-fg-muted leading-snug">
              {Object.entries(icpMeta.rationale)
                .slice(0, 8)
                .map(([k, v]) => `${k}: ${v}`)
                .join(" · ")}
            </p>
          </div>
        )}

        {tab === "people" ? (
          <>
            <Field label="First name" value={firstName} onChange={setFirstName} />
            <Field label="Last name" value={lastName} onChange={setLastName} />
            <Field label="Keywords" value={keywords} onChange={setKeywords} />
            <Field label="Current job title" value={title} onChange={setTitle} />
            <Field label="Past job title" value={pastTitle} onChange={setPastTitle} />
            <Field
              label="Current company"
              value={companyName}
              onChange={setCompanyName}
              placeholder="Company name"
            />
            <Field
              label="Current company ID"
              value={companyId}
              onChange={setCompanyId}
              placeholder="LinkedIn company ID"
            />
            <Select
              label="Time in current company"
              value={tenure}
              onChange={setTenure}
              options={TENURE}
            />
            <Field
              label="Past company"
              value={pastCompanyName}
              onChange={setPastCompanyName}
            />
            <Select
              label="Person location"
              value={geoId}
              onChange={setGeoId}
              options={GEO_COUNTRIES}
            />
            <Field label="Skills" value={skills} onChange={setSkills} />
            <Select
              label="Languages"
              value={language}
              onChange={setLanguage}
              options={LANGUAGES}
            />
            <Field label="School" value={school} onChange={setSchool} />
            <Select
              label="Total years of experience"
              value={yearsExp}
              onChange={setYearsExp}
              options={YEARS_EXPERIENCE}
            />
            <p className="text-[10px] uppercase tracking-wider text-fg-subtle pt-1">
              Company
            </p>
            <Field
              label="Company keywords"
              value={companyKeywords}
              onChange={setCompanyKeywords}
            />
            <Select
              label="Company HQ location"
              value={hqGeoId}
              onChange={setHqGeoId}
              options={GEO_COUNTRIES}
            />
            <Select
              label="Headcount"
              value={sizeId}
              onChange={setSizeId}
              options={COMPANY_SIZES}
            />
            <Select
              label="Industry"
              value={industryId}
              onChange={setIndustryId}
              options={INDUSTRIES}
            />
            <Select
              label="Type"
              value={companyType}
              onChange={setCompanyType}
              options={COMPANY_TYPES}
            />
            <Select
              label="Revenue"
              value={revenueBand}
              onChange={setRevenueBand}
              options={[
                { id: "lt10m", label: "< $10M" },
                { id: "10m50m", label: "$10–50M" },
                { id: "50m250m", label: "$50–250M" },
                { id: "250m1b", label: "$250M–$1B" },
                { id: "1bplus", label: "$1B+" },
              ]}
            />
            <Select
              label="Headcount growth (%)"
              value={growthBand}
              onChange={setGrowthBand}
              options={[
                { id: "declining", label: "Declining" },
                { id: "0to10", label: "0–10%" },
                { id: "10to25", label: "10–25%" },
                { id: "25plus", label: "25%+" },
              ]}
            />
            <Field
              label="Company domain"
              value={domain}
              onChange={setDomain}
              placeholder="example.com"
            />
          </>
        ) : (
          <>
            <Field label="Keywords" value={keywords} onChange={setKeywords} />
            <Field
              label="Company name"
              value={companyName}
              onChange={setCompanyName}
            />
            <Field
              label="Company ID"
              value={companyId}
              onChange={setCompanyId}
              placeholder="LinkedIn company ID"
            />
            <Select
              label="Industry"
              value={industryId}
              onChange={setIndustryId}
              options={INDUSTRIES}
            />
            <Select
              label="Type"
              value={companyType}
              onChange={setCompanyType}
              options={COMPANY_TYPES}
            />
            <Select
              label="Revenue"
              value={revenueBand}
              onChange={setRevenueBand}
              options={[
                { id: "lt10m", label: "< $10M" },
                { id: "10m50m", label: "$10–50M" },
                { id: "50m250m", label: "$50–250M" },
                { id: "250m1b", label: "$250M–$1B" },
                { id: "1bplus", label: "$1B+" },
              ]}
            />
            <Select
              label="Headcount growth (%)"
              value={growthBand}
              onChange={setGrowthBand}
              options={[
                { id: "declining", label: "Declining" },
                { id: "0to10", label: "0–10%" },
                { id: "10to25", label: "10–25%" },
                { id: "25plus", label: "25%+" },
              ]}
            />
            <Select
              label="Headcount"
              value={sizeId}
              onChange={setSizeId}
              options={COMPANY_SIZES}
            />
            <Select
              label="Company HQ location"
              value={hqGeoId}
              onChange={setHqGeoId}
              options={GEO_COUNTRIES}
            />
            <Field
              label="Company domain"
              value={domain}
              onChange={setDomain}
              placeholder="example.com"
            />
            <label className="flex items-center gap-2 text-xs text-fg-muted pt-1">
              <input
                type="checkbox"
                checked={hiringOnly}
                onChange={(e) => setHiringOnly(e.target.checked)}
              />
              Has open jobs (live LinkedIn)
            </label>
          </>
        )}

        <Button
          type="button"
          variant="secondary"
          className="w-full"
          disabled={pending}
          onClick={count}
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Count results (free)
        </Button>
        <Button type="button" className="w-full" disabled={pending} onClick={search}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
          Search {tab === "people" ? "people" : "companies"}
        </Button>
        <button
          type="button"
          onClick={reset}
          className="w-full text-xs text-fg-muted hover:text-fg inline-flex items-center justify-center gap-1"
        >
          <RotateCcw className="size-3" /> Reset filters
        </button>
        {total != null && (
          <p className="text-xs text-fg-muted text-center">
            {total.toLocaleString()} on LinkedIn
            {ms != null ? ` · ${ms}ms` : ""} · {detail}
          </p>
        )}
      </aside>

      <section className="rounded-xl border border-border bg-surface overflow-hidden min-h-[420px]">
        <div className="border-b border-border px-4 py-2 text-xs text-fg-muted flex justify-between items-center gap-2">
          <span>
            {people.length
              ? `${people.length.toLocaleString()} named`
              : companies.length
                ? `${companies.length} companies`
                : "No results yet"}
          </span>
          <span className="flex items-center gap-3">
            {total != null && <span>{total.toLocaleString()} match the filters</span>}
            {(people.length > 0 || companies.length > 0) && (
              <button
                type="button"
                onClick={exportRows}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-fg hover:bg-surface-2"
              >
                <Download className="size-3" />
                Export CSV
              </button>
            )}
          </span>
        </div>
        {people.length === 0 && companies.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm text-fg-muted">
            People search uses the ApiAlt LinkedIn API — no personal Sales Nav
            cookies. Directory pages (ContactOut, “email & phone number”) are
            not people. Revenue, headcount, and hiring filters go through
            Sales Navigator on ApiAlt.
          </div>
        ) : people.length > 0 ? (
          <DiscoverPeopleList people={people} listTab={listTab} onTab={setListTab} />
        ) : (
          <ul className="divide-y divide-border max-h-[70vh] overflow-y-auto">
            {companies.map((c) => (
              <li key={c.url} className="px-4 py-3">
                <a
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium hover:text-accent"
                >
                  {c.name}
                </a>
                <p className="text-xs text-fg-muted">
                  {[
                    c.industry,
                    c.location,
                    c.companyId && `ID ${c.companyId}`,
                    c.headcount && `${c.headcount.toLocaleString()} staff`,
                    c.headcountGrowthPct != null &&
                      `${c.headcountGrowthPct > 0 ? "+" : ""}${c.headcountGrowthPct}% ${c.growthSource ?? ""}`.trim(),
                    c.revenueLabel && `${c.revenueLabel}${c.revenueSource ? ` · ${c.revenueSource}` : ""}`,
                    c.jobsOpen != null && `${c.jobsOpen} open jobs`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

type PersonRow = {
  name: string;
  title?: string;
  location?: string;
  url: string;
  source?: string;
  company?: string;
  domain?: string;
  linkedinUrl?: string;
  department?: string;
  seniority?: "decision" | "ic";
};

function DiscoverPeopleList({
  people,
  listTab,
  onTab,
}: {
  people: PersonRow[];
  listTab: "all" | "dm";
  onTab: (t: "all" | "dm") => void;
}) {
  const decision = people.filter((p) => p.seniority === "decision");
  const shown = listTab === "dm" ? decision : people;
  const groups = new Map<string, PersonRow[]>();
  for (const p of shown) {
    const d = p.department || "Department unknown";
    const arr = groups.get(d) ?? [];
    arr.push(p);
    groups.set(d, arr);
  }
  const keys = [
    ...LINKEDIN_FUNCTIONS.filter((k) => groups.has(k)),
    ...[...groups.keys()].filter((k) => !LINKEDIN_FUNCTIONS.includes(k as (typeof LINKEDIN_FUNCTIONS)[number])),
  ];

  return (
    <div className="max-h-[70vh] overflow-auto">
      <div className="sticky top-0 z-10 bg-surface border-b border-border px-3 py-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onTab("all")}
          className={cn(
            "text-xs rounded-md px-2 py-1",
            listTab === "all" ? "bg-accent/10 text-accent font-medium" : "text-fg-muted",
          )}
        >
          {people.length.toLocaleString()} people
        </button>
        <button
          type="button"
          onClick={() => onTab("dm")}
          className={cn(
            "text-xs rounded-md px-2 py-1",
            listTab === "dm" ? "bg-accent/10 text-accent font-medium" : "text-fg-muted",
          )}
        >
          {decision.length.toLocaleString()} decision makers
        </button>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-fg-subtle">
          LinkedIn functions
        </span>
      </div>
      {keys.map((dept) => {
        const rows = groups.get(dept)!;
        return (
          <div key={dept} className="border-b border-border">
            <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-muted bg-surface-2">
              {dept} <span className="font-normal text-fg-subtle">{rows.length}</span>
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-fg-subtle">
                  <th className="text-left font-medium px-3 py-1">Name</th>
                  <th className="text-left font-medium px-3 py-1">Position</th>
                  <th className="text-left font-medium px-3 py-1">Company</th>
                  <th className="text-left font-medium px-3 py-1">Domain</th>
                  <th className="text-left font-medium px-3 py-1">Location</th>
                  <th className="text-left font-medium px-3 py-1">LinkedIn</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((p) => (
                  <tr key={p.url} className="hover:bg-surface-2/60">
                    <td className="px-3 py-2 font-medium whitespace-nowrap">
                      {p.name}
                      {p.seniority === "decision" && (
                        <span className="ml-1 text-[10px] uppercase text-accent">DM</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-fg-muted">{p.title || "—"}</td>
                    <td className="px-3 py-2">{p.company || "—"}</td>
                    <td className="px-3 py-2 font-mono text-xs">{p.domain || "—"}</td>
                    <td className="px-3 py-2 text-fg-muted">{p.location || "—"}</td>
                    <td className="px-3 py-2">
                      {p.linkedinUrl ? (
                        <a
                          href={p.linkedinUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent hover:underline text-xs"
                        >
                          Profile
                        </a>
                      ) : (
                        <a
                          href={p.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-fg-muted hover:underline text-xs"
                        >
                          Source
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-fg-muted">{label}</Label>
      <Input
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ id: string; label: string }>;
}) {
  const seen = new Set<string>();
  return (
    <div className="space-y-1">
      <Label className="text-xs text-fg-muted">{label}</Label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-border bg-bg px-2 py-2 text-sm"
      >
        <option value="">Any</option>
        {options.map((o) => {
          if (seen.has(o.id)) return null;
          seen.add(o.id);
          return (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          );
        })}
      </select>
    </div>
  );
}
