/**
 * Multi-column waterfall actions — run any enrich action on a single cell/row.
 */

import { enrichCompany } from "./company-enrich";
import { extractPhones } from "./phone-extract";
import { detectTechStack } from "./tech-stack";
import { deepResearchDomain } from "./research-agent";
import { findEmail } from "./pipeline";
import { verifyEmail } from "./verify";
import { runAiColumn } from "./ai-column";
import {
  type EnrichAction,
  type JsonValue,
  type Workbook,
  type WorkbookRow,
  newPersonRow,
  saveWorkbook,
} from "./workbook-store";

function setCell(
  row: WorkbookRow,
  columnId: string,
  patch: Partial<WorkbookRow["cells"][string]>,
) {
  const prev = row.cells[columnId] ?? {
    value: null,
    status: "idle" as const,
  };
  row.cells[columnId] = {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  row.updatedAt = new Date().toISOString();
}

export async function runActionOnRow(
  wb: Workbook,
  rowId: string,
  action: EnrichAction,
  opts: { prompt?: string; columnId?: string } = {},
): Promise<Workbook> {
  const company = wb.companyRows.find((r) => r.id === rowId);
  const person = wb.peopleRows.find((r) => r.id === rowId);
  const row = company ?? person;
  if (!row) return wb;

  const col = opts.columnId ?? defaultColumnForAction(action, row.kind);
  setCell(row, col, { status: "running", error: undefined });

  try {
    if (row.kind === "company") {
      await runCompanyAction(wb, row, action, opts.prompt, col);
    } else {
      await runPersonAction(row, action, opts.prompt, col);
    }
  } catch (e) {
    setCell(row, col, {
      status: "error",
      error: e instanceof Error ? e.message : "failed",
    });
  }

  return saveWorkbook(wb);
}

function defaultColumnForAction(
  action: EnrichAction,
  kind: "company" | "person",
): string {
  switch (action) {
    case "company_enrich":
      return "company";
    case "find_people":
      return "people";
    case "email_waterfall":
      return kind === "person" ? "email" : "emails";
    case "verify_email":
      return "status";
    case "phone":
      return "phone";
    case "tech_stack":
      return "tech";
    case "linkedin_company":
      return "linkedin";
    case "ai_column":
      return "ai";
    default:
      return "company";
  }
}

async function runCompanyAction(
  wb: Workbook,
  row: WorkbookRow,
  action: EnrichAction,
  prompt: string | undefined,
  col: string,
) {
  const domain = row.domain;

  if (action === "company_enrich") {
    const en = await enrichCompany(domain, { deepPeople: false });
    setCell(row, "company", {
      value: en.companyName,
      status: "done",
      sources: en.sources,
      confidence: en.confidence,
    });
    setCell(row, "legal", { value: en.legalName, status: "done" });
    setCell(row, "industry", { value: en.industry, status: "done" });
    setCell(row, "mx", { value: en.mxProvider, status: "done" });
    setCell(row, "pattern", { value: en.emailPattern, status: "done" });
    setCell(row, "linkedin", {
      value: en.linkedinCompanyUrl,
      status: "done",
      sources: en.linkedinCompanyUrl ? [en.linkedinCompanyUrl] : [],
    });
    setCell(row, "people", { value: en.peopleFound, status: "done" });
    setCell(row, "emails", { value: en.personalEmails, status: "done" });
    setCell(row, "confidence", { value: en.confidence, status: "done" });
    if (col !== "company") {
      setCell(row, col, { status: "done", value: row.cells[col]?.value ?? null });
    }
    return;
  }

  if (action === "phone") {
    const phones = await extractPhones(domain);
    const best = phones.phones[0];
    setCell(row, "phone", {
      value: best?.phone ?? null,
      status: "done",
      confidence: best?.confidence,
      sources: best ? [best.sourceUrl] : [],
      meta: {
        all: phones.phones.slice(0, 5).map((p) => ({
          phone: p.phone,
          confidence: p.confidence,
          source: p.sourceUrl,
        })) as JsonValue,
      },
    });
    return;
  }

  if (action === "tech_stack") {
    const tech = await detectTechStack(domain);
    const label = tech.technologies.map((t) => t.name).join(", ") || null;
    setCell(row, "tech", {
      value: label,
      status: "done",
      sources: tech.sources,
      meta: {
        technologies: tech.technologies.map((t) => ({
          name: t.name,
          category: t.category,
          evidence: t.evidence,
        })) as JsonValue,
      },
    });
    return;
  }

  if (action === "find_people" || action === "email_waterfall") {
    const research = await deepResearchDomain(domain);
    setCell(row, "people", {
      value: research.people.length,
      status: "done",
      sources: research.hops
        .filter((h) => h.status === "ok")
        .map((h) => h.label),
    });
    setCell(row, "emails", {
      value: research.contacts.filter((c) => !c.isRoleBased).length,
      status: "done",
    });
    if (research.companyName) {
      setCell(row, "company", { value: research.companyName, status: "done" });
    }
    if (research.legalName) {
      setCell(row, "legal", { value: research.legalName, status: "done" });
    }

    for (const p of research.people) {
      const contact = research.contacts.find(
        (c) =>
          c.firstName?.toLowerCase() === p.firstName.toLowerCase() &&
          c.lastName?.toLowerCase() === p.lastName.toLowerCase(),
      );
      const exists = wb.peopleRows.find(
        (r) =>
          r.domain === domain &&
          r.fullName?.toLowerCase() === p.fullName.toLowerCase(),
      );
      if (exists) {
        if (contact) {
          setCell(exists, "email", {
            value: contact.email,
            status: "done",
            confidence: contact.confidence,
            sources: contact.sources,
          });
          setCell(exists, "status", {
            value: contact.status,
            status: "done",
          });
          setCell(exists, "confidence", {
            value: contact.confidence,
            status: "done",
          });
        }
        continue;
      }
      const li = p.sources.find((s) => s.includes("linkedin.com"));
      wb.peopleRows.push(
        newPersonRow({
          domain,
          fullName: p.fullName,
          title: p.title,
          email: contact?.email ?? p.emails[0]?.email,
          linkedinUrl: li,
          confidence: contact?.confidence ?? p.emails[0]?.confidence,
          status: contact?.status ?? p.emails[0]?.status,
        }),
      );
    }
    for (const c of research.contacts.filter((x) => !x.isRoleBased)) {
      const name = [c.firstName, c.lastName].filter(Boolean).join(" ");
      if (!name && !c.email) continue;
      if (
        wb.peopleRows.some(
          (r) =>
            r.domain === domain &&
            (r.cells.email?.value === c.email ||
              r.fullName?.toLowerCase() === name.toLowerCase()),
        )
      ) {
        continue;
      }
      wb.peopleRows.push(
        newPersonRow({
          domain,
          fullName: name || String(c.email),
          title: c.title,
          email: c.email,
          confidence: c.confidence,
          status: c.status,
        }),
      );
    }
    return;
  }

  if (action === "linkedin_company") {
    const en = await enrichCompany(domain, { deepPeople: false });
    setCell(row, "linkedin", {
      value: en.linkedinCompanyUrl,
      status: "done",
      sources: en.linkedinCompanyUrl ? [en.linkedinCompanyUrl] : [],
    });
    return;
  }

  if (action === "ai_column") {
    const res = await runAiColumn({
      task:
        prompt ||
        "One-line outreach angle and best persona to contact. Evidence only.",
      context: {
        domain: row.domain,
        cells: Object.fromEntries(
          Object.entries(row.cells).map(([k, v]) => [k, v.value]),
        ),
      },
    });
    setCell(row, "ai", {
      value: res.ok ? res.text : (res.error ?? "AI unavailable"),
      status: res.ok ? "done" : "error",
      error: res.ok ? undefined : res.error,
    });
    return;
  }

  if (action === "verify_email") {
    setCell(row, col, { status: "skipped", value: "use on person rows" });
    return;
  }

  setCell(row, col, { status: "error", error: `Unknown action ${action}` });
}

async function runPersonAction(
  row: WorkbookRow,
  action: EnrichAction,
  prompt: string | undefined,
  col: string,
) {
  const domain = row.domain;
  const name = row.fullName ?? String(row.cells.name?.value ?? "");

  if (action === "email_waterfall") {
    if (!name.trim()) {
      setCell(row, "email", { status: "error", error: "No name" });
      return;
    }
    const found = await findEmail({
      fullName: name,
      domain,
      linkedinUrl: row.linkedinUrl,
      skipSmtp: false,
    });
    const best = found.best;
    setCell(row, "email", {
      value: best?.email ?? null,
      status: "done",
      confidence: best?.confidence,
      sources: best?.sources?.map((s) => String(s)),
    });
    setCell(row, "status", {
      value: best?.status ?? "unknown",
      status: "done",
    });
    setCell(row, "confidence", {
      value: best?.confidence ?? null,
      status: "done",
    });
    return;
  }

  if (action === "verify_email") {
    const email = String(row.cells.email?.value ?? "");
    if (!email.includes("@")) {
      setCell(row, "status", { status: "error", error: "No email" });
      return;
    }
    const v = await verifyEmail(email, { skipSmtp: false });
    setCell(row, "status", {
      value: v.status,
      status: "done",
      confidence: v.status === "valid" ? 95 : 40,
      meta: {
        mx: v.mxProvider ?? null,
        catchAll: v.isCatchAll ?? false,
      },
    });
    return;
  }

  if (action === "phone") {
    const phones = await extractPhones(domain);
    const best = phones.phones[0];
    setCell(row, "phone", {
      value: best?.phone ?? null,
      status: "done",
      confidence: best ? Math.max(30, best.confidence - 20) : undefined,
      sources: best ? [best.sourceUrl] : [],
    });
    return;
  }

  if (action === "ai_column") {
    const res = await runAiColumn({
      task:
        prompt ||
        "Write a 1-sentence personalized opener for this person. No invented facts.",
      context: {
        domain,
        name,
        title: row.title ?? null,
        email: row.cells.email?.value ?? null,
      },
    });
    setCell(row, "ai", {
      value: res.ok ? res.text : (res.error ?? "AI unavailable"),
      status: res.ok ? "done" : "error",
    });
    return;
  }

  setCell(row, col, {
    status: "skipped",
    value: null,
    error: `${action} not for person rows`,
  });
}

export async function runSequenceOnRow(
  wb: Workbook,
  rowId: string,
  sequenceId: string,
): Promise<Workbook> {
  const seq = wb.sequences.find((s) => s.id === sequenceId);
  if (!seq) return wb;
  let current = wb;
  for (const step of seq.steps) {
    current = await runActionOnRow(current, rowId, step.action, {
      prompt: step.prompt,
      columnId: step.columnId,
    });
    const row =
      current.companyRows.find((r) => r.id === rowId) ??
      current.peopleRows.find((r) => r.id === rowId);
    const cell = row?.cells[step.columnId];
    if (step.stopOnSuccess && cell?.status === "done" && cell.value) break;
  }
  return current;
}
