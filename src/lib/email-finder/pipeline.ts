import { generateCandidates } from "./candidates";
import { lookupMx } from "./dns";
import {
  getKnownEmailsForDomain,
  getPatternHitsForDomain,
  getDomainSeed,
  inferPatternPrevalence,
  lookupExactPerson,
  resolveCompanyDomain,
} from "./knowledge-base";
import { parseLinkedInUrl } from "./linkedin";
import {
  isValidDomainShape,
  normalizeDomain,
  parseFullName,
} from "./normalize";
import { rankResults, scoreCandidate } from "./score";
import { verifyEmail } from "./verify";
import { isDisposableDomain, isFreePersonalDomain } from "./disposable";
import {
  waterfallFindEmail,
  waterfallSearchDomain,
  type WaterfallDomainResult,
  type WaterfallFindResult,
} from "./waterfall";
import type {
  BulkFindRow,
  DomainIntelligence,
  FindEmailResult,
  PipelineStep,
  ResultSource,
  ScoredResult,
} from "./types";

const MAX_SMTP_CANDIDATES = 4;

function step(
  id: string,
  label: string,
  status: PipelineStep["status"],
  detail: string,
  ms: number,
): PipelineStep {
  return { id, label, status, detail, ms };
}

async function buildDomainIntel(domain: string): Promise<{
  intel: DomainIntelligence;
  mxMs: number;
}> {
  const t0 = Date.now();
  const mx = await lookupMx(domain);
  const seed = getDomainSeed(domain);
  const patterns = getPatternHitsForDomain(domain);
  const knownEmails = getKnownEmailsForDomain(domain);
  const sampleSize = patterns.reduce((s, p) => s + p.sampleCount, 0);

  const isCatchAllLikely = seed?.catchAllLikely === true;

  const confidence =
    sampleSize >= 20
      ? 90
      : sampleSize >= 5
        ? 75
        : seed
          ? 60
          : mx.hasMx
            ? 35
            : 10;

  return {
    intel: {
      domain: seed?.domain ?? domain,
      normalizedDomain: domain,
      hasMx: mx.hasMx,
      mxHosts: mx.mxHosts.map((h) => h.exchange),
      mxProvider: mx.provider,
      isCatchAllLikely,
      isDisposable: isDisposableDomain(domain) || mx.isDisposable,
      patterns,
      knownEmails,
      sampleSize,
      confidence,
    },
    mxMs: Date.now() - t0,
  };
}

/** Clay-style multi-provider waterfall (preferred entry). */
export async function findEmail(input: {
  fullName: string;
  domain: string;
  linkedinUrl?: string;
  skipSmtp?: boolean;
  skipDeepResearch?: boolean;
}): Promise<WaterfallFindResult> {
  return waterfallFindEmail(input);
}

