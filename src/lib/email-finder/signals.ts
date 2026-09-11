/**
 * Live GTM signals. Runners fan out to free sources in signals-sources.ts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SignalEvent, SignalMonitor } from "./signals-catalog";
import type { SourceHit } from "./signals-sources";

export type { SignalEvent, SignalKind, SignalMonitor, SignalTarget } from "./signals-catalog";
export { SIGNAL_CATALOG } from "./signals-catalog";

const PATH = "/workspace/data/signals.json";

type Db = { monitors: SignalMonitor[]; events: SignalEvent[] };

function load(): Db {
  try {
    if (!existsSync(PATH)) return { monitors: [], events: [] };
    const raw = JSON.parse(readFileSync(PATH, "utf8")) as Db;
    return { monitors: raw.monitors ?? [], events: raw.events ?? [] };
  } catch {
    return { monitors: [], events: [] };
  }
}

function save(db: Db) {
  mkdirSync(dirname(PATH), { recursive: true });
  writeFileSync(PATH, JSON.stringify({ monitors: db.monitors, events: db.events.slice(-4000) }));
}

export function listMonitors(): SignalMonitor[] {
  return load().monitors.sort((a, b) => b.createdAt - a.createdAt);
}

export function listEvents(monitorId?: string, limit = 200): SignalEvent[] {
  const ev = load().events.filter((e) => !monitorId || e.monitorId === monitorId);
  return ev.slice(-limit).reverse();
}

export function upsertMonitor(input: Omit<SignalMonitor, "id" | "createdAt"> & { id?: string }): SignalMonitor {
  const db = load();
  const id = input.id ?? `sig_${Date.now().toString(36)}`;
  const next: SignalMonitor = {
    id,
    name: input.name.trim() || input.kind,
    kind: input.kind,
    target: input.target ?? "companies",
    entities: (input.entities ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 50),
    topics: (input.topics ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 20),
    query: input.query?.trim() || undefined,
    url: input.url?.trim() || undefined,
    location: input.location?.trim() || undefined,
    createdAt: db.monitors.find((m) => m.id === id)?.createdAt ?? Date.now(),
    lastRunAt: db.monitors.find((m) => m.id === id)?.lastRunAt,
  };
  db.monitors = [next, ...db.monitors.filter((m) => m.id !== id)];
  save(db);
  return next;
}

export function deleteMonitor(id: string) {
  const db = load();
  db.monitors = db.monitors.filter((m) => m.id !== id);
  db.events = db.events.filter((e) => e.monitorId !== id);
  save(db);
}

function evId(): string {
  return `ev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function fromHits(m: SignalMonitor, entity: string, hits: SourceHit[], topic?: string): SignalEvent[] {
  return hits.map((it) => ({
    id: evId(),
    monitorId: m.id,
    kind: m.kind,
    entity,
    title: it.title,
    url: it.url,
    snippet: it.snippet,
    source: it.source,
    topic,
    happenedAt: it.date,
    score: it.score,
    spike: it.spike,
  }));
}

async function fetchText(url: string, timeout = 12000): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { "User-Agent": "MailgraphSignals/1.0 (research@warewe.com)", Accept: "*/*" },
  });
  if (!res.ok) return "";
  return res.text();
}

async function runTopicIntent(m: SignalMonitor): Promise<SignalEvent[]> {
  const topics = m.topics?.length ? m.topics : [m.query ?? "AI"];
  const { intentHits } = await import("./signals-sources");
  const out: SignalEvent[] = [];
  for (const entity of m.entities) {
    for (const topic of topics) {
      out.push(...fromHits(m, entity, await intentHits(entity, topic), topic));
    }
  }
  return out;
}

async function runNewsQuery(m: SignalMonitor, extra: string): Promise<SignalEvent[]> {
  const { peopleMoveHits } = await import("./signals-sources");
  const entities = m.entities.length ? m.entities : m.query ? [m.query] : [];
  const out: SignalEvent[] = [];
  for (const entity of entities) {
    out.push(...fromHits(m, entity, await peopleMoveHits(entity, extra)));
  }
  return out;
}

async function runJobPosting(m: SignalMonitor): Promise<SignalEvent[]> {
  const { jobHits } = await import("./signals-sources");
  const out: SignalEvent[] = [];
  for (const entity of m.entities) {
    out.push(...fromHits(m, entity, await jobHits(entity)));
  }
  return out;
}

async function runFunding(m: SignalMonitor): Promise<SignalEvent[]> {
  const { fundingHits } = await import("./signals-sources");
  const entities = m.entities.length ? m.entities : m.query ? [m.query] : [];
  const out: SignalEvent[] = [];
  for (const entity of entities) {
    out.push(...fromHits(m, entity, await fundingHits(entity)));
  }
  return out;
}

