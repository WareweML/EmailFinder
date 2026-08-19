import { findEmail } from "../src/lib/email-finder/pipeline.ts";
const r = await findEmail({
  fullName: "Kumar Manaswi",
  domain: "warewe.com",
  skipSmtp: false,
});
console.log("best", r.best?.email, r.best?.confidence);
for (const x of r.alternatives || []) {
  console.log(
    (x.email || "").padEnd(32),
    String(x.confidence ?? "").padStart(3),
    x.status,
    x.patternId || x.patternLabel,
    (x.sources || []).join(","),
  );
}
// Did we verify kumar@?
const hasKumar = (r.alternatives || []).some((a) => a.email === "kumar@warewe.com");
console.log("kumar@ in alternatives?", hasKumar);
console.log("winningProvider", r.winningProvider);
