import { companySignals } from "../src/lib/email-finder/company-signals.ts";

async function main() {
  for (const row of [
    { name: "GHD", companyId: "10243", liveHeadcount: 17372 },
    { name: "Stripe", liveHeadcount: 8000 },
    { name: "AECOM", liveHeadcount: 50000 },
  ]) {
    const s = await companySignals(row);
    console.log(row.name, JSON.stringify(s, null, 2));
  }
}
main();
