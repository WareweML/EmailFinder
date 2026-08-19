import { gatherCompanyIntel } from "../src/lib/email-finder/company-intel.ts";
import { detectTechStack } from "../src/lib/email-finder/tech-stack.ts";
import fs from "fs";

const tech = await detectTechStack("warewe.com");
console.log("=== TECH (fixed) ===");
console.log(tech.technologies);

const intel = await gatherCompanyIntel("warewe.com");
console.log("\n=== PHONES ===");
console.log("company", intel.companyPhone, intel.companyEmail);
console.log("employee phones", intel.employeePhones);

console.log("\n=== PRODUCTS ===");
for (const p of intel.products) console.log("-", p.status, p.name, "→", p.url);

console.log("\n=== TEAM ===");
for (const t of intel.team) console.log("-", t.name, "|", t.title, "|", t.linkedinUrl || "");

console.log("\n=== SOCIAL ===");
for (const s of intel.social) console.log("-", s.network, s.url);

console.log("\n=== GITHUB ===");
console.log(intel.github);

console.log("\n=== CONNECTIONS ===");
for (const c of intel.connections) console.log("•", c);

console.log("\n=== TIMELINE ===");
for (const t of intel.timeline) console.log("-", t);

fs.writeFileSync(
  "/workspace/data/warewe-intel.json",
  JSON.stringify(intel, null, 2),
);
console.log("\nms", intel.durationMs);
