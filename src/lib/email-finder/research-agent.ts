/**
 * Deep multi-hop research agent (Clay-style orchestration).
 * LinkedIn company guest card is hop 0 — primary people source.
 */

import {
  isValidDomainShape,
  isValidEmailSyntax,
  normalizeDomain,
  parseFullName,
  slugifyToken,
} from "./normalize";
import { isRoleBasedEmail } from "./disposable";
import { discoverPublicGraph, personEmailGuesses } from "./public-graph";
import { discoverSocialGraph } from "./social-graph";
import { serpDiscoverPeople } from "./serp";
import { discoverLinkedInForDomain } from "./linkedin-company";
import { crawlDomainEmails } from "./crawl";
import { verifyEmail } from "./verify";
import { resilientFetch } from "./http";
import type { PatternId, VerificationStatus } from "./types";

export interface ResearchHop {
  id: string;
  label: string;
  status: "ok" | "miss" | "skip" | "error";
  detail: string;
  ms: number;
  finds: number;
}

export interface ResearchPerson {
  fullName: string;
  firstName: string;
  lastName: string;
  title?: string;
  emails: Array<{
    email: string;
    confidence: number;
    status: VerificationStatus | "found";
    sources: string[];
    pattern?: string;
  }>;
  sources: string[];
  evidence: string[];
  network?: string;
}

export interface ResearchContact {
  email: string;
  confidence: number;
  status: VerificationStatus | "found";
  isRoleBased: boolean;
  firstName?: string;
  lastName?: string;
  title?: string;
  sources: string[];
  evidence: string[];
  patternId?: PatternId;
  patternLabel?: string;
}

export interface DeepResearchResult {
  domain: string;
  companyName: string | null;
  legalName: string | null;
  hops: ResearchHop[];
  people: ResearchPerson[];
  contacts: ResearchContact[];
  durationMs: number;
  socialProfiles?: Array<{ url: string; network: string; label: string }>;
}

function hop(
  id: string,
  label: string,
  status: ResearchHop["status"],
  detail: string,
  ms: number,
  finds = 0,
): ResearchHop {
  return { id, label, status, detail, ms, finds };
}

function addContact(
  map: Map<string, ResearchContact>,
  partial: Omit<ResearchContact, "evidence" | "sources"> & {
    sources?: string[];
    evidence?: string[];
  },
) {
  const key = partial.email.toLowerCase();
  const existing = map.get(key);
  if (existing) {
    existing.confidence = Math.max(existing.confidence, partial.confidence);
    existing.sources = [
      ...new Set([...existing.sources, ...(partial.sources ?? [])]),
    ];
    existing.evidence = [
      ...new Set([...existing.evidence, ...(partial.evidence ?? [])]),
    ];
    existing.firstName = partial.firstName ?? existing.firstName;
    existing.lastName = partial.lastName ?? existing.lastName;
    existing.title = partial.title ?? existing.title;
    if (partial.status === "valid") existing.status = "valid";
    if (!isRoleBasedEmail(key)) existing.isRoleBased = false;
    return;
  }
  map.set(key, {
    email: key,
    confidence: partial.confidence,
    status: partial.status,
    isRoleBased: partial.isRoleBased,
    firstName: partial.firstName,
    lastName: partial.lastName,
    title: partial.title,
    sources: partial.sources ?? [],
    evidence: partial.evidence ?? [],
    patternId: partial.patternId,
    patternLabel: partial.patternLabel,
  });
}

function upsertPerson(
  peopleMap: Map<string, ResearchPerson>,
  input: {
    firstName: string;
    lastName: string;
    title?: string;
    source?: string;
    evidence?: string;
    email?: string;
    network?: string;
  },
) {
  const key = `${input.firstName}|${input.lastName}`.toLowerCase();
  const existing = peopleMap.get(key);
  if (existing) {
    if (input.title) existing.title = existing.title ?? input.title;
    if (input.source) existing.sources.push(input.source);
    if (input.evidence) existing.evidence.push(input.evidence);
    if (input.network) existing.network = existing.network ?? input.network;
    if (input.email) {
      existing.emails.push({
        email: input.email,
        confidence: 85,
        status: "found",
        sources: [input.source ?? "social"],
      });
    }
    return;
  }
  peopleMap.set(key, {
    fullName: `${input.firstName} ${input.lastName}`,
    firstName: input.firstName,
    lastName: input.lastName,
    title: input.title,
    emails: input.email
      ? [
          {
            email: input.email,
            confidence: 85,
            status: "found",
            sources: [input.source ?? "social"],
          },
        ]
      : [],
    sources: input.source ? [input.source] : [],
    evidence: input.evidence ? [input.evidence] : [],
    network: input.network,
  });
}

