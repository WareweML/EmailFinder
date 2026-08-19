import { useState, useTransition } from "react";
import {
  Building2,
  CheckCircle2,
  LayoutGrid,
  Loader2,
  Mail,
  Search,
  User,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DomainResults } from "./domain-results";
import { ResultCard } from "./result-card";
import { StatusBadge } from "./status-badge";
import { ClayWorkspace } from "@/components/workspace/clay-workspace";
import { CompanySuggestInput } from "./company-suggest";
import {
  domainSearchFn,
  findEmailFn,
  verifyEmailFn,
} from "@/lib/email-finder/server";
import type {
  WaterfallDomainResult,
  WaterfallFindResult,
} from "@/lib/email-finder/waterfall";
import type { VerificationResult } from "@/lib/email-finder/types";
import { cn } from "@/lib/utils";

type Mode = "workspace" | "finder";
type TabId = "company" | "name" | "verify";

function readMode(): Mode {
  if (typeof window === "undefined") return "workspace";
  const q = new URLSearchParams(window.location.search).get("mode");
  if (q === "finder" || q === "workspace") return q;
  try {
    const s = sessionStorage.getItem("mailgraph-mode");
    if (s === "finder" || s === "workspace") return s;
  } catch {
    /* ignore */
  }
  return "workspace";
}