async function runMapsLike(m: SignalMonitor): Promise<SignalEvent[]> {
  const loc = m.location || "United States";
  const q = m.query || m.entities[0] || "companies";
  const { searchMapsLeads } = await import("./maps-leads");
  const r = await searchMapsLeads({ mode: "text", query: q, location: loc, limit: 80 });
  return (r.leads ?? []).map((lead) => ({
    id: evId(),
    monitorId: m.id,
    kind: m.kind,
    entity: lead.name,
    title: lead.name,
    url: lead.website || lead.mapsUrl || "",
    snippet: [lead.category, lead.address, lead.phone].filter(Boolean).join(" · "),
    source: lead.source ?? "maps",
  }));
}

async function runStoreLeads(m: SignalMonitor): Promise<SignalEvent[]> {
  const out: SignalEvent[] = [];
  const { detectTechStack } = await import("./tech-stack");
  const { jobHits } = await import("./signals-sources");
  for (const entity of m.entities.slice(0, 8)) {
    const domain = entity.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
    const label = domain.includes(".") ? domain : entity;
    try {
      const [stack, jobs] = await Promise.all([
        domain.includes(".") ? detectTechStack(domain) : Promise.resolve({ technologies: [], sources: [] as string[] }),
        jobHits(entity),
      ]);
      const techs = stack.technologies.slice(0, 16).map((t: { name: string }) => t.name);
      if (techs.length) {
        out.push({
          id: evId(),
          monitorId: m.id,
          kind: m.kind,
          entity: label,
          title: `${label} · ${techs.length} technologies`,
          url: domain.includes(".") ? `https://${domain}` : "",
          snippet: techs.join(", "),
          source: stack.sources.join("+") || "site-headers",
        });
      }
      out.push(...fromHits(m, entity, jobs));
    } catch {
      /* skip */
    }
  }
  return out;
}

async function runRss(m: SignalMonitor): Promise<SignalEvent[]> {
  if (!m.url) return [];
  const { parseRss } = await import("./signals-sources");
  return fromHits(m, m.name, parseRss(await fetchText(m.url), "rss"));
}

async function runJsonUrl(m: SignalMonitor, source: string): Promise<SignalEvent[]> {
  if (!m.url) return [];
  const raw = await fetchText(m.url, 20000);
  try {
    const j = JSON.parse(raw) as unknown;
    const rec = j as Record<string, unknown>;
    const rows = Array.isArray(j) ? j : Array.isArray(rec.items) ? rec.items : Array.isArray(rec.data) ? rec.data : [j];
    return (rows as unknown[]).slice(0, 100).map((row) => {
      const o = (row ?? {}) as Record<string, unknown>;
      return {
        id: evId(),
        monitorId: m.id,
        kind: m.kind,
        entity: String(o.company ?? o.name ?? m.name),
        title: String(o.title ?? o.name ?? o.fullName ?? o.headline ?? "item"),
        url: String(o.url ?? o.link ?? o.linkedinUrl ?? m.url ?? ""),
        snippet: String(o.snippet ?? o.description ?? o.company ?? "").slice(0, 240),
        source,
      };
    });
  } catch {
    const { parseRss } = await import("./signals-sources");
    return fromHits(m, m.name, parseRss(raw, source));
  }
}

export async function runMonitor(id: string): Promise<{ monitor: SignalMonitor; events: SignalEvent[]; ms: number }> {
  const db = load();
  const monitor = db.monitors.find((m) => m.id === id);
  if (!monitor) throw new Error("monitor not found");
  const t0 = Date.now();
  let events: SignalEvent[] = [];
  switch (monitor.kind) {
    case "topic_intent":
      events = await runTopicIntent(monitor);
      break;
    case "job_change":
      events = await runNewsQuery(monitor, 'joined OR "now at" OR "no longer" OR left OR "moves to" OR resigned');
      break;
    case "new_hire":
      events = await runNewsQuery(monitor, 'appointed OR "joins as" OR "joined as" OR "new hire" OR welcome');
      break;
    case "promotion":
      events = await runNewsQuery(monitor, 'promoted OR "named VP" OR "promoted to" OR elevated OR "new CEO"');
      break;
    case "news_fundraising":
    case "pitchbook":
      events = await runFunding(monitor);
      break;
    case "job_posting":
      events = await runJobPosting(monitor);
      break;
    case "openmart":
    case "maps":
      events = await runMapsLike(monitor);
      break;
    case "store_leads":
      events = await runStoreLeads(monitor);
      break;
    case "rss":
      events = await runRss(monitor);
      break;
    case "google_search": {
      const { serp } = await import("./signals-sources");
      events = fromHits(monitor, monitor.query ?? monitor.name, await serp(monitor.query || monitor.entities.join(" ")));
      break;
    }
    case "phantombuster":
      events = await runJsonUrl(monitor, "phantombuster");
      break;
    case "apify":
      events = await runJsonUrl(monitor, "apify");
      break;
  }
  const seen = new Set<string>();
  events = events.filter((e) => {
    const k = `${e.url}|${e.title}`.slice(0, 180);
    if (seen.has(k) || !e.title) return false;
    seen.add(k);
    return true;
  });
  monitor.lastRunAt = Date.now();
  db.monitors = db.monitors.map((x) => (x.id === id ? monitor : x));
  db.events = [...db.events, ...events];
  save(db);
  return { monitor, events, ms: Date.now() - t0 };
}
