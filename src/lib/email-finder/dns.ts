import { resolveMx, resolveTxt } from "node:dns/promises";
import { isDisposableDomain } from "./disposable";

export interface MxLookupResult {
  domain: string;
  hasMx: boolean;
  mxHosts: Array<{ exchange: string; priority: number }>;
  provider: string | null;
  isNullMx: boolean;
  isDisposable: boolean;
  hasSpf: boolean;
  hasDmarc: boolean;
  latencyMs: number;
  error: string | null;
}

function detectProvider(hosts: string[]): string | null {
  const joined = hosts.join(" ").toLowerCase();
  if (joined.includes("google") || joined.includes("googlemail") || joined.includes("aspmx")) {
    return "Google Workspace";
  }
  if (joined.includes("outlook") || joined.includes("protection.outlook") || joined.includes("microsoft")) {
    return "Microsoft 365";
  }
  if (joined.includes("pphosted") || joined.includes("proofpoint")) return "Proofpoint";
  if (joined.includes("mimecast")) return "Mimecast";
  if (joined.includes("messagelabs") || joined.includes("symantec")) return "Symantec";
  if (joined.includes("barracuda")) return "Barracuda";
  if (joined.includes("zoho")) return "Zoho Mail";
  if (joined.includes("secureserver") || joined.includes("godaddy")) return "GoDaddy";
  if (joined.includes("emailsrvr") || joined.includes("rackspace")) return "Rackspace";
  if (joined.includes("mailgun")) return "Mailgun";
  if (joined.includes("sendgrid")) return "SendGrid";
  if (joined.includes("amazonaws") || joined.includes("amazonses")) return "Amazon SES";
  if (joined.includes("protonmail")) return "Proton Mail";
  if (joined.includes("fastmail")) return "Fastmail";
  if (joined.includes("icloud") || joined.includes("apple")) return "iCloud";
  if (joined.includes("yahoo")) return "Yahoo";
  return null;
}

/**
 * DNS MX + SPF/DMARC hygiene signals.
 * Null MX (RFC 7505) is treated as hard undeliverable.
 */
export async function lookupMx(domain: string): Promise<MxLookupResult> {
  const started = Date.now();
  const base: MxLookupResult = {
    domain,
    hasMx: false,
    mxHosts: [],
    provider: null,
    isNullMx: false,
    isDisposable: isDisposableDomain(domain),
    hasSpf: false,
    hasDmarc: false,
    latencyMs: 0,
    error: null,
  };

  try {
    const records = await Promise.race([
      resolveMx(domain),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("MX lookup timeout")), 4000),
      ),
    ]);

    const sorted = [...records].sort((a, b) => a.priority - b.priority);
    // Null MX: priority 0 and exchange "." (RFC 7505)
    const isNullMx = sorted.some(
      (r) => r.exchange === "." || r.exchange === "",
    );

    base.mxHosts = sorted.map((r) => ({
      exchange: r.exchange,
      priority: r.priority,
    }));
    base.isNullMx = isNullMx;
    base.hasMx = sorted.length > 0 && !isNullMx;
    base.provider = detectProvider(sorted.map((r) => r.exchange));
  } catch (err) {
    base.error = err instanceof Error ? err.message : "MX lookup failed";
  }

  // Soft TXT probes (non-blocking for pipeline if they fail)
  try {
    const [spfTxt, dmarcTxt] = await Promise.all([
      resolveTxt(domain).catch(() => [] as string[][]),
      resolveTxt(`_dmarc.${domain}`).catch(() => [] as string[][]),
    ]);
    base.hasSpf = spfTxt.some((parts) =>
      parts.join("").toLowerCase().includes("v=spf1"),
    );
    base.hasDmarc = dmarcTxt.some((parts) =>
      parts.join("").toLowerCase().includes("v=dmarc1"),
    );
  } catch {
    // ignore
  }

  base.latencyMs = Date.now() - started;
  return base;
}
