import { useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  ShieldCheck,
  ShieldQuestion,
  User,
} from "lucide-react";
import { toast } from "sonner";
import type { DiscoveredEmail } from "@/lib/email-finder/crawl";
import type { WaterfallDomainResult } from "@/lib/email-finder/waterfall";
import { WaterfallTrail } from "./waterfall-trail";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Named = NonNullable<WaterfallDomainResult["people"]>[number];

/** Official LinkedIn Recruiter / Ads job functions (26). Hunter uses a different list. */
const DEPT_ORDER = [
  "Accounting",
  "Administrative",
  "Arts and Design",
  "Business Development",
  "Community and Social Services",
  "Consulting",
  "Education",
  "Engineering",
  "Entrepreneurship",
  "Finance",
  "Healthcare Services",
  "Human Resources",
  "Information Technology",
  "Legal",
  "Marketing",
  "Media and Communication",
  "Military and Protective Services",
  "Operations",
  "Product Management",
  "Program and Project Management",
  "Purchasing",
  "Quality Assurance",
  "Real Estate",
  "Research",
  "Sales",
  "Support",
  "Department unknown",
];

export function DomainResults({ result }: { result: WaterfallDomainResult }) {
  const [tab, setTab] = useState<"people" | "dm" | "roles">("people");
  const named = result.people ?? [];
  const people = result.emails.filter((e) => !e.isRoleBased);
  const roles = result.emails.filter((e) => e.isRoleBased);

  if (result.emails.length === 0 && !result.people?.length) {
    return (
      <div className="mx-auto mt-8 w-full max-w-3xl space-y-4">
        {result.waterfall?.length ? (
          <WaterfallTrail stages={result.waterfall} />
        ) : null}
        <div className="rounded-xl border border-border bg-surface shadow-sm px-6 py-10 text-center">
          <p className="text-base font-medium">
            No contacts found for {result.domain}
          </p>
          <p className="mt-2 text-sm text-fg-muted">
            Deep research included entity, registry, web, LinkedIn/GitHub/X/Crunchbase
            social graph, archive, and SMTP. Try another domain or find-by-name with a
            LinkedIn URL.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-6 w-full max-w-6xl space-y-4">
      {result.waterfall?.length ? (
        <WaterfallTrail stages={result.waterfall} />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <p className="font-medium">
          {named.length} live people
          {result.headcount ? ` · LinkedIn lists ${result.headcount}` : ""}
        </p>
        <p className="text-xs text-fg-subtle">{result.durationMs}ms</p>
      </div>

      <div className="grid lg:grid-cols-[1fr_320px] gap-4 items-start">
        <div className="rounded-xl border border-border bg-surface shadow-sm overflow-hidden">
          <div className="flex border-b border-border text-sm">
            {(
              [
                ["people", `${named.length} people`],
                [
                  "dm",
                  `${named.filter((p) => p.seniority === "decision").length} decision makers`,
                ],
                ["roles", `${roles.length} generic`],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn(
                  "px-4 py-2.5 font-medium",
                  tab === id
                    ? "border-b-2 border-accent text-fg"
                    : "text-fg-muted",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "roles" ? (
            <ul className="divide-y divide-border">
              {roles.map((e) => (
                <EmailRow key={e.email} item={e} />
              ))}
              {roles.length === 0 && (
                <li className="px-5 py-6 text-sm text-fg-muted">No role mailboxes</li>
              )}
            </ul>
          ) : (
            <PeopleByDept
              people={
                tab === "dm"
                  ? named.filter((p) => p.seniority === "decision")
                  : named
              }
            />
          )}
        </div>

        <aside className="space-y-4">
          <div className="rounded-xl border border-border bg-surface p-4 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              Company
            </p>
            <p className="font-medium">{result.companyName ?? result.domain}</p>
            {result.description && (
              <p className="text-sm text-fg-muted">{result.description}</p>
            )}
            {result.industry && (
              <p className="text-sm">Industry: {result.industry}</p>
            )}
            {result.hq && <p className="text-sm">Address: {result.hq}</p>}
            {result.companyType && (
              <p className="text-sm">Type: {result.companyType}</p>
            )}
            {result.headcount && <p className="text-sm">{result.headcount}</p>}
          </div>

          {result.technologies && result.technologies.length > 0 && (
            <div className="rounded-xl border border-border bg-surface p-4 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                Technologies
              </p>
              {result.technologies.map((t) => (
                <div key={t.name}>
                  <p className="text-[11px] text-fg-subtle">{t.category}</p>
                  <p className="text-sm font-medium">{t.name}</p>
                </div>
              ))}
            </div>
          )}

          {result.jobs && result.jobs.length > 0 && (
            <div className="rounded-xl border border-border bg-surface p-4 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                Current org · {result.jobs.length} open roles
              </p>
              <ul className="space-y-1.5 text-sm">
                {result.jobs.slice(0, 8).map((j) => (
                  <li key={`${j.title}-${j.location}`}>
                    <p className="font-medium">{j.title}</p>
                    <p className="text-xs text-fg-muted">
                      {[j.department, j.location].filter(Boolean).join(" · ")}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function PeopleByDept({ people }: { people: Named[] }) {
  const groups = new Map<string, Named[]>();
  for (const p of people) {
    const d = p.department || "Department unknown";
    const arr = groups.get(d) ?? [];
    arr.push(p);
    groups.set(d, arr);
  }
  const keys = [
    ...DEPT_ORDER.filter((k) => groups.has(k)),
    ...[...groups.keys()].filter((k) => !DEPT_ORDER.includes(k)),
  ];
  const decision = people.filter((p) => p.seniority === "decision");

  return (
    <div className="border-b border-border px-5 py-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
          {people.length} live · LinkedIn functions
        </p>
        {decision.length > 0 && (
          <span className="text-[11px] rounded-md bg-accent/10 text-accent px-2 py-0.5">
            {decision.length} decision makers
          </span>
        )}
      </div>
      {keys.map((dept) => {
        const rows = groups.get(dept)!;
        return (
          <div key={dept}>
            <p className="text-xs font-semibold uppercase tracking-wider text-fg-muted mb-2">
              {dept}{" "}
              <span className="font-normal text-fg-subtle">{rows.length}</span>
            </p>
            <ul className="space-y-1.5">
              {rows.map((p) => (
                <li
                  key={p.fullName + (p.sourceUrl ?? "")}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-bg px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <User className="size-3.5 text-accent shrink-0" />
                      <span className="font-medium text-sm">{p.fullName}</span>
                      {p.seniority === "decision" && (
                        <span className="text-[10px] uppercase tracking-wide text-accent">
                          DM
                        </span>
                      )}
                    </div>
                    <p className="pl-5 text-xs text-fg-muted truncate">
                      {[p.title, p.location].filter(Boolean).join(" · ") ||
                        "Title not on public card"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 text-xs shrink-0">
                    {p.sourceUrl && (
                      <a
                        href={p.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-accent hover:underline"
                      >
                        IN
                      </a>
                    )}
                    {p.email && (
                      <span className="text-fg-muted font-mono">{p.email}</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function EmailRow({ item }: { item: DiscoveredEmail }) {
  const [copied, setCopied] = useState(false);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
      <div className="min-w-0">
        <p className="font-mono text-sm truncate">{item.email}</p>
        <p className="text-xs text-fg-muted">
          {item.title || item.kind} · {item.confidence}%
        </p>
      </div>
      <div className="flex items-center gap-1">
        {item.status === "found" ? (
          <ShieldCheck className="size-4 text-accent" />
        ) : (
          <ShieldQuestion className="size-4 text-fg-subtle" />
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(item.email);
            setCopied(true);
            toast.success("Copied");
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
        {item.sources[0]?.url && (
          <a href={item.sources[0].url} target="_blank" rel="noreferrer">
            <ExternalLink className="size-3.5 text-fg-muted" />
          </a>
        )}
      </div>
    </li>
  );
}