/** Legacy single-path finder kept for bulk/tests — prefer findEmail. */
export async function findEmailLegacy(input: {
  fullName: string;
  domain: string;
  linkedinUrl?: string;
  skipSmtp?: boolean;
}): Promise<FindEmailResult> {
  const tStart = Date.now();
  const pipeline: PipelineStep[] = [];

  const t1 = Date.now();
  const domain = resolveCompanyDomain(input.domain);
  if (!isValidDomainShape(domain)) {
    pipeline.push(
      step(
        "domain",
        "Domain resolution",
        "error",
        `Invalid domain: ${input.domain}`,
        Date.now() - t1,
      ),
    );
    const emptyIntel: DomainIntelligence = {
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
    };
    return {
      query: {
        fullName: input.fullName,
        domain: input.domain,
        linkedinUrl: input.linkedinUrl,
      },
      name: parseFullName(input.fullName),
      domainIntel: emptyIntel,
      best: null,
      alternatives: [],
      pipeline,
      durationMs: Date.now() - tStart,
    };
  }
  pipeline.push(
    step(
      "domain",
      "Domain resolution",
      "ok",
      `Resolved to ${domain}${getDomainSeed(domain) ? " (known org graph)" : ""}`,
      Date.now() - t1,
    ),
  );

  const t2 = Date.now();
  let name = parseFullName(input.fullName);
  const sources: ResultSource[] = [];

  if (input.linkedinUrl) {
    const li = parseLinkedInUrl(input.linkedinUrl);
    if (li.guessedName && (!name.first || !name.last)) {
      name = li.guessedName;
      sources.push("linkedin_parse");
    } else if (li.guessedName && input.fullName.trim() === "") {
      name = li.guessedName;
      sources.push("linkedin_parse");
    } else if (li.guessedName) {
      sources.push("linkedin_parse");
    }
  }

  if (!name.first) {
    pipeline.push(
      step(
        "name",
        "Name parsing",
        "error",
        "Could not parse a first name",
        Date.now() - t2,
      ),
    );
    const { intel } = await buildDomainIntel(domain);
    return {
      query: {
        fullName: input.fullName,
        domain: input.domain,
        linkedinUrl: input.linkedinUrl,
      },
      name,
      domainIntel: intel,
      best: null,
      alternatives: [],
      pipeline,
      durationMs: Date.now() - tStart,
    };
  }

  pipeline.push(
    step(
      "name",
      "Name parsing",
      "ok",
      `Parsed as ${name.first}${name.middle ? ` ${name.middle}` : ""}${name.last ? ` ${name.last}` : ""}`,
      Date.now() - t2,
    ),
  );

  const { intel, mxMs } = await buildDomainIntel(domain);
  pipeline.push(
    step(
      "mx",
      "MX / DNS intelligence",
      intel.hasMx ? "ok" : "error",
      intel.hasMx
        ? `MX via ${intel.mxProvider ?? intel.mxHosts[0] ?? "unknown"} · ${intel.sampleSize} pattern samples · conf ${intel.confidence}%`
        : "No usable MX records — domain cannot receive mail",
      mxMs,
    ),
  );

  if (intel.isDisposable) {
    pipeline.push(
      step(
        "hygiene",
        "Domain hygiene",
        "error",
        "Disposable domain blocked",
        0,
      ),
    );
    return {
      query: {
        fullName: input.fullName,
        domain: input.domain,
        linkedinUrl: input.linkedinUrl,
      },
      name,
      domainIntel: intel,
      best: null,
      alternatives: [],
      pipeline,
      durationMs: Date.now() - tStart,
    };
  }

  if (isFreePersonalDomain(domain)) {
    pipeline.push(
      step(
        "hygiene",
        "Domain hygiene",
        "warn",
        "Free-mail domain — not a company mailbox target",
        0,
      ),
    );
  }

  const t4 = Date.now();
  const kbHit = lookupExactPerson(name.first, name.last, domain);
  const candidates = generateCandidates(name, domain, sources);
  pipeline.push(
    step(
      "patterns",
      "Pattern + index match",
      kbHit ? "ok" : candidates.length ? "ok" : "warn",
      kbHit
        ? `Exact index hit: ${kbHit.email}`
        : `Generated ${candidates.length} candidates · top ${candidates[0]?.patternLabel ?? "—"}`,
      Date.now() - t4,
    ),
  );

  const t5 = Date.now();
  const toVerify = candidates.slice(0, MAX_SMTP_CANDIDATES);
  const scored: ScoredResult[] = [];

  for (const c of toVerify) {
    const verification = await verifyEmail(c.email, {
      skipSmtp: input.skipSmtp || !intel.hasMx,
    });
    if (
      verification.status === "valid" &&
      !c.sources.includes("smtp_verified")
    ) {
      c.sources.push("smtp_verified");
    }
    const { prevalence, sampleCount, fromSeed } = inferPatternPrevalence(
      domain,
      c.patternId,
    );
    const result = scoreCandidate(c, verification, {
      domainPatternPrevalence: prevalence,
      domainSampleCount: sampleCount,
      domainKnown: fromSeed,
      exactKbHit: Boolean(kbHit && kbHit.email === c.email),
    });
    scored.push(result);

    if (verification.status === "valid" && result.confidence >= 85) {
      break;
    }

    if (verification.isCatchAll) {
      for (const rest of candidates.slice(scored.length, MAX_SMTP_CANDIDATES)) {
        const v = { ...verification, email: rest.email };
        const prev = inferPatternPrevalence(domain, rest.patternId);
        scored.push(
          scoreCandidate(rest, v, {
            domainPatternPrevalence: prev.prevalence,
            domainSampleCount: prev.sampleCount,
            domainKnown: prev.fromSeed,
            exactKbHit: Boolean(kbHit && kbHit.email === rest.email),
          }),
        );
      }
      break;
    }
  }

  const verifiedEmails = new Set(scored.map((s) => s.email));
  for (const c of candidates.slice(0, 8)) {
    if (verifiedEmails.has(c.email)) continue;
    const verification = await verifyEmail(c.email, { skipSmtp: true });
    const prev = inferPatternPrevalence(domain, c.patternId);
    scored.push(
      scoreCandidate(c, verification, {
        domainPatternPrevalence: prev.prevalence,
        domainSampleCount: prev.sampleCount,
        domainKnown: prev.fromSeed,
        exactKbHit: Boolean(kbHit && kbHit.email === c.email),
      }),
    );
  }

  const ranked = rankResults(scored);
  const best = ranked[0] ?? null;
  const alternatives = ranked.slice(1, 6);

  pipeline.push(
    step(
      "verify",
      "Multi-layer verification",
      best && best.status === "valid"
        ? "ok"
        : best && best.confidence >= 70
          ? "ok"
          : "warn",
      best
        ? `Best: ${best.email} · ${best.confidence}% · ${best.status}`
        : "No viable candidate",
      Date.now() - t5,
    ),
  );

  const usableBest =
    best && best.status !== "invalid" && best.status !== "no_mx"
      ? best
      : (ranked.find((r) => r.status !== "invalid" && r.status !== "no_mx") ??
        null);

  return {
    query: {
      fullName: input.fullName,
      domain: input.domain,
      linkedinUrl: input.linkedinUrl,
    },
    name,
    domainIntel: intel,
    best: usableBest,
    alternatives: usableBest
      ? ranked.filter((r) => r.email !== usableBest.email).slice(0, 5)
      : alternatives,
    pipeline,
    durationMs: Date.now() - tStart,
  };
}

