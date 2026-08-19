/** Shared types for the Mailgraph email discovery pipeline. */

export type PatternId =
  | "first.last"
  | "first_last"
  | "first-last"
  | "firstlast"
  | "first"
  | "last"
  | "f.last"
  | "f_last"
  | "flast"
  | "firstl"
  | "first.l"
  | "last.first"
  | "last_first"
  | "lastfirst"
  | "lfirst"
  | "last.f"
  | "first.middle.last"
  | "f.m.last"
  | "firstmiddlelast";

export type VerificationStatus =
  | "valid"
  | "invalid"
  | "catch_all"
  | "unknown"
  | "disposable"
  | "role_based"
  | "no_mx"
  | "syntax_error";

export type ResultSource =
  | "knowledge_base"
  | "domain_pattern"
  | "global_prior"
  | "smtp_verified"
  | "public_index"
  | "linkedin_parse";

export interface ParsedName {
  first: string;
  last: string;
  middle?: string;
  raw: string;
}

export interface EmailPattern {
  id: PatternId;
  label: string;
  /** Global base prior (0–1) from published B2B pattern studies. */
  globalPrior: number;
  template: (n: ParsedName) => string;
}

export interface DomainIntelligence {
  domain: string;
  normalizedDomain: string;
  hasMx: boolean;
  mxHosts: string[];
  mxProvider: string | null;
  isCatchAllLikely: boolean;
  isDisposable: boolean;
  patterns: DomainPatternHit[];
  knownEmails: KnownEmail[];
  sampleSize: number;
  confidence: number;
}

export interface DomainPatternHit {
  patternId: PatternId;
  label: string;
  prevalence: number;
  sampleCount: number;
  example: string;
}

export interface KnownEmail {
  email: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  department?: string;
  sources: string[];
  confidence: number;
}

export interface CandidateEmail {
  email: string;
  patternId: PatternId;
  patternLabel: string;
  priorScore: number;
  sources: ResultSource[];
}

export interface VerificationResult {
  email: string;
  status: VerificationStatus;
  syntaxValid: boolean;
  hasMx: boolean;
  mxHosts: string[];
  mxProvider: string | null;
  isDisposable: boolean;
  isRoleBased: boolean;
  isCatchAll: boolean;
  smtpCode: number | null;
  smtpMessage: string | null;
  checkedAt: string;
  latencyMs: number;
}

export interface ScoredResult {
  email: string;
  confidence: number;
  status: VerificationStatus;
  patternId: PatternId;
  patternLabel: string;
  sources: ResultSource[];
  reasons: string[];
  verification: VerificationResult;
  rank: number;
}

export interface FindEmailResult {
  query: {
    fullName: string;
    domain: string;
    linkedinUrl?: string;
  };
  name: ParsedName;
  domainIntel: DomainIntelligence;
  best: ScoredResult | null;
  alternatives: ScoredResult[];
  pipeline: PipelineStep[];
  durationMs: number;
}

export interface PipelineStep {
  id: string;
  label: string;
  status: "ok" | "warn" | "skip" | "error";
  detail: string;
  ms: number;
}

export interface DomainSearchResult {
  domainIntel: DomainIntelligence;
  emails: KnownEmail[];
  patterns: DomainPatternHit[];
  durationMs: number;
}

export interface BulkFindRow {
  fullName: string;
  domain: string;
  email: string | null;
  confidence: number;
  status: VerificationStatus | "not_found";
  pattern?: string;
}

export interface LinkedInParse {
  profileUrl: string;
  slug: string;
  guessedName: ParsedName | null;
  companyHint: string | null;
  domainHint: string | null;
}
