/**
 * Clay-style waterfall enrichment — multi-hop deep research + verify.
 */

import { generateCandidates } from "./candidates";
import type { DiscoveredEmail, DomainCrawlResult } from "./crawl";
import {
  getPatternHitsForDomain,
  getKnownEmailsForDomain,
  inferPatternPrevalence,
  lookupExactPerson,
  resolveCompanyDomain,
} from "./knowledge-base";
import {
  findPersonInIndex,
  indexStats,
  upsertIndexRecord,
} from "./index-store";
import { deepResearchDomain } from "./research-agent";
import { isRoleBasedEmail } from "./disposable";
import {
  isValidDomainShape,
  normalizeDomain,
  parseFullName,
} from "./normalize";
import { rankResults, scoreCandidate } from "./score";
import { verifyEmail } from "./verify";
import { isDisposableDomain, isFreePersonalDomain } from "./disposable";
import { lookupMx } from "./dns";
import { parseLinkedInUrl } from "./linkedin";
import { detectPatternFromEmail, PATTERN_MAP } from "./patterns";
import type {
  DomainIntelligence,
  FindEmailResult,
  ParsedName,
  PatternId,
  PipelineStep,
  ResultSource,
  ScoredResult,
} from "./types";

const EARLY_STOP_CONFIDENCE = 85;
const MAX_SMTP_PROBES = 5;

export interface WaterfallStage {
  id: string;
  provider: string;
  status: "ok" | "miss" | "skip" | "error" | "hit";
  detail: string;
  ms: number;
  emailsFound: number;
  stoppedHere?: boolean;
}

export interface WaterfallFindResult extends FindEmailResult {
  waterfall: WaterfallStage[];
  winningProvider: string | null;
  indexStats: { totalEmails: number; domains: number };
}

export type WaterfallDomainResult = DomainCrawlResult & {
  waterfall: WaterfallStage[];
  fromIndex: number;
  fromCrawl: number;
  fromGraph?: number;
  peopleCount?: number;
  researchHops?: Array<{
    id: string;
    label: string;
    status: string;
    detail: string;
    ms: number;
  }>;
  legalName?: string | null;
};

function stage(
  id: string,
  provider: string,
  status: WaterfallStage["status"],
  detail: string,
  ms: number,
  emailsFound = 0,
  stoppedHere = false,
): WaterfallStage {
  return { id, provider, status, detail, ms, emailsFound, stoppedHere };
}

function pipe(
  id: string,
  label: string,
  status: PipelineStep["status"],
  detail: string,
  ms: number,
): PipelineStep {
  return { id, label, status, detail, ms };
}

function patternMeta(
  email: string,
  name: ParsedName,
): { id: PatternId; label: string } {
  const id = detectPatternFromEmail(email, name.first, name.last);
  if (id) {
    const p = PATTERN_MAP.get(id);
    return { id, label: p?.label ?? id };
  }
  return { id: "first.last", label: "first.last" };
}

function nameTokensMatchEmail(
  email: string,
  first: string,
  last: string,
): boolean {
  const local = (email.split("@")[0] ?? "").toLowerCase();
  const f = first.toLowerCase();
  const l = last.toLowerCase();
  if (!f) return false;
  if (local === f) return true;
  if (l && local.includes(f) && local.includes(l)) return true;
  if (l && local.includes(`${f[0]}${l}`)) return true;
  if (l && local.includes(`${f}${l[0]}`)) return true;
  if (l && local.includes(`${f}.${l}`)) return true;
  if (l && local.includes(`${f}_${l}`)) return true;
  return false;
}

async function buildIntel(domain: string): Promise<{
  intel: DomainIntelligence;
  mxMs: number;
}> {
  const t0 = Date.now();
  const mx = await lookupMx(domain);
  const patterns = getPatternHitsForDomain(domain);
  const knownEmails = getKnownEmailsForDomain(domain);
  const sampleSize = patterns.reduce((s, p) => s + p.sampleCount, 0);
  const confidence =
    sampleSize >= 20
      ? 90
      : sampleSize >= 5
        ? 75
        : knownEmails.length
          ? 60
          : mx.hasMx
            ? 35
            : 10;

  return {
    intel: {
      domain,
      normalizedDomain: domain,
      hasMx: mx.hasMx,
      mxHosts: mx.mxHosts.map((h) => h.exchange),
      mxProvider: mx.provider,
      isCatchAllLikely: false,
      isDisposable: isDisposableDomain(domain) || mx.isDisposable,
      patterns,
      knownEmails,
      sampleSize,
      confidence,
    },
    mxMs: Date.now() - t0,
  };
}