export async function findByLinkedIn(input: {
  linkedinUrl: string;
  domain?: string;
  fullName?: string;
  skipSmtp?: boolean;
}): Promise<WaterfallFindResult> {
  const t0 = Date.now();
  const { enrichLinkedInProfile } = await import("./linkedin-public");
  const profile = await enrichLinkedInProfile(input.linkedinUrl);
  const fullName =
    input.fullName?.trim() ||
    profile?.fullName ||
    "";
  let domain =
    (input.domain?.trim() || profile?.domain || "").replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] ?? "";

  if (!fullName.split(/\s+/).filter(Boolean).length) {
    return {
      query: { fullName: "", domain, linkedinUrl: input.linkedinUrl },
      name: { first: "", last: "", raw: "" },
      domainIntel: {
        domain: "",
        normalizedDomain: "",
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
      pipeline: [
        step(
          "linkedin",
          "LinkedIn profile",
          "error",
          "Could not read a public name from that URL",
          Date.now() - t0,
        ),
      ],
      durationMs: Date.now() - t0,
      waterfall: [
        {
          id: "linkedin",
          provider: "LinkedIn public profile",
          status: "error",
          detail: "Could not read name from public profile",
          ms: Date.now() - t0,
          emailsFound: 0,
        },
      ],
      winningProvider: null,
      indexStats: { totalEmails: 0, domains: 0 },
    };
  }

  if (profile?.company) {
    try {
      const { companyNameFitsDomain } = await import("./identity-lock");
      const { resolveCompanyDomain } = await import("./company-suggest");
      if (!domain || !companyNameFitsDomain(profile.company, domain)) {
        domain = (await resolveCompanyDomain(profile.company)) ?? "";
      }
    } catch {
      /* */
    }
  }

  if (!domain) {
    const who = [fullName, profile?.title, profile?.company].filter(Boolean).join(" · ");
    return {
      query: { fullName, domain: "", linkedinUrl: input.linkedinUrl },
      name: parseFullName(fullName),
      domainIntel: {
        domain: "",
        normalizedDomain: "",
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
      pipeline: [
        step(
          "linkedin",
          "LinkedIn public profile",
          "ok",
          who,
          Date.now() - t0,
        ),
        step(
          "domain",
          "Company domain",
          "error",
          profile?.company
            ? `Found ${profile.company} but no website`
            : "No company on the public profile — add a domain",
          0,
        ),
      ],
      durationMs: Date.now() - t0,
      waterfall: [
        {
          id: "linkedin",
          provider: "LinkedIn public profile",
          status: "ok",
          detail: who,
          ms: Date.now() - t0,
          emailsFound: 0,
        },
        {
          id: "domain",
          provider: "Domain resolver",
          status: "error",
          detail: profile?.company
            ? `Company ${profile.company} has no resolvable domain`
            : "Company domain not on public profile",
          ms: 0,
          emailsFound: 0,
        },
      ],
      winningProvider: null,
      indexStats: { totalEmails: 0, domains: 0 },
    };
  }

  const found = await Promise.race([
    findEmail({
      fullName,
      domain,
      linkedinUrl: profile?.linkedinUrl || input.linkedinUrl,
      skipSmtp: input.skipSmtp,
      skipDeepResearch: true,
    }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 22_000)),
  ]);
  if (!found) {
    const who = [fullName, profile?.title, profile?.company, domain]
      .filter(Boolean)
      .join(" · ");
    return {
      query: { fullName, domain, linkedinUrl: input.linkedinUrl },
      name: parseFullName(fullName),
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
      pipeline: [
        step("linkedin", "LinkedIn public profile", "ok", who, Date.now() - t0),
        step("verify", "Email verify", "error", "Timed out verifying mailbox", 0),
      ],
      durationMs: Date.now() - t0,
      waterfall: [
        {
          id: "linkedin",
          provider: "LinkedIn public profile",
          status: "ok",
          detail: who,
          ms: Date.now() - t0,
          emailsFound: 0,
        },
        {
          id: "verify",
          provider: "SMTP",
          status: "error",
          detail: "Verification timed out — try Name finder with the domain",
          ms: 0,
          emailsFound: 0,
        },
      ],
      winningProvider: null,
      indexStats: { totalEmails: 0, domains: 0 },
    };
  }
  return found;
}

export async function searchDomain(
  domainInput: string,
  options: { verifyRoles?: boolean } = {},
): Promise<WaterfallDomainResult> {
  return waterfallSearchDomain(domainInput, options);
}

export async function bulkFind(
  rows: Array<{ fullName: string; domain: string }>,
  options: { skipSmtp?: boolean; limit?: number } = {},
): Promise<BulkFindRow[]> {
  const limit = Math.min(options.limit ?? 25, 50);
  const slice = rows.slice(0, limit);
  const results: BulkFindRow[] = [];

  for (const row of slice) {
    try {
      const found = await findEmail({
        fullName: row.fullName,
        domain: row.domain,
        skipSmtp: options.skipSmtp ?? true,
      });
      results.push({
        fullName: row.fullName,
        domain: normalizeDomain(resolveCompanyDomain(row.domain)),
        email: found.best?.email ?? null,
        confidence: found.best?.confidence ?? 0,
        status: found.best?.status ?? "not_found",
        pattern: found.best?.patternLabel,
      });
    } catch {
      results.push({
        fullName: row.fullName,
        domain: row.domain,
        email: null,
        confidence: 0,
        status: "not_found",
      });
    }
  }

  return results;
}
