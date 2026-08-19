import { lookupMx } from "./dns";
import { smtpProbe } from "./smtp";
import {
  isDisposableDomain,
  isFreePersonalDomain,
  isRoleBasedEmail,
} from "./disposable";
import { isValidEmailSyntax, normalizeDomain } from "./normalize";
import type { VerificationResult, VerificationStatus } from "./types";

export async function verifyEmail(
  email: string,
  options: { skipSmtp?: boolean } = {},
): Promise<VerificationResult> {
  const started = Date.now();
  const normalized = email.trim().toLowerCase();
  const syntaxValid = isValidEmailSyntax(normalized);
  const domain = syntaxValid
    ? normalizeDomain(normalized.split("@")[1] ?? "")
    : "";

  if (!syntaxValid) {
    return emptyResult(normalized, "syntax_error", started, {
      syntaxValid: false,
    });
  }

  const isDisposable = isDisposableDomain(domain);
  const isRoleBased = isRoleBasedEmail(normalized);
  const isFree = isFreePersonalDomain(domain);

  if (isDisposable) {
    return emptyResult(normalized, "disposable", started, {
      syntaxValid: true,
      isDisposable: true,
      isRoleBased,
    });
  }

  const mx = await lookupMx(domain);

  if (!mx.hasMx) {
    return {
      email: normalized,
      status: "no_mx",
      syntaxValid: true,
      hasMx: false,
      mxHosts: mx.mxHosts.map((h) => h.exchange),
      mxProvider: mx.provider,
      isDisposable,
      isRoleBased,
      isCatchAll: false,
      smtpCode: null,
      smtpMessage: mx.isNullMx ? "Null MX (RFC 7505) — domain rejects mail" : mx.error,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
    };
  }

  let status: VerificationStatus = "unknown";
  let smtpCode: number | null = null;
  let smtpMessage: string | null = null;
  let isCatchAll = false;

  // Free personal domains: skip SMTP (often blocked / irrelevant for B2B)
  if (!options.skipSmtp && !isFree) {
    const probe = await smtpProbe(normalized, mx);
    smtpCode = probe.code;
    smtpMessage = probe.message ?? probe.error;
    isCatchAll = probe.isCatchAll;

    if (probe.isCatchAll) {
      status = "catch_all";
    } else if (probe.mailboxExists === true) {
      status = "valid";
    } else if (probe.mailboxExists === false) {
      status = "invalid";
    } else {
      status = "unknown";
      if (!smtpMessage) {
        smtpMessage =
          "SMTP greylisted or filtered — common for Google Workspace / Microsoft 365";
      }
    }
  } else if (isFree) {
    smtpMessage = "Free-mail domain — professional verification skipped";
    status = "unknown";
  }

  if (isRoleBased && status === "unknown") {
    status = "role_based";
  }

  return {
    email: normalized,
    status,
    syntaxValid: true,
    hasMx: true,
    mxHosts: mx.mxHosts.map((h) => h.exchange),
    mxProvider: mx.provider,
    isDisposable,
    isRoleBased,
    isCatchAll,
    smtpCode,
    smtpMessage,
    checkedAt: new Date().toISOString(),
    latencyMs: Date.now() - started,
  };
}

function emptyResult(
  email: string,
  status: VerificationStatus,
  started: number,
  extra: Partial<VerificationResult>,
): VerificationResult {
  return {
    email,
    status,
    syntaxValid: extra.syntaxValid ?? false,
    hasMx: false,
    mxHosts: [],
    mxProvider: null,
    isDisposable: extra.isDisposable ?? false,
    isRoleBased: extra.isRoleBased ?? false,
    isCatchAll: false,
    smtpCode: null,
    smtpMessage: null,
    checkedAt: new Date().toISOString(),
    latencyMs: Date.now() - started,
    ...extra,
  };
}