export async function waterfallFindEmail(input: {
  fullName: string;
  domain: string;
  linkedinUrl?: string;
  skipSmtp?: boolean;
}): Promise<WaterfallFindResult> {
  const tStart = Date.now();
  const waterfall: WaterfallStage[] = [];
  const pipeline: PipelineStep[] = [];
  let winningProvider: string | null = null;

  const domain = resolveCompanyDomain(input.domain);
  const tDom = Date.now();
  if (!isValidDomainShape(domain)) {
    waterfall.push(
      stage(
        "domain",
        "Domain resolver",
        "error",
        `Invalid domain: ${input.domain}`,
        Date.now() - tDom,
      ),
    );
    return emptyResult(input, domain, waterfall, pipeline, tStart);
  }
  waterfall.push(
    stage(
      "domain",
      "Domain resolver",
      "ok",
      `Resolved → ${domain}`,
      Date.now() - tDom,
    ),
  );
  pipeline.push(
    pipe(
      "domain",
      "Domain resolution",
      "ok",
      `Resolved to ${domain}`,
      Date.now() - tDom,
    ),
  );

  let name = parseFullName(input.fullName);
  const extraSources: ResultSource[] = [];
  if (input.linkedinUrl) {
    const li = parseLinkedInUrl(input.linkedinUrl);
    if (li.guessedName && (!name.first || !name.last)) {
      name = li.guessedName;
      extraSources.push("linkedin_parse");
    } else if (li.guessedName) {
      extraSources.push("linkedin_parse");
    }
  }

  if (!name.first) {
    waterfall.push(
      stage("name", "Name parser", "error", "Could not parse first name", 0),
    );
    return emptyResult(input, domain, waterfall, pipeline, tStart, name);
  }

  pipeline.push(
    pipe(
      "name",
      "Name parsing",
      "ok",
      `${name.first}${name.last ? ` ${name.last}` : ""}`,
      0,
    ),
  );

  const { intel, mxMs } = await buildIntel(domain);
  pipeline.push(
    pipe(
      "mx",
      "MX / DNS",
      intel.hasMx ? "ok" : "error",
      intel.hasMx
        ? `MX via ${intel.mxProvider ?? "custom"}`
        : "No MX — cannot receive mail",
      mxMs,
    ),
  );

  if (intel.isDisposable) {
    waterfall.push(
      stage("hygiene", "Hygiene", "error", "Disposable domain blocked", 0),
    );
    return {
      ...emptyResult(input, domain, waterfall, pipeline, tStart, name),
      domainIntel: intel,
    };
  }

  if (isFreePersonalDomain(domain)) {
    waterfall.push(
      stage("hygiene", "Hygiene", "skip", "Free-mail domain", 0),
    );
  }

  type PoolItem = {
    email: string;
    provider: string;
    sources: ResultSource[];
    patternId: PatternId;
    patternLabel: string;
    priorScore: number;
    exactKb?: boolean;
  };
  const pool: PoolItem[] = [];
  const seen = new Set<string>();

  const addPool = (item: PoolItem) => {
    const key = item.email.toLowerCase();
    if (seen.has(key)) {
      const ex = pool.find((p) => p.email === key);
      if (ex) {
        for (const s of item.sources) {
          if (!ex.sources.includes(s)) ex.sources.push(s);
        }
        ex.priorScore = Math.max(ex.priorScore, item.priorScore);
      }
      return false;
    }
    seen.add(key);
    pool.push(item);
    return true;
  };

  {
    const t = Date.now();
    const hit = await findPersonInIndex(name.first, name.last, domain);
    if (hit) {
      const pat = patternMeta(hit.email, name);
      addPool({
        email: hit.email,
        provider: "local_index",
        sources: ["public_index", ...extraSources],
        patternId: pat.id,
        patternLabel: pat.label,
        priorScore: Math.min(0.98, hit.confidence / 100),
      });
      waterfall.push(
        stage(
          "local_index",
          "Local index",
          "hit",
          `Index hit: ${hit.email}`,
          Date.now() - t,
          1,
        ),
      );
    } else {
      waterfall.push(
        stage(
          "local_index",
          "Local index",
          "miss",
          "No person match in index",
          Date.now() - t,
        ),
      );
    }
  }

  {
    const t = Date.now();
    try {
      const research = await deepResearchDomain(domain);
      let matched = 0;
      for (const c of research.contacts) {
        if (
          nameTokensMatchEmail(c.email, name.first, name.last) ||
          (c.firstName?.toLowerCase() === name.first.toLowerCase() &&
            c.lastName?.toLowerCase() === name.last.toLowerCase())
        ) {
          const pat = patternMeta(c.email, name);
          if (
            addPool({
              email: c.email,
              provider: "deep_research",
              sources: ["public_index", ...extraSources],
              patternId: pat.id,
              patternLabel: pat.label,
              priorScore: Math.min(0.99, c.confidence / 100),
            })
          )
            matched++;
        }
      }
      for (const p of research.people) {
        if (
          p.firstName.toLowerCase() === name.first.toLowerCase() &&
          p.lastName.toLowerCase() === name.last.toLowerCase()
        ) {
          for (const e of p.emails) {
            const pat = patternMeta(e.email, name);
            if (
              addPool({
                email: e.email,
                provider: "deep_research",
                sources: ["public_index", ...extraSources],
                patternId: pat.id,
                patternLabel: pat.label,
                priorScore: 0.97,
              })
            )
              matched++;
          }
        }
      }
      waterfall.push(
        stage(
          "deep_research",
          "Deep research",
          matched ? "hit" : "miss",
          matched
            ? `${matched} person hits · ${research.hops.length} hops`
            : `${research.people.length} people · ${research.contacts.length} contacts · no name match`,
          Date.now() - t,
          matched,
        ),
      );
    } catch (err) {
      waterfall.push(
        stage(
          "deep_research",
          "Deep research",
          "error",
          err instanceof Error ? err.message : "failed",
          Date.now() - t,
        ),
      );
    }
  }

  {
    const t = Date.now();
    const kb = lookupExactPerson(name.first, name.last, domain);
    if (kb) {
      const pat = patternMeta(kb.email, name);
      addPool({
        email: kb.email,
        provider: "knowledge_base",
        sources: ["knowledge_base", "public_index", ...extraSources],
        patternId: pat.id,
        patternLabel: pat.label,
        priorScore: 0.99,
        exactKb: true,
      });
      waterfall.push(
        stage(
          "knowledge_base",
          "Knowledge base",
          "hit",
          `Curated: ${kb.email}`,
          Date.now() - t,
          1,
        ),
      );
    } else {
      waterfall.push(
        stage(
          "knowledge_base",
          "Knowledge base",
          "skip",
          "No curated person match",
          Date.now() - t,
        ),
      );
    }
  }

  {
    const t = Date.now();
    const candidates = generateCandidates(name, domain, extraSources);
    let added = 0;
    for (const c of candidates.slice(0, 12)) {
      if (
        addPool({
          email: c.email,
          provider: "pattern_engine",
          sources: c.sources,
          patternId: c.patternId,
          patternLabel: c.patternLabel,
          priorScore: c.priorScore,
          exactKb: c.sources.includes("knowledge_base"),
        })
      )
        added++;
    }
    waterfall.push(
      stage(
        "pattern_engine",
        "Pattern engine",
        added ? "ok" : "miss",
        `${candidates.length} patterns · ${added} new`,
        Date.now() - t,
        added,
      ),
    );
    pipeline.push(
      pipe(
        "patterns",
        "Pattern + pool",
        pool.length ? "ok" : "warn",
        `${pool.length} candidates`,
        Date.now() - t,
      ),
    );
  }

  const providerRank: Record<string, number> = {
    knowledge_base: 0,
    deep_research: 1,
    local_index: 2,
    pattern_engine: 3,
  };
  pool.sort((a, b) => {
    const pr =
      (providerRank[a.provider] ?? 9) - (providerRank[b.provider] ?? 9);
    if (pr !== 0) return pr;
    return b.priorScore - a.priorScore;
  });

  const scored: ScoredResult[] = [];
  const tVerify = Date.now();
  let stoppedEarly = false;
  let stopProvider: string | null = null;
  const toProbe = pool.slice(0, MAX_SMTP_PROBES);

  for (const item of toProbe) {
    const verification = await verifyEmail(item.email, {
      skipSmtp: input.skipSmtp || !intel.hasMx,
    });
    const sources = [...item.sources];
    if (
      verification.status === "valid" &&
      !sources.includes("smtp_verified")
    ) {
      sources.push("smtp_verified");
    }
    const { prevalence, sampleCount, fromSeed } = inferPatternPrevalence(
      domain,
      item.patternId,
    );
    const result = scoreCandidate(
      {
        email: item.email,
        patternId: item.patternId,
        patternLabel: item.patternLabel,
        priorScore: item.priorScore,
        sources,
      },
      verification,
      {
        domainPatternPrevalence: prevalence,
        domainSampleCount: sampleCount,
        domainKnown: fromSeed || item.provider !== "pattern_engine",
        exactKbHit: Boolean(item.exactKb),
      },
    );
    scored.push(result);

    if (result.confidence >= 50 && result.status !== "invalid") {
      await upsertIndexRecord({
        email: result.email,
        domain,
        firstName: name.first,
        lastName: name.last,
        sources: [
          {
            url: `waterfall://${item.provider}`,
            kind: item.provider,
            seenAt: new Date().toISOString(),
          },
        ],
        patternId: result.patternId,
        confidence: result.confidence,
        status: result.status,
      });
    }

    if (
      verification.status === "valid" &&
      result.confidence >= EARLY_STOP_CONFIDENCE
    ) {
      stoppedEarly = true;
      stopProvider = item.provider;
      winningProvider = item.provider;
      break;
    }
    if (verification.isCatchAll) break;
  }

  for (const item of pool.slice(0, 8)) {
    if (scored.some((s) => s.email === item.email)) continue;
    const verification = await verifyEmail(item.email, { skipSmtp: true });
    const prev = inferPatternPrevalence(domain, item.patternId);
    scored.push(
      scoreCandidate(
        {
          email: item.email,
          patternId: item.patternId,
          patternLabel: item.patternLabel,
          priorScore: item.priorScore,
          sources: item.sources,
        },
        verification,
        {
          domainPatternPrevalence: prev.prevalence,
          domainSampleCount: prev.sampleCount,
          domainKnown: prev.fromSeed,
          exactKbHit: Boolean(item.exactKb),
        },
      ),
    );
  }

  waterfall.push(
    stage(
      "smtp_verify",
      "SMTP verifier",
      stoppedEarly
        ? "hit"
        : scored.some((s) => s.status === "valid")
          ? "ok"
          : "miss",
      stoppedEarly
        ? `Early stop via ${stopProvider}`
        : `Best ${scored[0]?.email ?? "—"} (${scored[0]?.confidence ?? 0}%)`,
      Date.now() - tVerify,
      scored.filter((s) => s.status === "valid").length,
      stoppedEarly,
    ),
  );

  if (stoppedEarly && stopProvider) {
    const byId = waterfall.find((w) => w.id === stopProvider);
    if (byId) byId.stoppedHere = true;
  }

  const ranked = rankResults(scored);
  const best =
    ranked.find((r) => r.status !== "invalid" && r.status !== "no_mx") ?? null;
  if (!winningProvider && best) {
    winningProvider =
      pool.find((p) => p.email === best.email)?.provider ?? "pattern_engine";
  }

  pipeline.push(
    pipe(
      "verify",
      "Waterfall verification",
      best && best.status === "valid" ? "ok" : best ? "ok" : "warn",
      best
        ? `Best: ${best.email} · ${best.confidence}% · via ${winningProvider}`
        : "No viable candidate",
      Date.now() - tVerify,
    ),
  );

  const stats = await indexStats();
  return {
    query: {
      fullName: input.fullName,
      domain: input.domain,
      linkedinUrl: input.linkedinUrl,
    },
    name,
    domainIntel: intel,
    best,
    alternatives: best
      ? ranked.filter((r) => r.email !== best.email).slice(0, 5)
      : ranked.slice(0, 5),
    pipeline,
    durationMs: Date.now() - tStart,
    waterfall,
    winningProvider,
    indexStats: stats,
  };
}