function writeMode(m: Mode) {
  try {
    sessionStorage.setItem("mailgraph-mode", m);
  } catch {
    /* ignore */
  }
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("mode", m);
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

export function FinderApp() {
  const [mode, setMode] = useState<Mode>("finder");
  const [tab, setTab] = useState<TabId>("company");
  const [pending, startTransition] = useTransition();

  const [domainQuery, setDomainQuery] = useState("");
  const [domainResult, setDomainResult] =
    useState<WaterfallDomainResult | null>(null);
  const [titleFilter, setTitleFilter] = useState("");
  const [domainSuggest, setDomainSuggest] = useState<{
    domain: string;
    label: string;
  } | null>(null);

  const [fullName, setFullName] = useState("");
  const [personDomain, setPersonDomain] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [findResult, setFindResult] = useState<WaterfallFindResult | null>(
    null,
  );

  const [emailToVerify, setEmailToVerify] = useState("");
  const [verifyResult, setVerifyResult] = useState<VerificationResult | null>(
    null,
  );

  const onDomainInput = (v: string) => {
    setDomainQuery(v);
    const cleaned = v
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]
      ?.split("?")[0];
    if (cleaned && cleaned.includes(".") && cleaned.length > 3) {
      const label = cleaned.split(".")[0] ?? cleaned;
      setDomainSuggest({
        domain: cleaned,
        label: label.charAt(0).toUpperCase() + label.slice(1),
      });
    } else {
      setDomainSuggest(null);
    }
  };

  const switchMode = (m: Mode) => {
    setMode(m);
    writeMode(m);
  };

  const runDomainSearch = (override?: string) => {
    const q = (override ?? domainQuery).trim();
    if (!q) {
      toast.error("Enter a company domain");
      return;
    }
    setDomainResult(null);
    startTransition(async () => {
      try {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Search timed out — try again")), 55000),
        );
        const res = (await Promise.race([
          domainSearchFn({
            data: {
              domain: q,
              verifyRoles: false,
              titleFilter: titleFilter || undefined,
            },
          }),
          timeout,
        ])) as WaterfallDomainResult;
        setDomainResult(res);
        const people =
          res.peopleCount ??
          res.emails.filter((e) => !e.isRoleBased).length;
        toast.success(
          res.emails.length || res.people?.length
            ? `${people} people · ${res.emails.length} emails`
            : `No contacts for ${res.domain}`,
        );
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Domain search failed");
      }
    });
  };

  const runNameFind = () => {
    if ((!fullName.trim() && !linkedinUrl.trim()) || !personDomain.trim()) {
      toast.error("Enter name (or LinkedIn URL) + domain");
      return;
    }
    startTransition(async () => {
      try {
        const res = await findEmailFn({
          data: {
            fullName: fullName.trim() || " ",
            domain: personDomain.trim(),
            linkedinUrl: linkedinUrl.trim() || undefined,
            skipSmtp: false,
          },
        });
        setFindResult(res as WaterfallFindResult);
        if (res.best) toast.success(`Found ${res.best.email}`);
        else toast.message("No confident match");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Find failed");
      }
    });
  };

  const runVerify = () => {
    if (!emailToVerify.trim()) {
      toast.error("Enter an email");
      return;
    }
    startTransition(async () => {
      try {
        const res = await verifyEmailFn({
          data: { email: emailToVerify.trim(), skipSmtp: false },
        });
        setVerifyResult(res);
        toast.success(`Status: ${res.status}`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Verify failed");
      }
    });
  };

  return (
    <div className="min-h-dvh surface-grid text-fg">
      <header className="border-b border-border bg-surface/90 backdrop-blur-sm sticky top-0 z-40">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-fg">
              <Mail className="size-4" />
            </div>
            <span className="font-display text-sm font-semibold tracking-tight">
              Mailgraph
            </span>
          </div>
          <div className="inline-flex rounded-lg border border-border bg-bg p-0.5">
            <button
              type="button"
              onClick={() => switchMode("workspace")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs sm:text-sm font-medium",
                mode === "workspace"
                  ? "bg-surface shadow-sm border border-border"
                  : "text-fg-muted",
              )}
            >
              <LayoutGrid className="size-3.5" />
              Workbook
            </button>
            <button
              type="button"
              onClick={() => switchMode("finder")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs sm:text-sm font-medium",
                mode === "finder"
                  ? "bg-surface shadow-sm border border-border"
                  : "text-fg-muted",
              )}
            >
              <Search className="size-3.5" />
              Finder
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-20 pt-8 sm:px-6 sm:pt-10">
        {mode === "workspace" ? (
          <ClayWorkspace />
        ) : (
          <>
            <div className="text-center max-w-2xl mx-auto">
              <p className="text-sm font-medium text-fg-muted">
                Single-shot waterfall
              </p>
              <h1 className="mt-2 font-display text-3xl sm:text-4xl font-semibold tracking-tight">
                Find email · company · LinkedIn
              </h1>
            </div>

            <div className="mt-8 flex justify-center">
              <div className="inline-flex rounded-lg border border-border bg-surface p-1 shadow-sm">
                {(
                  [
                    {
                      id: "company" as const,
                      label: "Company",
                      icon: Building2,
                    },
                    { id: "name" as const, label: "Name", icon: User },
                    {
                      id: "verify" as const,
                      label: "Verify",
                      icon: CheckCircle2,
                    },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTab(t.id)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-3 sm:px-4 py-2 text-sm font-medium",
                      tab === t.id
                        ? "bg-bg text-fg shadow-sm border border-border"
                        : "text-fg-muted hover:text-fg",
                    )}
                  >
                    <t.icon className="size-3.5" />
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {tab === "company" && (
              <div className="mt-8">
                <form
                  className="mx-auto max-w-3xl space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    runDomainSearch();
                  }}
                >
                  <div className="flex flex-col sm:flex-row rounded-xl border border-border bg-surface shadow-md overflow-hidden">
                    <div className="relative flex-1">
                      <Search className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 size-4 text-fg-subtle z-10" />
                      <CompanySuggestInput
                        value={domainQuery}
                        onChange={onDomainInput}
                        onPick={(s) => {
                          setDomainQuery(s.domain);
                          setDomainSuggest({
                            domain: s.domain,
                            label: s.name,
                          });
                          runDomainSearch(s.domain);
                        }}
                        placeholder="Type company name or domain…"
                        className="w-full"
                        inputClassName="h-14 w-full border-0 bg-transparent pl-11 pr-10 text-base focus:outline-none"
                      />
                    </div>
                    <Button
                      type="submit"
                      disabled={pending}
                      className="h-14 rounded-none sm:min-w-[180px]"
                      variant="secondary"
                    >
                      {pending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : null}
                      Deep research
                    </Button>
                  </div>
                  <Input
                    value={titleFilter}
                    onChange={(e) => setTitleFilter(e.target.value)}
                    placeholder="Optional title filter: CEO, engineer, sales…"
                    className="max-w-md"
                  />
                  {domainSuggest && !domainResult && !pending && (
                    <button
                      type="button"
                      onClick={() => {
                        setDomainQuery(domainSuggest.domain);
                        runDomainSearch(domainSuggest.domain);
                      }}
                      className="w-full flex items-center justify-between rounded-xl border border-border bg-surface px-4 py-3 text-left hover:bg-surface-hover"
                    >
                      <span className="font-medium">{domainSuggest.label}</span>
                      <span className="text-xs rounded bg-fg text-primary-fg px-2 py-0.5">
                        Research
                      </span>
                    </button>
                  )}
                </form>
                {pending && !domainResult && (
                  <div className="mx-auto mt-8 max-w-3xl rounded-xl border border-border bg-surface px-5 py-8 text-center">
                    <Loader2 className="size-6 animate-spin mx-auto text-accent" />
                    <p className="mt-3 text-sm">Multi-hop research…</p>
                  </div>
                )}
                {domainResult && <DomainResults result={domainResult} />}
              </div>
            )}

            {tab === "name" && (
              <div className="mt-8 mx-auto max-w-3xl space-y-6">
                <form
                  className="rounded-xl border border-border bg-surface p-5 space-y-4 shadow-md"
                  onSubmit={(e) => {
                    e.preventDefault();
                    runNameFind();
                  }}
                >
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label>Full name</Label>
                      <Input
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                        placeholder="Kumar Manaswi"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Company / domain</Label>
                      <CompanySuggestInput
                        value={personDomain}
                        onChange={setPersonDomain}
                        onPick={(s) => setPersonDomain(s.domain)}
                        placeholder="Type Stripe or stripe.com"
                        inputClassName="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>LinkedIn URL (optional)</Label>
                    <Input
                      value={linkedinUrl}
                      onChange={(e) => setLinkedinUrl(e.target.value)}
                      placeholder="https://linkedin.com/in/…"
                    />
                  </div>
                  <Button type="submit" disabled={pending} className="bg-accent text-accent-fg">
                    {pending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Search className="size-4" />
                    )}
                    Waterfall find
                  </Button>
                </form>
                {findResult && <ResultCard result={findResult} />}
              </div>
            )}

            {tab === "verify" && (
              <div className="mt-8 mx-auto max-w-3xl space-y-6">
                <form
                  className="rounded-xl border border-border bg-surface p-5 space-y-4 shadow-md"
                  onSubmit={(e) => {
                    e.preventDefault();
                    runVerify();
                  }}
                >
                  <div className="space-y-2">
                    <Label>Email</Label>
                    <Input
                      value={emailToVerify}
                      onChange={(e) => setEmailToVerify(e.target.value)}
                      placeholder="manaswi@warewe.com"
                    />
                  </div>
                  <Button type="submit" disabled={pending} className="bg-accent text-accent-fg">
                    {pending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="size-4" />
                    )}
                    Verify
                  </Button>
                </form>
                {verifyResult && (
                  <div className="rounded-xl border border-border bg-surface p-5 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-mono break-all">{verifyResult.email}</p>
                      <StatusBadge status={verifyResult.status} />
                    </div>
                    <div className="grid sm:grid-cols-2 gap-2 text-sm">
                      <KV k="MX" v={verifyResult.mxProvider ?? "—"} />
                      <KV
                        k="Catch-all"
                        v={verifyResult.isCatchAll ? "Yes" : "No"}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2 rounded-lg border border-border bg-bg px-3 py-2">
      <span className="text-fg-muted">{k}</span>
      <span className="font-medium">{v}</span>
    </div>
  );
}
