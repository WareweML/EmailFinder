import { findEmail } from "../src/lib/email-finder/pipeline.ts";
import { parseFullName } from "../src/lib/email-finder/normalize.ts";

console.log("parsed", parseFullName("Kumar Manaswi"));
const r = await findEmail({
  fullName: "Kumar Manaswi",
  domain: "warewe.com",
  linkedinUrl: "https://linkedin.com/in/kumarmanaswi",
  skipSmtp: false,
});
console.log("best", r.best?.email, r.best?.confidence, r.best?.status);
console.log("keys", Object.keys(r));
const results = r.results || r.all || r.ranked || [];
console.log("results count", results.length);
for (const x of results.slice(0, 20)) {
  console.log(
    (x.email || "").padEnd(32),
    String(x.confidence ?? "").padStart(3),
    x.status,
    x.patternId || x.patternLabel,
  );
}
// alternatives field?
for (const k of ["alternatives", "other", "candidates", "scored"]) {
  if (r[k]) console.log(k, Array.isArray(r[k]) ? r[k].length : typeof r[k]);
}
