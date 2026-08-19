import type {
  CandidateEmail,
  ResultSource,
  ScoredResult,
  VerificationResult,
  VerificationStatus,
} from "./types";

/**
 * Bayesian-inspired confidence scoring.
 *
 * Layers (evidence stacking, similar to Hunter / Tomba methodology writeups):
 * 1. Source match (knowledge base exact hit) — strongest
 * 2. Domain pattern prevalence × sample size
 * 3. Global pattern prior (when domain unknown)
 * 4. Verification outcome (SMTP / catch-all / MX)
 * 5. Hygiene penalties (role, disposable, free mail)
 *
 * Output is 0–99 integer confidence used for ranking and UI badges.
 */
export function scoreCandidate(
  candidate: CandidateEmail,
  verification: VerificationResult,
  opts: {
    domainPatternPrevalence: number;
    domainSampleCount: number;
    domainKnown: boolean;
    exactKbHit: boolean;
  },
): ScoredResult {
  const reasons: string[] = [];
  let score = 0;

  // --- Pattern prior ---
  if (opts.domainKnown && opts.domainSampleCount > 0) {
    const evidenceBoost = Math.min(0.25, Math.log10(opts.domainSampleCount + 1) / 8);
    const patternScore =
      35 + opts.domainPatternPrevalence * 45 + evidenceBoost * 100;
    score += patternScore;
    reasons.push(
      `Domain pattern ${candidate.patternLabel} at ${Math.round(opts.domainPatternPrevalence * 100)}% (${opts.domainSampleCount} samples)`,
    );
  } else {
    score += candidate.priorScore * 55;
    reasons.push(
      `Global prior for ${candidate.patternLabel} (${Math.round(candidate.priorScore * 100)}%)`,
    );
  }

  // --- Source boosts ---
  if (opts.exactKbHit || candidate.sources.includes("knowledge_base")) {
    score += 28;
    reasons.push("Exact match in public contact index");
  }
  if (candidate.sources.includes("public_index")) {
    score += 12;
    reasons.push("Seen in public web index");
  }
  if (candidate.sources.includes("linkedin_parse")) {
    score += 4;
    reasons.push("Name resolved from LinkedIn profile URL");
  }

  // --- Verification ---
  score += verificationScore(verification, reasons);

  // --- Hygiene penalties ---
  if (verification.isRoleBased) {
    score -= 25;
    reasons.push("Role-based address (generic mailbox)");
  }
  if (verification.isDisposable) {
    score -= 50;
    reasons.push("Disposable domain");
  }
  if (!verification.hasMx) {
    score -= 40;
    reasons.push("Domain has no usable MX records");
  }

  score = Math.max(1, Math.min(99, Math.round(score)));

  return {
    email: candidate.email,
    confidence: score,
    status: mapStatus(verification, score),
    patternId: candidate.patternId,
    patternLabel: candidate.patternLabel,
    sources: candidate.sources,
    reasons,
    verification,
    rank: 0,
  };
}

function verificationScore(
  v: VerificationResult,
  reasons: string[],
): number {
  switch (v.status) {
    case "valid":
      reasons.push("SMTP mailbox accepted (RCPT OK)");
      return 30;
    case "catch_all":
      reasons.push("Domain is catch-all — mailbox existence unconfirmed");
      return 8;
    case "invalid":
      reasons.push("SMTP rejected mailbox");
      return -45;
    case "no_mx":
      reasons.push("No mail exchangers");
      return -40;
    case "syntax_error":
      reasons.push("Invalid email syntax");
      return -50;
    case "disposable":
      reasons.push("Disposable domain blocked");
      return -45;
    case "role_based":
      reasons.push("Role-based local part");
      return -10;
    case "unknown":
    default:
      if (v.hasMx) {
        reasons.push(
          v.smtpMessage
            ? `SMTP inconclusive (${v.smtpMessage})`
            : "MX present; SMTP inconclusive (common for Workspace/M365 greylisting)",
        );
        return 10;
      }
      reasons.push("Verification inconclusive");
      return 0;
  }
}

function mapStatus(
  v: VerificationResult,
  confidence: number,
): VerificationStatus {
  if (v.status === "valid") return "valid";
  if (v.status === "invalid") return "invalid";
  if (v.status === "catch_all") return "catch_all";
  if (v.status === "no_mx") return "no_mx";
  if (v.status === "disposable") return "disposable";
  if (v.status === "syntax_error") return "syntax_error";
  if (v.status === "role_based") return "role_based";
  // Unknown but high pattern confidence → treat as unknown (not valid)
  if (confidence >= 80 && v.hasMx) return "unknown";
  return v.status;
}

export function rankResults(results: ScoredResult[]): ScoredResult[] {
  return [...results]
    .sort((a, b) => {
      // Prefer valid over others, then confidence
      const rankStatus = (s: VerificationStatus) => {
        if (s === "valid") return 0;
        if (s === "unknown" || s === "catch_all") return 1;
        if (s === "role_based") return 2;
        return 3;
      };
      const d = rankStatus(a.status) - rankStatus(b.status);
      if (d !== 0) return d;
      return b.confidence - a.confidence;
    })
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

export function sourceLabel(s: ResultSource): string {
  switch (s) {
    case "knowledge_base":
      return "Contact index";
    case "domain_pattern":
      return "Domain pattern";
    case "global_prior":
      return "Global prior";
    case "smtp_verified":
      return "SMTP verified";
    case "public_index":
      return "Public web";
    case "linkedin_parse":
      return "LinkedIn";
    default:
      return s;
  }
}
