/**
 * Head-to-head: Hunter public endpoints vs Mailgraph for
 * Kumar Manaswi @ warewe.com (same query as screenshot).
 */
import { findEmail } from "../src/lib/email-finder/pipeline.ts";
import { verifyEmail } from "../src/lib/email-finder/verify.ts";
import { resilientFetch } from "../src/lib/email-finder/http.ts";
import { deepResearchDomain } from "../src/lib/email-finder/research-agent.ts";
import fs from "fs";

const NAME = "Kumar Manaswi";
const DOMAIN = "warewe.com";

// 1) Our waterfall
console.log("=== MAILGRAPH findEmail ===");
const ours = await findEmail({
  fullName: NAME,
  domain: DOMAIN,
  linkedinUrl: "https://www.linkedin.com/in/kumarmanaswi/",
  skipSmtp: false,
});
console.log(
  JSON.stringify(
    {
      best: ours.best,
      candidates: ours.results?.slice?.(0, 8) ?? ours.candidates?.slice?.(0, 8),
      steps: ours.waterfall?.map?.((s) => ({
        id: s.id,
        status: s.status,
        detail: s.detail,
      })),
    },
    null,
    2,
  ).slice(0, 4000),
);

// 2) SMTP truth table for both claimed emails
console.log("\n=== SMTP TRUTH ===");
const emails = [
  "kumar@warewe.com", // Hunter result in screenshot
  "manaswi@warewe.com", // our earlier result
  "kumar.manaswi@warewe.com",
  "kumarmanaswi@warewe.com",
  "manaswi.kumar@warewe.com",
  "hello@warewe.com",
];
const smtp = {};
for (const e of emails) {
  const v = await verifyEmail(e, { skipSmtp: false });
  smtp[e] = {
    status: v.status,
    catchAll: v.isCatchAll,
    mx: v.mxProvider,
    reason: v.reason ?? v.detail,
  };
  console.log(e.padEnd(32), v.status, v.isCatchAll ? "catch-all" : "");
}

// 3) Hunter public API (domain-search / email-finder) — no key first
console.log("\n=== HUNTER PUBLIC (no key) ===");
const hunterAttempts = [];
const urls = [
  `https://api.hunter.io/v2/email-finder?domain=${DOMAIN}&first_name=Kumar&last_name=Manaswi`,
  `https://api.hunter.io/v2/domain-search?domain=${DOMAIN}&limit=10`,
  `https://api.hunter.io/v2/email-verifier?email=kumar@warewe.com`,
];
for (const url of urls) {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.text();
    hunterAttempts.push({
      url,
      status: res.status,
      body: body.slice(0, 1500),
    });
    console.log(res.status, url.slice(0, 80), body.slice(0, 200).replace(/\n/g, " "));
  } catch (e) {
    hunterAttempts.push({ url, error: e.message });
    console.log("ERR", url, e.message);
  }
}

// 4) Hunter public web page scrape (email-finder UI result page pattern)
console.log("\n=== HUNTER WEB (public finder page) ===");
let hunterWeb = null;
try {
  // public finder often at /email-finder with query params — try domain search page
  const page = await resilientFetch(
    `https://hunter.io/search/${DOMAIN}`,
    { timeoutMs: 15000, maxAttempts: 3, preferBot: false },
  );
  hunterWeb = {
    status: page.status,
    ok: page.ok,
    len: page.body.length,
    // extract emails on domain
    emails: [
      ...new Set(
        (page.body.match(/[a-zA-Z0-9._%+\-]+@warewe\.com/gi) || []).map((e) =>
          e.toLowerCase(),
        ),
      ),
    ],
    sample: page.body
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 800),
  };
  console.log("hunter search page", hunterWeb.status, hunterWeb.emails);
} catch (e) {
  hunterWeb = { error: e.message };
}

// try email finder landing
try {
  const page2 = await resilientFetch(
    `https://hunter.io/find/kumar/manaswi/${DOMAIN}`,
    { timeoutMs: 15000, maxAttempts: 2 },
  );
  const emails2 = [
    ...new Set(
      (page2.body.match(/[a-zA-Z0-9._%+\-]+@warewe\.com/gi) || []).map((e) =>
        e.toLowerCase(),
      ),
    ),
  ];
  console.log("hunter find path", page2.status, emails2.slice(0, 10));
  hunterWeb.findPath = { status: page2.status, emails: emails2 };
} catch (e) {
  console.log("find path err", e.message);
}

// 5) Domain deep research best person match
console.log("\n=== MAILGRAPH domain people for Manaswi ===");
const research = await deepResearchDomain(DOMAIN);
const manaswi = research.contacts.filter(
  (c) =>
    /manaswi|kumar/i.test(c.email) ||
    /manaswi/i.test(`${c.firstName} ${c.lastName}`),
);
console.log(
  manaswi.map((c) => ({
    email: c.email,
    conf: c.confidence,
    status: c.status,
    name: `${c.firstName} ${c.lastName}`,
  })),
);

const report = {
  query: { name: NAME, domain: DOMAIN },
  hunterScreenshot: {
    email: "kumar@warewe.com",
    confidence: 95,
    title: "CEO",
    sources: [
      "google site:linkedin.com kumar manaswi warewe",
      "https://warewe.com/about-us",
    ],
  },
  mailgraph: {
    best: ours.best ?? null,
    topResults: (ours.results ?? ours.candidates ?? []).slice?.(0, 6) ?? null,
  },
  smtpTruth: smtp,
  hunterApi: hunterAttempts,
  hunterWeb,
  domainPeople: manaswi,
  comparison: null,
};

// accuracy judgment
const hunterEmail = "kumar@warewe.com";
const ourBest = ours.best?.email ?? manaswi.find((c) => c.status === "valid")?.email;
const hunterSmtp = smtp[hunterEmail]?.status;
const ourSmtp = ourBest ? smtp[ourBest]?.status : null;

report.comparison = {
  hunterClaim: hunterEmail,
  hunterSmtpStatus: hunterSmtp,
  ourBest,
  ourSmtpStatus: ourSmtp,
  hunterCorrect:
    hunterSmtp === "valid"
      ? "SMTP accepts — mailbox exists (or catch-all)"
      : hunterSmtp === "invalid"
        ? "SMTP rejects — Hunter email is WRONG"
        : `SMTP ${hunterSmtp}`,
  ourCorrect:
    ourSmtp === "valid"
      ? "SMTP accepts"
      : ourSmtp === "invalid"
        ? "SMTP rejects"
        : String(ourSmtp),
  note:
    "Ground truth = SMTP RCPT on warewe.com MX (Google Workspace). Hunter confidence is proprietary; we use live SMTP + sources.",
};

console.log("\n=== COMPARISON ===");
console.log(JSON.stringify(report.comparison, null, 2));

fs.writeFileSync(
  "/workspace/data/hunter-vs-mailgraph.json",
  JSON.stringify(report, null, 2),
);
console.log("\nWrote data/hunter-vs-mailgraph.json");
