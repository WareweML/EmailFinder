import { deepResearchDomain } from "../src/lib/email-finder/research-agent.ts";
import { waterfallSearchDomain } from "../src/lib/email-finder/waterfall.ts";

const domain = process.argv[2] || "warewe.com";
console.log("\n=== DEEP RESEARCH", domain, "===\n");
const r = await deepResearchDomain(domain);
for (const h of r.hops) {
  console.log(
    `[${h.status.padEnd(5)}] ${h.label.padEnd(20)} ${String(h.ms).padStart(5)}ms  ${h.detail}`,
  );
}
console.log("\nLegal:", r.legalName, "| Company:", r.companyName);
console.log("\n── PEOPLE ──");
for (const p of r.people) {
  console.log(
    `  ${p.fullName.padEnd(28)} ${p.title ?? ""}  emails=${p.emails.map((e) => e.email + ":" + e.status).join(", ") || "—"}`,
  );
  for (const ev of p.evidence) console.log("     ·", ev);
}
console.log("\n── CONTACTS ──");
for (const c of r.contacts) {
  console.log(
    `  ${c.email.padEnd(32)} ${String(c.confidence).padStart(2)}%  ${c.status.padEnd(8)}  ${c.isRoleBased ? "ROLE" : "PERSON"}  ${[c.firstName, c.lastName].filter(Boolean).join(" ")}  ${c.title ?? ""}`,
  );
  console.log("     sources:", c.sources.slice(0, 3).join(" | "));
  console.log("     evidence:", c.evidence.join("; "));
}
console.log("\nDuration", r.durationMs, "ms");

console.log("\n=== WATERFALL DOMAIN SEARCH ===\n");
const w = await waterfallSearchDomain(domain);
console.log(
  "emails",
  w.emails.map((e) => ({
    email: e.email,
    conf: e.confidence,
    status: e.status,
    role: e.isRoleBased,
    name: [e.firstName, e.lastName].filter(Boolean).join(" "),
  })),
);
console.log(
  "people",
  w.people,
);
