import { useEffect, useMemo, useState, useTransition } from "react";
import { Download, Loader2, Play, Plus, Radio, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteSignalMonitorFn,
  listSignalEventsFn,
  listSignalMonitorsFn,
  runSignalMonitorFn,
  saveSignalMonitorFn,
} from "@/lib/email-finder/server";
import { SIGNAL_CATALOG, type SignalEvent, type SignalKind, type SignalMonitor, type SignalTarget } from "@/lib/email-finder/signals-catalog";
import { cn } from "@/lib/utils";

const GROUPS = [...new Set(SIGNAL_CATALOG.map((c) => c.group))];

function needsUrl(k: SignalKind) {
  return k === "rss" || k === "phantombuster" || k === "apify";
}
function needsLocation(k: SignalKind) {
  return k === "maps" || k === "openmart";
}

export function SignalsPanel() {
  const [kind, setKind] = useState<SignalKind>("topic_intent");
  const [target, setTarget] = useState<SignalTarget>("companies");
  const [name, setName] = useState("");
  const [entities, setEntities] = useState("ghd.com\nstripe.com");
  const [topics, setTopics] = useState("AI\ncloud cost\nkubernetes");
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [location, setLocation] = useState("");
  const [monitors, setMonitors] = useState<SignalMonitor[]>([]);
  const [events, setEvents] = useState<SignalEvent[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [ms, setMs] = useState<number | null>(null);

  const meta = SIGNAL_CATALOG.find((c) => c.id === kind)!;

  async function refresh() {
    const r = await listSignalMonitorsFn({ data: {} });
    setMonitors(r.monitors);
  }

  useEffect(() => {
    refresh().catch(() => undefined);
  }, []);

  const grouped = useMemo(
    () => GROUPS.map((g) => ({ group: g, items: SIGNAL_CATALOG.filter((c) => c.group === g) })),
    [],
  );

  function saveAndRun() {
    const list = entities.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    if (!needsUrl(kind) && !needsLocation(kind) && !list.length && !query.trim()) {
      toast.error("Add companies / people (one per line)");
      return;
    }
    if (needsUrl(kind) && !url.trim()) {
      toast.error("Paste the feed / dataset URL");
      return;
    }
    if (needsLocation(kind) && !location.trim()) {
      toast.error("Enter a city / area");
      return;
    }
    start(async () => {
      try {
        const saved = await saveSignalMonitorFn({
          data: {
            name: name || meta.label,
            kind,
            target,
            entities: list,
            topics: topics.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean),
            query: query.trim() || undefined,
            url: url.trim() || undefined,
            location: location.trim() || undefined,
          },
        });
        setActiveId(saved.monitor.id);
        await refresh();
        const ran = await runSignalMonitorFn({ data: { id: saved.monitor.id } });
        setEvents(ran.events);
        setMs(ran.ms);
        toast.success(`${ran.events.length} events · ${ran.ms}ms`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Run failed");
      }
    });
  }

  function runExisting(id: string) {
    setActiveId(id);
    start(async () => {
      try {
        const ran = await runSignalMonitorFn({ data: { id } });
        setEvents(ran.events);
        setMs(ran.ms);
        await refresh();
        toast.success(`${ran.events.length} events · ${ran.ms}ms`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Run failed");
      }
    });
  }

  function loadHistory(id: string) {
    setActiveId(id);
    start(async () => {
      const r = await listSignalEventsFn({ data: { monitorId: id } });
      setEvents(r.events);
    });
  }

  function remove(id: string) {
    start(async () => {
      await deleteSignalMonitorFn({ data: { id } });
      if (activeId === id) setEvents([]);
      await refresh();
    });
  }

  function exportCsv() {
    const header = "entity,kind,title,url,source,topic,spike,score,happenedAt";
    const rows = events.map((e) =>
      [e.entity, e.kind, e.title, e.url, e.source, e.topic ?? "", e.spike ? "spike" : "", e.score ?? "", e.happenedAt ?? ""]
        .map((x) => `"${String(x).replace(/"/g, '""')}"`)
        .join(","),
    );
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "mailgraph-signals.csv";
    a.click();
  }

  return (
    <div className="grid lg:grid-cols-[280px_1fr] gap-6">
      <div className="space-y-5">
        {grouped.map((g) => (
          <div key={g.group}>
            <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-2">{g.group}</p>
            <div className="space-y-1.5">
              {g.items.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setKind(c.id)}
                  className={cn(
                    "w-full text-left rounded-lg border px-3 py-2.5 text-sm flex items-start justify-between gap-2",
                    kind === c.id ? "border-fg bg-surface shadow-sm" : "border-border hover:border-fg/40",
                  )}
                >
                  <span>
                    <span className="font-medium block">{c.label}</span>
                    <span className="text-xs text-fg-muted line-clamp-2">{c.hint}</span>
                  </span>
                  <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-fg-muted">
                    {c.cost}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-4">
        <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Radio className="size-4" />
            <h2 className="font-medium">{meta.label}</h2>
          </div>
          <p className="text-sm text-fg-muted">{meta.hint}</p>

          {(kind === "topic_intent" || kind === "job_change" || kind === "new_hire" || kind === "promotion") && (
            <div className="inline-flex rounded-md border border-border p-0.5">
              {(["companies", "people"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTarget(t)}
                  className={cn(
                    "px-3 py-1 text-xs rounded capitalize",
                    target === t ? "bg-bg shadow-sm" : "text-fg-muted",
                  )}
                >
                  Monitor {t}
                </button>
              ))}
            </div>
          )}

          <div>
            <Label>Monitor name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={meta.label} />
          </div>

          {!needsUrl(kind) && !needsLocation(kind) && kind !== "google_search" && (
            <div>
              <Label>{target === "people" ? "People (one per line)" : "Companies / domains (one per line)"}</Label>
              <Textarea value={entities} onChange={(e) => setEntities(e.target.value)} rows={4} />
            </div>
          )}

          {kind === "topic_intent" && (
            <div>
              <Label>Topics to watch</Label>
              <Textarea value={topics} onChange={(e) => setTopics(e.target.value)} rows={3} />
            </div>
          )}

          {(kind === "google_search" || kind === "maps" || kind === "openmart") && (
            <div>
              <Label>{kind === "google_search" ? "Google query" : "What to find"}</Label>
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="dentists · kubernetes hiring · …" />
            </div>
          )}

          {needsLocation(kind) && (
            <div>
              <Label>Location</Label>
              <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Austin, TX" />
            </div>
          )}

          {needsUrl(kind) && (
            <div>
              <Label>{kind === "rss" ? "RSS / Atom URL" : "JSON dataset URL"}</Label>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
            </div>
          )}

          <Button onClick={saveAndRun} disabled={pending}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Save & run
          </Button>
        </div>

        {monitors.length > 0 && (
          <div className="rounded-xl border border-border divide-y divide-border">
            {monitors.map((m) => (
              <div key={m.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <button type="button" className="flex-1 text-left" onClick={() => loadHistory(m.id)}>
                  <span className="font-medium">{m.name}</span>
                  <span className="text-fg-muted ml-2 text-xs">{m.kind}</span>
                </button>
                <Button size="sm" variant="secondary" onClick={() => runExisting(m.id)} disabled={pending}>
                  <Play className="size-3.5" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => remove(m.id)}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between">
          <p className="text-sm text-fg-muted">
            {events.length} events{ms != null ? ` · ${ms}ms` : ""}
          </p>
          {events.length > 0 && (
            <Button size="sm" variant="secondary" onClick={exportCsv}>
              <Download className="size-3.5" /> CSV
            </Button>
          )}
        </div>

        <div className="space-y-2">
          {events.map((e) => (
            <a
              key={e.id}
              href={e.url || undefined}
              target="_blank"
              rel="noreferrer"
              className="block rounded-lg border border-border bg-surface px-3 py-2.5 hover:border-fg/40"
            >
              <div className="flex items-center gap-2 text-xs text-fg-muted">
                <span className="font-medium text-fg">{e.entity}</span>
                {e.topic && <span>#{e.topic}</span>}
                {e.spike && (
                  <span className="rounded-full bg-amber-100 text-amber-800 px-1.5 py-0.5 text-[10px] font-semibold">
                    SPIKE
                  </span>
                )}
                <span className="ml-auto">{e.source}</span>
              </div>
              <p className="text-sm font-medium mt-0.5">{e.title}</p>
              {e.snippet && <p className="text-xs text-fg-muted line-clamp-2 mt-0.5">{e.snippet}</p>}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