function emptyResult(
  input: { fullName: string; domain: string; linkedinUrl?: string },
  domain: string,
  waterfall: WaterfallStage[],
  pipeline: PipelineStep[],
  tStart: number,
  name = parseFullName(input.fullName),
): WaterfallFindResult {
  return {
    query: {
      fullName: input.fullName,
      domain: input.domain,
      linkedinUrl: input.linkedinUrl,
    },
    name,
    domainIntel: {
      domain,
      normalizedDomain: domain,
      hasMx: false,
      mxHosts: [],
      mxProvider: null,
      isCatchAllLikely: false,
      isDisposable: false,
      patterns: [],
      knownEmails: [],
      sampleSize: 0,
      confidence: 0,
    },
    best: null,
    alternatives: [],
    pipeline,
    durationMs: Date.now() - tStart,
    waterfall,
    winningProvider: null,
    indexStats: { totalEmails: 0, domains: 0 },
  };
}

/** Domain search = deep multi-hop research. */
export async function waterfallSearchDomain(
  domainInput: string,
  _options: { verifyRoles?: boolean } = {},
): Promise<WaterfallDomainResult> {
  const waterfall: WaterfallStage[] = [];
  const domain = normalizeDomain(resolveCompanyDomain(domainInput));
  const t0 = Date.now();

  const research = await deepResearchDomain(domain);
  for (const h of research.hops) {
    waterfall.push(
      stage(
        h.id,
        h.label,
        h.status === "ok"
          ? "hit"
          : h.status === "miss"
            ? "miss"
            : h.status === "error"
              ? "error"
              : "skip",
        h.detail,
        h.ms,
        h.finds,
      ),
    );
  }

  const merged = new Map<string, DiscoveredEmail>();

  for (const c of research.contacts) {
    const existing = merged.get(c.email);
    const sources = c.sources.map((url) => ({
      url,
      extractedAt: new Date().toISOString(),
      kind: "public_graph" as const,
    }));
    if (existing) {
      for (const s of sources) {
        if (!existing.sources.some((x) => x.url === s.url)) {
          existing.sources.push(s);
        }
      }
      existing.confidence = Math.max(existing.confidence, c.confidence);
      if (c.status === "valid") existing.status = "valid";
      if (c.status === "invalid" && existing.status !== "valid") {
        existing.status = "invalid";
      }
      existing.firstName = c.firstName ?? existing.firstName;
      existing.lastName = c.lastName ?? existing.lastName;
      existing.title = c.title ?? existing.title;
      existing.isRoleBased = c.isRoleBased;
      existing.kind = c.isRoleBased ? "role" : "person";
    } else {
      merged.set(c.email, {
        email: c.email,
        confidence: c.confidence,
        status: c.status,
        sources,
        firstName: c.firstName,
        lastName: c.lastName,
        title: c.title,
        isRoleBased: c.isRoleBased,
        kind: c.isRoleBased ? "role" : "person",
        patternId: c.patternId,
        patternLabel: c.patternLabel,
      });
    }
    await upsertIndexRecord({
      email: c.email,
      domain,
      firstName: c.firstName,
      lastName: c.lastName,
      title: c.title,
      sources: c.sources.map((url) => ({
        url,
        kind: "public_graph",
        seenAt: new Date().toISOString(),
      })),
      patternId: c.patternId,
      confidence: c.confidence,
      status: c.status === "found" ? "found" : c.status,
    });
  }

  const emails = [...merged.values()].sort((a, b) => {
    const score = (e: DiscoveredEmail) => {
      let s = e.confidence;
      if (!e.isRoleBased) s += 50;
      if (e.status === "valid") s += 30;
      if (e.status === "invalid") s -= 50;
      if (e.firstName && e.lastName) s += 20;
      return s;
    };
    return score(b) - score(a);
  });

  const personCount = emails.filter((e) => !e.isRoleBased).length;
  const roleCount = emails.filter((e) => e.isRoleBased).length;

  waterfall.push(
    stage(
      "fuse",
      "Evidence fusion",
      emails.length ? "hit" : "miss",
      `${emails.length} contacts · ${personCount} people · ${roleCount} roles · ${research.people.length} named`,
      0,
      emails.length,
      true,
    ),
  );

  const mx = await lookupMx(domain);

  const people = research.people.map((p) => ({
    firstName: p.firstName,
    lastName: p.lastName,
    fullName: p.fullName,
    title: p.title,
    email: p.emails[0]?.email,
    sourceUrl: p.sources[0],
  }));

  return {
    domain,
    companyName: research.companyName,
    website: `https://${domain}`,
    hasMx: mx.hasMx,
    mxProvider: mx.provider,
    mxHosts: mx.mxHosts.map((h) => h.exchange),
    emails,
    patterns: [
      {
        patternId: "first.last",
        label: "first.last",
        prevalence: 0.4,
        sampleCount: 0,
        example: `jane.doe@${domain}`,
      },
      {
        patternId: "first",
        label: "first",
        prevalence: 0.2,
        sampleCount: 0,
        example: `jane@${domain}`,
      },
    ],
    pagesCrawled: research.hops.length,
    pagesAttempted: research.hops.map((h) => h.label),
    durationMs: Date.now() - t0,
    people,
    waterfall,
    fromIndex: 0,
    fromCrawl: research.contacts.length,
    fromGraph: personCount,
    peopleCount: personCount,
    researchHops: research.hops,
    legalName: research.legalName,
    pipeline: waterfall.map((w) => ({
      id: w.id,
      label: w.provider,
      status:
        w.status === "hit" || w.status === "ok"
          ? ("ok" as const)
          : w.status === "error"
            ? ("error" as const)
            : w.status === "skip"
              ? ("skip" as const)
              : ("warn" as const),
      detail: w.detail,
      ms: w.ms,
    })),
  };
}
