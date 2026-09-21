import type { AffinityRow, IcpReport } from "./icp-find";

function csvEscape(s: string) {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function sectionCsv(title: string, rows: AffinityRow[]) {
  const lines = [`# ${title}`, "name,affinity,pct,url,evidence,source,kind"];
  for (const r of rows) {
    lines.push(
      [r.name, r.affinity, r.pct, r.url ?? "", r.evidence, r.source, r.kind].map((v) => csvEscape(String(v))).join(","),
    );
  }
  return lines.join("\n");
}

export function icpCsv(report: IcpReport): string {
  const parts = [
    "# buyers",
    "email,name,title,company,domain,industry,location,acv,sharePct,linkedin",
    ...report.buyers.map((b) =>
      [b.email, b.name, b.title, b.company, b.domain, b.industry, b.location, b.acv, b.sharePct, b.linkedin]
        .map((v) => csvEscape(String(v ?? "")))
        .join(","),
    ),
    "",
    sectionCsv("titles", report.demographics.titles),
    "",
    sectionCsv("audience_titles", report.demographics.audienceTitles),
    "",
    sectionCsv("functions", report.demographics.functions),
    "",
    sectionCsv("seniority", report.demographics.seniority),
    "",
    sectionCsv("industries", report.demographics.industries),
    "",
    sectionCsv("age", report.demographics.age),
    "",
    sectionCsv("gender", report.demographics.gender),
    "",
    sectionCsv("salary", report.demographics.salary),
    "",
    sectionCsv("social", report.social),
    "",
    sectionCsv("websites", report.websites),
    "",
    sectionCsv("press", report.press),
    "",
    sectionCsv("networks", report.networks),
    "",
    sectionCsv("youtube", report.youtube),
    "",
    sectionCsv("podcasts", report.podcasts),
    "",
    sectionCsv("reddit", report.reddit),
    "",
    sectionCsv("keywords", report.keywords),
    "",
    sectionCsv("apps", report.apps),
    "",
    sectionCsv("prompts", report.prompts),
    "",
    sectionCsv("bios", report.bioPhrases),
    "",
    sectionCsv("lookalikes", report.lookalikes),
  ];
  if (report.tam) {
    parts.push(
      "",
      "# tam",
      "estimated_population,yoy,market_value,currency,rationale",
      [
        report.tam.estimated_population,
        report.tam.year_over_year_growth_pct,
        report.tam.estimated_market_value,
        report.tam.currency,
        report.tam.rationale,
      ]
        .map((v) => csvEscape(String(v ?? "")))
        .join(","),
    );
  }
  return parts.join("\n");
}

function esc(s: string) {
  return s
    .replace(/&/g, "\u0026amp;")
    .replace(/</g, "\u0026lt;")
    .replace(/>/g, "\u0026gt;")
    .replace(/"/g, "\u0026quot;");
}

function table(rows: AffinityRow[], empty = "\u2014") {
  if (!rows.length) return `<p class="muted">${empty}</p>`;
  return `<table><thead><tr><th>Name</th><th>Affinity</th><th>%</th><th>Evidence</th></tr></thead><tbody>${rows
    .map((r) => {
      const label = r.url ? `<a href="${esc(r.url)}">${esc(r.name)}</a>` : esc(r.name);
      return `<tr><td>${label}</td><td>${r.affinity}</td><td>${r.pct}</td><td>${esc(r.evidence)}</td></tr>`;
    })
    .join("")}</tbody></table>`;
}

export function icpHtml(report: IcpReport): string {
  const tam = report.tam
    ? `<p class="hero">${(report.tam.estimated_population ?? 0).toLocaleString()} people</p>
       <p>${esc(report.tam.currency ?? "USD")} ${(report.tam.estimated_market_value ?? 0).toLocaleString()} · YoY ${report.tam.year_over_year_growth_pct ?? 0}%</p>
       <p>${esc(report.tam.rationale ?? "")}</p>`
    : "";
  const buyers = report.buyers
    .map((b) => {
      return `<tr><td>${esc(b.name || "\u2014")}<br><span class="muted">${esc(b.email || "")}</span></td><td>${esc(b.title || b.role || "\u2014")}</td><td>${esc(b.company || "")}</td><td>${esc(b.industry || "")}</td><td>${esc(b.location || "")}</td><td>${b.sharePct}%</td></tr>`;
    })
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>ICP report · ${esc(report.company.name)}</title>
<style>
  body{font:14px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#111;max-width:960px;margin:32px auto;padding:0 20px}
  h1{font-size:28px;margin:0 0 4px}
  h2{font-size:18px;margin:28px 0 10px;border-bottom:1px solid #ddd;padding-bottom:4px}
  .muted{color:#666;font-size:12px}
  .hero{font-size:32px;font-weight:700;margin:8px 0}
  table{width:100%;border-collapse:collapse;margin:8px 0 16px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top}
  th{font-size:11px;text-transform:uppercase;color:#666}
  a{color:#111}
  ul{padding-left:18px}
  @media print{a{text-decoration:none} body{margin:0}}
</style></head><body>
<h1>${esc(report.company.name)} \u2014 ICP report</h1>
<p class="muted">${esc(report.company.domain)} · ${report.spend.weightedCustomers} paying people · SparkToro ${esc(report.sparkToro?.reportId || "\u2014")} · ${new Date().toISOString().slice(0, 10)}</p>
<p>${esc(report.company.brief)}</p>
${tam}
<h2>Take action</h2>
<ul>${report.takeAction.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
<h2>Paying buyers</h2>
<table><thead><tr><th>Buyer</th><th>Title</th><th>Company</th><th>Industry</th><th>Location</th><th>ACV %</th></tr></thead><tbody>${buyers}</tbody></table>
<h2>Segments</h2>
${report.segments.map((s) => `<p><strong>${esc(s.name)}</strong> · ${s.shareOfRevenue}% ACV<br>${esc(s.who)}<br><span class="muted">Show up: ${esc(s.whereToShowUp.join(" · "))}</span></p>`).join("")}
<h2>Titles (people who paid)</h2>${table(report.demographics.titles)}
<h2>SparkToro audience titles</h2>${table(report.demographics.audienceTitles)}
<h2>Function / seniority / industry</h2>
${table(report.demographics.functions)}${table(report.demographics.seniority)}${table(report.demographics.industries)}
<h2>Age / gender / salary</h2>
${table(report.demographics.age)}${table(report.demographics.gender)}${table(report.demographics.salary)}
<h2>Social</h2>${table(report.social)}
<h2>Websites</h2>${table(report.websites)}
<h2>Press</h2>${table(report.press)}
<h2>Networks</h2>${table(report.networks)}
<h2>YouTube</h2>${table(report.youtube)}
<h2>Podcasts</h2>${table(report.podcasts)}
<h2>Reddit</h2>${table(report.reddit)}
<h2>Keywords</h2>${table(report.keywords)}
<h2>Apps</h2>${table(report.apps)}
<h2>Prompts</h2>${table(report.prompts)}
<h2>Bio phrases</h2>${table(report.bioPhrases)}
<h2>Lookalikes</h2>${table(report.lookalikes)}
</body></html>`;
}

export function downloadBlob(filename: string, mime: string, body: string) {
  const blob = new Blob([body], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
