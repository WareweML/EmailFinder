import type { EmailPattern, ParsedName, PatternId } from "./types";

/**
 * Pattern priors synthesized from public B2B format studies
 * (Tomba 2026: ~70–80% of corporates use first.last / first / flast / firstlast;
 * Cleanlist: first.last dominant at enterprise Microsoft 365 defaults).
 *
 * These are GLOBAL priors; domain-specific evidence overrides them heavily.
 */
export const PATTERNS: EmailPattern[] = [
  {
    id: "first.last",
    label: "first.last",
    globalPrior: 0.4,
    template: (n) => `${n.first}.${n.last}`,
  },
  {
    id: "first",
    label: "first",
    globalPrior: 0.15,
    template: (n) => n.first,
  },
  {
    id: "flast",
    label: "flast",
    globalPrior: 0.13,
    template: (n) => `${n.first.charAt(0)}${n.last}`,
  },
  {
    id: "firstlast",
    label: "firstlast",
    globalPrior: 0.1,
    template: (n) => `${n.first}${n.last}`,
  },
  {
    id: "first_last",
    label: "first_last",
    globalPrior: 0.05,
    template: (n) => `${n.first}_${n.last}`,
  },
  {
    id: "first-last",
    label: "first-last",
    globalPrior: 0.04,
    template: (n) => `${n.first}-${n.last}`,
  },
  {
    id: "f.last",
    label: "f.last",
    globalPrior: 0.035,
    template: (n) => `${n.first.charAt(0)}.${n.last}`,
  },
  {
    id: "first.l",
    label: "first.l",
    globalPrior: 0.025,
    template: (n) => `${n.first}.${n.last.charAt(0)}`,
  },
  {
    id: "firstl",
    label: "firstl",
    globalPrior: 0.02,
    template: (n) => `${n.first}${n.last.charAt(0)}`,
  },
  {
    id: "last",
    label: "last",
    globalPrior: 0.015,
    template: (n) => n.last,
  },
  {
    id: "last.first",
    label: "last.first",
    globalPrior: 0.012,
    template: (n) => `${n.last}.${n.first}`,
  },
  {
    id: "lastfirst",
    label: "lastfirst",
    globalPrior: 0.008,
    template: (n) => `${n.last}${n.first}`,
  },
  {
    id: "lfirst",
    label: "lfirst",
    globalPrior: 0.007,
    template: (n) => `${n.last.charAt(0)}${n.first}`,
  },
  {
    id: "last.f",
    label: "last.f",
    globalPrior: 0.006,
    template: (n) => `${n.last}.${n.first.charAt(0)}`,
  },
  {
    id: "f_last",
    label: "f_last",
    globalPrior: 0.005,
    template: (n) => `${n.first.charAt(0)}_${n.last}`,
  },
  {
    id: "last_first",
    label: "last_first",
    globalPrior: 0.004,
    template: (n) => `${n.last}_${n.first}`,
  },
  {
    id: "first.middle.last",
    label: "first.middle.last",
    globalPrior: 0.003,
    template: (n) =>
      n.middle ? `${n.first}.${n.middle}.${n.last}` : `${n.first}.${n.last}`,
  },
  {
    id: "f.m.last",
    label: "f.m.last",
    globalPrior: 0.002,
    template: (n) =>
      n.middle
        ? `${n.first.charAt(0)}.${n.middle.charAt(0)}.${n.last}`
        : `${n.first.charAt(0)}.${n.last}`,
  },
  {
    id: "firstmiddlelast",
    label: "firstmiddlelast",
    globalPrior: 0.001,
    template: (n) =>
      n.middle ? `${n.first}${n.middle}${n.last}` : `${n.first}${n.last}`,
  },
];

export const PATTERN_MAP = new Map(PATTERNS.map((p) => [p.id, p]));

export function buildLocalPart(
  patternId: PatternId,
  name: ParsedName,
): string | null {
  if (!name.first) return null;
  const pattern = PATTERN_MAP.get(patternId);
  if (!pattern) return null;
  if (!name.last) {
    if (patternId === "first") return name.first;
    return null;
  }
  const local = pattern.template(name);
  if (!local || local.includes("undefined")) return null;
  return local;
}

export function applyPattern(
  patternId: PatternId,
  name: ParsedName,
  domain: string,
): string | null {
  const local = buildLocalPart(patternId, name);
  if (!local) return null;
  return `${local}@${domain}`;
}

/** Detect which pattern a known email most likely uses. */
export function detectPatternFromEmail(
  email: string,
  first?: string,
  last?: string,
): PatternId | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const local = email.slice(0, at).toLowerCase();
  const f = first ? first.toLowerCase() : "";
  const l = last ? last.toLowerCase() : "";

  if (f && l) {
    const candidates: Array<[PatternId, string]> = [
      ["first.last", `${f}.${l}`],
      ["first_last", `${f}_${l}`],
      ["first-last", `${f}-${l}`],
      ["firstlast", `${f}${l}`],
      ["flast", `${f.charAt(0)}${l}`],
      ["f.last", `${f.charAt(0)}.${l}`],
      ["first.l", `${f}.${l.charAt(0)}`],
      ["firstl", `${f}${l.charAt(0)}`],
      ["last.first", `${l}.${f}`],
      ["last_first", `${l}_${f}`],
      ["lastfirst", `${l}${f}`],
      ["lfirst", `${l.charAt(0)}${f}`],
      ["last.f", `${l}.${f.charAt(0)}`],
      ["f_last", `${f.charAt(0)}_${l}`],
      ["first", f],
      ["last", l],
    ];
    for (const [id, expected] of candidates) {
      if (local === expected) return id;
    }
  }

  if (local.includes(".")) return "first.last";
  if (local.includes("_")) return "first_last";
  if (local.includes("-")) return "first-last";
  return "firstlast";
}