export async function deepResearchDomain(
  domainInput: string,
): Promise<DeepResearchResult> {
  const t0 = Date.now();
  const domain = normalizeDomain(domainInput);
  const hops: ResearchHop[] = [];
  const contacts = new Map<string, ResearchContact>();
  const peopleMap = new Map<string, ResearchPerson>();
  let socialProfiles: DeepResearchResult["socialProfiles"] = [];

  if (!isValidDomainShape(domain)) {
    return {
      domain,
      companyName: null,
      legalName: null,
      hops: [hop("domain", "Domain", "error", "Invalid", 0)],
      people: [],
      contacts: [],
      durationMs: 0,
    };
  }

  const brand = domain.split(".")[0] ?? domain;
  let legalName: string | null = null;
  let companyName: string | null = null;

  // ── Hop 0: LinkedIn guest (PRIMARY) ──────────────────────────────
  {
    const t = Date.now();
    try {
      const li = await discoverLinkedInForDomain(domain);
      if (li.company?.name) companyName = li.company.name;
      for (const p of li.people) {
        if (!p.lastName) continue;
        const guess = `${slugifyToken(p.firstName)}.${slugifyToken(p.lastName)}@${domain}`;
        upsertPerson(peopleMap, {
          firstName: p.firstName,
          lastName: p.lastName,
          title: p.title,
          source: p.profileUrl,
          evidence: "LinkedIn company guest card",
          email: guess,
          network: "linkedin",
        });
        addContact(contacts, {
          email: guess,
          confidence: 74,
          status: "found",
          isRoleBased: false,
          firstName: p.firstName,
          lastName: p.lastName,
          title: p.title,
          sources: [p.profileUrl],
          evidence: ["LinkedIn person · first.last"],
          patternId: "first.last",
          patternLabel: "first.last",
        });
      }
      hops.push(
        hop(
          "linkedin",
          "LinkedIn company",
          li.people.length ? "ok" : "miss",
          li.detail,
          Date.now() - t,
          li.people.length,
        ),
      );
    } catch (err) {
      hops.push(
        hop(
          "linkedin",
          "LinkedIn company",
          "error",
          err instanceof Error ? err.message : "failed",
          Date.now() - t,
        ),
      );
    }
  }

  // Hunter-style: LinkedIn people are the product. Don't stall on crawl.
  if (peopleMap.size >= 3) {
    hops.push(
      hop(
        "entity",
        "Site / registry / social",
        "skip",
        `Returned ${peopleMap.size} LinkedIn people immediately`,
        0,
      ),
    );
    return {
      domain,
      companyName,
      legalName,
      hops,
      people: [...peopleMap.values()],
      contacts: [...contacts.values()],
      durationMs: Date.now() - t0,
      socialProfiles,
    };
  }

  // ── Hop 1: Company site crawl ────────────────────────────────────
  {
    const t = Date.now();
    try {
      const crawl = await crawlDomainEmails(domain, { maxPages: 8 });
      if (!companyName && crawl.companyName) companyName = crawl.companyName;
      for (const e of crawl.emails) {
        addContact(contacts, {
          email: e.email,
          confidence: e.confidence,
          status: e.status === "valid" ? "valid" : "found",
          isRoleBased: e.isRoleBased,
          firstName: e.firstName,
          lastName: e.lastName,
          title: e.title,
          sources: e.sources.map((s) => s.url),
          evidence: ["Found on company site"],
        });
        if (e.firstName && e.lastName) {
          upsertPerson(peopleMap, {
            firstName: e.firstName,
            lastName: e.lastName,
            title: e.title,
            source: e.sources[0]?.url,
            evidence: "Company site",
            email: e.email,
          });
        }
      }
      hops.push(
        hop(
          "entity",
          "Entity resolution",
          crawl.emails.length ? "ok" : "miss",
          `site emails=${crawl.emails.length} · ${crawl.companyName ?? "—"}`,
          Date.now() - t,
          crawl.emails.length,
        ),
      );
    } catch (err) {
      hops.push(
        hop(
          "entity",
          "Entity resolution",
          "error",
          err instanceof Error ? err.message : "failed",
          Date.now() - t,
        ),
      );
    }
  }

  // ── Hop 2: Registry ──────────────────────────────────────────────
  {
    const t = Date.now();
    const graph = await discoverPublicGraph(domain);
    for (const p of graph.people) {
      upsertPerson(peopleMap, {
        firstName: p.firstName,
        lastName: p.lastName,
        title: p.title,
        source: p.sourceUrl,
        evidence: "Company registry director",
        email: p.email,
        network: "registry",
      });
    }
    for (const e of graph.emails) {
      addContact(contacts, {
        email: e.email,
        confidence: e.isRoleBased ? 50 : 88,
        status: "found",
        isRoleBased: e.isRoleBased,
        firstName: e.firstName,
        lastName: e.lastName,
        title: e.title,
        sources: [e.sourceUrl],
        evidence: ["Public company registry"],
      });
    }
    hops.push(
      hop(
        "registry",
        "Registry graph",
        graph.people.length || graph.emails.length ? "ok" : "miss",
        graph.detail,
        Date.now() - t,
        graph.emails.length + graph.people.length,
      ),
    );
  }

  // ── Hop 3: LinkedIn SERP only if guest card was thin ─────────────
  {
    const t = Date.now();
    if (peopleMap.size >= 5) {
      hops.push(
        hop(
          "linkedin_serp",
          "LinkedIn SERP",
          "skip",
          `Skipped — ${peopleMap.size} people already from LinkedIn company card`,
          Date.now() - t,
        ),
      );
    } else {
      try {
        const serp = await serpDiscoverPeople(domain, brand);
        for (const p of serp.people) {
          upsertPerson(peopleMap, {
            firstName: p.firstName,
            lastName: p.lastName,
            title: p.title,
            source: p.profileUrl,
            evidence: p.evidence,
            network: "linkedin",
          });
        }
        hops.push(
          hop(
            "linkedin_serp",
            "LinkedIn SERP",
            serp.people.length ? "ok" : "miss",
            serp.detail,
            Date.now() - t,
            serp.people.length,
          ),
        );
      } catch (err) {
        hops.push(
          hop(
            "linkedin_serp",
            "LinkedIn SERP",
            "error",
            err instanceof Error ? err.message : "failed",
            Date.now() - t,
          ),
        );
      }
    }
  }

  // ── Hop 4: Social graph ──────────────────────────────────────────
  {
    const t = Date.now();
    try {
      const social = await discoverSocialGraph(domain, {
        brand,
        legalName,
      });
      socialProfiles = social.profiles;
      for (const p of social.people) {
        upsertPerson(peopleMap, {
          firstName: p.firstName,
          lastName: p.lastName,
          title: p.title,
          source: p.profileUrl,
          evidence: p.evidence,
          email: p.email,
          network: p.network,
        });
      }
      for (const e of social.emails) {
        addContact(contacts, {
          email: e.email,
          confidence: e.isRoleBased ? 45 : 76,
          status: "found",
          isRoleBased: e.isRoleBased,
          firstName: e.firstName,
          lastName: e.lastName,
          sources: [e.sourceUrl],
          evidence: [`${e.network} public page`],
        });
      }
      hops.push(
        hop(
          "social",
          "Social graph",
          social.people.length || social.emails.length ? "ok" : "miss",
          social.detail,
          Date.now() - t,
          social.people.length + social.emails.length,
        ),
      );
    } catch (err) {
      hops.push(
        hop(
          "social",
          "Social graph",
          "error",
          err instanceof Error ? err.message : "failed",
          Date.now() - t,
        ),
      );
    }
  }

  // ── Hop 5: Pattern fill for named people still missing email ─────
  {
    const t = Date.now();
    let filled = 0;
    for (const p of peopleMap.values()) {
      if (p.emails.length) continue;
      const guesses = personEmailGuesses(p.firstName, p.lastName, domain);
      const best = guesses.find((g) => g.patternId === "first.last") ?? guesses[0];
      if (!best) continue;
      p.emails.push({
        email: best.email,
        confidence: 70,
        status: "found",
        sources: p.sources,
        pattern: best.label,
      });
      addContact(contacts, {
        email: best.email,
        confidence: 70,
        status: "found",
        isRoleBased: false,
        firstName: p.firstName,
        lastName: p.lastName,
        title: p.title,
        sources: p.sources,
        evidence: ["Pattern from LinkedIn name"],
        patternId: best.patternId,
        patternLabel: best.label,
      });
      filled += 1;
    }
    hops.push(
      hop(
        "pattern",
        "Pattern fill",
        filled ? "ok" : "skip",
        filled ? `${filled} first.last guesses` : "Everyone already had an email",
        Date.now() - t,
        filled,
      ),
    );
  }

  // Light SMTP on top personal emails (cap 4)
  {
    const t = Date.now();
    const top = [...contacts.values()]
      .filter((c) => !c.isRoleBased)
      .slice(0, 4);
    let ok = 0;
    for (const c of top) {
      try {
        const v = await verifyEmail(c.email, { skipSmtp: true });
        c.status = v.status;
        if (v.status === "valid") {
          c.confidence = Math.max(c.confidence, 92);
          ok += 1;
        }
      } catch {
        /* keep found */
      }
    }
    hops.push(
      hop(
        "smtp",
        "SMTP check",
        ok ? "ok" : top.length ? "miss" : "skip",
        top.length ? `${ok}/${top.length} accepted` : "No personal emails",
        Date.now() - t,
        ok,
      ),
    );
  }

  void isValidEmailSyntax;
  void resilientFetch;

  return {
    domain,
    companyName,
    legalName,
    hops,
    people: [...peopleMap.values()],
    contacts: [...contacts.values()],
    durationMs: Date.now() - t0,
    socialProfiles,
  };
}
