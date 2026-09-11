import { useMemo, useState } from "react";
import { Check, Copy, Terminal } from "lucide-react";
import { API_ENDPOINTS, API_GROUPS, type ApiEndpoint } from "@/lib/email-finder/api-catalog";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function host(): string {
  if (typeof window === "undefined") return "mailgraph.local";
  return window.location.host;
}

function fillCurl(e: ApiEndpoint): string {
  return e.curl.replace("{host}", host());
}

function tryUrl(e: ApiEndpoint, values: Record<string, string>): string {
  if (e.method !== "GET") return e.path;
  const u = new URL(e.path, typeof window === "undefined" ? "http://local" : window.location.origin);
  for (const p of e.params) {
    const v = values[p.name] ?? p.example ?? "";
    if (v) u.searchParams.set(p.name, v);
  }
  return `${u.pathname}${u.search}`;
}

export function ApiDocs() {
  const [activeId, setActiveId] = useState(API_ENDPOINTS[0]!.id);
  const ep = API_ENDPOINTS.find((e) => e.id === activeId) ?? API_ENDPOINTS[0]!;
  const [copied, setCopied] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [trying, setTrying] = useState(false);
  const [tryOut, setTryOut] = useState<string>("");

  const grouped = useMemo(() => {
    return API_GROUPS.map((g) => ({
      group: g,
      items: API_ENDPOINTS.filter((e) => e.group === g),
    }));
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(fillCurl(ep));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };

  const runTry = async () => {
    setTrying(true);
    setTryOut("");
    try {
      const merged: Record<string, string> = {};
      for (const p of ep.params) merged[p.name] = values[p.name] ?? p.example ?? "";
      if (ep.method === "GET") {
        const res = await fetch(tryUrl(ep, merged));
        const text = await res.text();
        try {
          setTryOut(JSON.stringify(JSON.parse(text), null, 2));
        } catch {
          setTryOut(text);
        }
      } else {
        const body: Record<string, unknown> = {};
        for (const p of ep.params) {
          const raw = merged[p.name];
          if (!raw) continue;
          if (p.type === "number") body[p.name] = Number(raw);
          else if (p.type.includes("[]")) body[p.name] = raw.split(",").map((s) => s.trim());
          else body[p.name] = raw;
        }
        const res = await fetch(ep.path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        try {
          setTryOut(JSON.stringify(JSON.parse(text), null, 2));
        } catch {
          setTryOut(text);
        }
      }
    } catch (err) {
      setTryOut(err instanceof Error ? err.message : "Request failed");
    } finally {
      setTrying(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
      <nav className="lg:sticky lg:top-20 self-start rounded-xl border border-border bg-surface p-3">
        <p className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
          Mailgraph API v2
        </p>
        {grouped.map((g) => (
          <div key={g.group} className="mb-3">
            <p className="px-2 py-1 text-[11px] font-medium text-fg-subtle">{g.group}</p>
            {g.items.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => {
                  setActiveId(e.id);
                  setTryOut("");
                  setValues({});
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                  e.id === ep.id ? "bg-surface-hover font-medium text-fg" : "text-fg-muted hover:bg-surface-hover",
                )}
              >
                <span
                  className={cn(
                    "w-10 shrink-0 font-mono text-[10px] font-semibold",
                    e.method === "GET" ? "text-success" : "text-accent",
                  )}
                >
                  {e.method}
                </span>
                <span className="truncate">{e.title}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <article className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "rounded-md px-2 py-0.5 font-mono text-xs font-semibold",
              ep.method === "GET" ? "bg-success-bg text-success" : "bg-warning-bg text-warning",
            )}
          >
            {ep.method}
          </span>
          <code className="font-mono text-sm text-fg">{ep.path}</code>
        </div>
        <h1 className="mt-3 font-display text-2xl font-semibold tracking-tight">{ep.title}</h1>
        <p className="mt-1 text-sm text-fg-muted">{ep.summary}</p>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-fg">{ep.description}</p>

        <section className="mt-8">
          <h2 className="text-sm font-semibold">Parameters</h2>
          {ep.params.length === 0 ? (
            <p className="mt-2 text-sm text-fg-muted">None.</p>
          ) : (
            <div className="mt-2 overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-left text-sm">
                <thead className="bg-surface-hover text-xs text-fg-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">In</th>
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 font-medium">Required</th>
                    <th className="px-3 py-2 font-medium">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {ep.params.map((p) => (
                    <tr key={p.name} className="border-t border-border">
                      <td className="px-3 py-2 font-mono text-xs">{p.name}</td>
                      <td className="px-3 py-2 text-fg-muted">{p.in}</td>
                      <td className="px-3 py-2 font-mono text-xs text-fg-muted">{p.type}</td>
                      <td className="px-3 py-2">{p.required ? "yes" : "no"}</td>
                      <td className="px-3 py-2 text-fg-muted">
                        {p.description}
                        {p.example ? (
                          <span className="ml-1 font-mono text-xs text-fg-subtle">e.g. {p.example}</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="mt-8">
          <h2 className="text-sm font-semibold">Response</h2>
          <div className="mt-2 overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface-hover text-xs text-fg-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Field</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                </tr>
              </thead>
              <tbody>
                {ep.response.map((f) => (
                  <tr key={f.field} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">{f.field}</td>
                    <td className="px-3 py-2 font-mono text-xs text-fg-muted">{f.type}</td>
                    <td className="px-3 py-2 text-fg-muted">{f.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-8">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">cURL</h2>
            <Button type="button" variant="secondary" size="sm" onClick={() => void copy()}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <pre className="mt-2 overflow-x-auto rounded-xl border border-border bg-fg px-4 py-3 font-mono text-xs text-primary-fg">
            {fillCurl(ep)}
          </pre>
        </section>

        <section className="mt-8 rounded-xl border border-border bg-surface p-4">
          <div className="flex items-center gap-2">
            <Terminal className="size-4 text-fg-muted" />
            <h2 className="text-sm font-semibold">Try it</h2>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {ep.params.map((p) => (
              <label key={p.name} className="block text-xs text-fg-muted">
                {p.name}
                {p.required ? " *" : ""}
                <Input
                  className="mt-1"
                  value={values[p.name] ?? p.example ?? ""}
                  placeholder={p.example ?? p.type}
                  onChange={(ev) =>
                    setValues((prev) => ({ ...prev, [p.name]: ev.target.value }))
                  }
                />
              </label>
            ))}
          </div>
          <Button type="button" className="mt-4" onClick={() => void runTry()} disabled={trying}>
            {trying ? "Running…" : "Send request"}
          </Button>
          {tryOut ? (
            <pre className="mt-4 max-h-96 overflow-auto rounded-lg border border-border bg-bg p-3 font-mono text-[11px] leading-relaxed">
              {tryOut}
            </pre>
          ) : null}
        </section>
      </article>
    </div>
  );
}
