import { applyPattern, PATTERNS } from "./patterns";
import {
  getPatternHitsForDomain,
  lookupExactPerson,
  inferPatternPrevalence,
} from "./knowledge-base";
import type { CandidateEmail, ParsedName, ResultSource } from "./types";

/**
 * Generate ranked email candidates for a person @ domain.
 * Order: exact KB hit → domain-specific patterns → global priors.
 */
export function generateCandidates(
  name: ParsedName,
  domain: string,
  extraSources: ResultSource[] = [],
): CandidateEmail[] {
  const seen = new Set<string>();
  const out: CandidateEmail[] = [];

  const push = (c: CandidateEmail) => {
    const key = c.email.toLowerCase();
    if (seen.has(key)) {
      // merge sources
      const existing = out.find((x) => x.email === key);
      if (existing) {
        for (const s of c.sources) {
          if (!existing.sources.includes(s)) existing.sources.push(s);
        }
        existing.priorScore = Math.max(existing.priorScore, c.priorScore);
      }
      return;
    }
    seen.add(key);
    out.push(c);
  };

  // 1. Exact knowledge-base hit
  const kb = lookupExactPerson(name.first, name.last, domain);
  if (kb) {
    const patternHit = getPatternHitsForDomain(domain)[0];
    push({
      email: kb.email,
      patternId: patternHit?.patternId ?? "first.last",
      patternLabel: patternHit?.label ?? "first.last",
      priorScore: 0.99,
      sources: ["knowledge_base", "public_index", ...extraSources],
    });
  }

  // 2. Domain-specific patterns (ranked by prevalence)
  const domainPatterns = getPatternHitsForDomain(domain, name);
  for (const hit of domainPatterns) {
    const email = applyPattern(hit.patternId, name, domain);
    if (!email) continue;
    const { prevalence, fromSeed } = inferPatternPrevalence(
      domain,
      hit.patternId,
    );
    push({
      email,
      patternId: hit.patternId,
      patternLabel: hit.label,
      priorScore: prevalence,
      sources: [
        fromSeed ? "domain_pattern" : "global_prior",
        ...extraSources,
      ],
    });
  }

  // 3. Remaining global patterns not already covered
  for (const p of PATTERNS) {
    const email = applyPattern(p.id, name, domain);
    if (!email) continue;
    push({
      email,
      patternId: p.id,
      patternLabel: p.label,
      priorScore: p.globalPrior,
      sources: ["global_prior", ...extraSources],
    });
  }

  return out.sort((a, b) => b.priorScore - a.priorScore);
}
