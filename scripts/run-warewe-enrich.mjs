/**
 * One-shot: find + enrich all contacts for warewe.com via waterfall.
 * Run: npx vite-node scripts/run-warewe-enrich.mjs
 */
import { waterfallSearchDomain } from "../src/lib/email-finder/waterfall.ts";
import { verifyEmail } from "../src/lib/email-finder/verify.ts";
import { indexStats } from "../src/lib/email-finder/index-store.ts";

const domain = process.argv[2] || "warewe.com";
console.log(`\n▶ Waterfall domain search: ${domain}\n`);

const r = await waterfallSearchDomain(domain, { verifyRoles: true });

console.log("── Waterfall stages ──");
for (const s of r.waterfall) {
  console.log(
    `  [${s.status.padEnd(5)}] ${s.provider.padEnd(18)} ${s.ms}ms  ${s.detail}`,
  );
}

console.log("\n── Domain intel ──");
console.log({
  domain: r.domain,
  company: r.companyName,
  website: r.website,
  hasMx: r.hasMx,
  mxProvider: r.mxProvider,
  mxHosts: r.mxHosts,
  pagesCrawled: r.pagesCrawled,
  durationMs: r.durationMs,
  fromIndex: r.fromIndex,
  fromCrawl: r.fromCrawl,
});

// Enrich: re-verify every email with full SMTP for freshest status
console.log("\n── Enrichment (SMTP re-verify) ──");
const enriched = [];
for (const e of r.emails) {
  const v = await verifyEmail(e.email, { skipSmtp: false });
  enriched.push({
    email: e.email,
    confidence: e.confidence,
    crawlStatus: e.status,
    verifyStatus: v.status,
    isCatchAll: v.isCatchAll,
    isRoleBased: e.isRoleBased || v.isRoleBased,
    mxProvider: v.mxProvider,
    smtpCode: v.smtpCode,
    smtpMessage: v.smtpMessage,
    firstName: e.firstName ?? null,
    lastName: e.lastName ?? null,
    title: e.title ?? null,
    pattern: e.patternLabel ?? e.patternId ?? null,
    sources: e.sources.map((s) => s.url),
    sourceCount: e.sources.length,
    latencyMs: v.latencyMs,
  });
  console.log(
    `  ${e.email.padEnd(32)} conf=${String(e.confidence).padStart(2)}%  crawl=${String(e.status).padEnd(10)} smtp=${v.status.padEnd(10)} sources=${e.sources.length}`,
  );
}

const stats = await indexStats();
console.log("\n── Index after write-back ──", stats);

const out = {
  domain: r.domain,
  company: r.companyName,
  waterfall: r.waterfall,
  patterns: r.patterns,
  contacts: enriched,
  indexStats: stats,
};
console.log("\n── JSON summary ──");
console.log(JSON.stringify(out, null, 2));
