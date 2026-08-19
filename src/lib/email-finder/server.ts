/**
 * Server functions only. Heavy node modules (dns, fs, net) MUST be
 * dynamically imported inside handlers so the browser bundle never
 * sees them — otherwise Vite externalizes node:dns and the app dies
 * on hydrate, which looks like a “redirect” back to workbook.
 */
import { createServerFn } from "@tanstack/react-start";

export const findEmailFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      fullName: string;
      domain: string;
      linkedinUrl?: string;
      skipSmtp?: boolean;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { findEmail } = await import("./pipeline");
    return findEmail(data);
  });

export const findLinkedInFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      linkedinUrl: string;
      domain?: string;
      fullName?: string;
      skipSmtp?: boolean;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { findByLinkedIn } = await import("./pipeline");
    return findByLinkedIn(data);
  });

export const domainSearchFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      domain: string;
      verifyRoles?: boolean;
      titleFilter?: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { fastLinkedInDomainSearch } = await import("./linkedin-company");
    const result = await fastLinkedInDomainSearch(data.domain);
    if (data.titleFilter?.trim()) {
      const q = data.titleFilter.trim().toLowerCase();
      const emails = result.emails.filter((e) => {
        const title = (e.title ?? "").toLowerCase();
        const name = `${e.firstName ?? ""} ${e.lastName ?? ""}`.toLowerCase();
        return title.includes(q) || name.includes(q);
      });
      const people = result.people.filter(
        (p) =>
          (p.title ?? "").toLowerCase().includes(q) ||
          p.fullName.toLowerCase().includes(q),
      );
      return { ...result, emails, people, titleFilter: data.titleFilter };
    }
    return result;
  });

export const verifyEmailFn = createServerFn({ method: "POST" })
  .validator((data: { email: string; skipSmtp?: boolean }) => data)
  .handler(async ({ data }) => {
    const { verifyEmail } = await import("./verify");
    return verifyEmail(data.email, { skipSmtp: data.skipSmtp });
  });

export const bulkFindFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      rows: Array<{ fullName: string; domain: string }>;
      skipSmtp?: boolean;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { bulkFind } = await import("./pipeline");
    return bulkFind(data.rows, { skipSmtp: data.skipSmtp });
  });

export const listDomainsFn = createServerFn({ method: "GET" }).handler(
  async () => {
    const { listSeededDomains } = await import("./knowledge-base");
    return listSeededDomains();
  },
);

export const enrichCompanyFn = createServerFn({ method: "POST" })
  .validator((data: { domain: string; deepPeople?: boolean }) => data)
  .handler(async ({ data }) => {
    const { enrichCompany } = await import("./company-enrich");
    return enrichCompany(data.domain, { deepPeople: data.deepPeople ?? true });
  });

export const bulkEnrichCompaniesFn = createServerFn({ method: "POST" })
  .validator((data: { domains: string[]; deepPeople?: boolean }) => data)
  .handler(async ({ data }) => {
    const { enrichCompany } = await import("./company-enrich");
    const domains = data.domains.map((d) => d.trim().toLowerCase()).filter(Boolean);
    const results = [];
    for (const domain of domains.slice(0, 25)) {
      results.push(
        await enrichCompany(domain, { deepPeople: data.deepPeople ?? false }),
      );
    }
    return { results };
  });

export const findPeopleAtCompanyFn = createServerFn({ method: "POST" })
  .validator((data: { domain: string; titleFilter?: string }) => data)
  .handler(async ({ data }) => {
    const { deepResearchDomain } = await import("./research-agent");
    const research = await deepResearchDomain(data.domain);
    let people = research.people;
    let contacts = research.contacts;
    if (data.titleFilter?.trim()) {
      const q = data.titleFilter.trim().toLowerCase();
      people = people.filter(
        (p) =>
          (p.title ?? "").toLowerCase().includes(q) ||
          p.fullName.toLowerCase().includes(q),
      );
      contacts = contacts.filter(
        (c) =>
          (c.title ?? "").toLowerCase().includes(q) ||
          `${c.firstName ?? ""} ${c.lastName ?? ""}`.toLowerCase().includes(q),
      );
    }
    return {
      domain: research.domain,
      companyName: research.companyName,
      legalName: research.legalName,
      hops: research.hops,
      people,
      contacts,
      durationMs: research.durationMs,
      titleFilter: data.titleFilter ?? null,
    };
  });

export const aiColumnFn = createServerFn({ method: "POST" })
  .validator(
    (data: { task: string; context: Record<string, unknown> }) => data,
  )
  .handler(async ({ data }) => {
    const { runAiColumn } = await import("./ai-column");
    return runAiColumn(data);
  });

export const indexBrowseFn = createServerFn({ method: "POST" })
  .validator((data: { domain?: string }) => data)
  .handler(async ({ data }) => {
    const { indexStats, getEmailsForDomain } = await import("./index-store");
    const stats = await indexStats();
    if (data.domain) {
      const emails = await getEmailsForDomain(data.domain);
      return { stats, emails, domains: [data.domain] };
    }
    return { stats, emails: [], domains: [] };
  });

export const extractPhonesFn = createServerFn({ method: "POST" })
  .validator((data: { domain: string }) => data)
  .handler(async ({ data }) => {
    const { extractPhones } = await import("./phone-extract");
    return extractPhones(data.domain);
  });

export const techStackFn = createServerFn({ method: "POST" })
  .validator((data: { domain: string }) => data)
  .handler(async ({ data }) => {
    const { detectTechStack } = await import("./tech-stack");
    return detectTechStack(data.domain);
  });

export const runCellActionFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      workbookId: string;
      rowId: string;
      action: string;
      columnId?: string;
      prompt?: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { getWorkbook } = await import("./workbook-store");
    const { runActionOnRow } = await import("./column-actions");
    const wb = await getWorkbook(data.workbookId);
    if (!wb) throw new Error("Workbook not found");
    return runActionOnRow(wb, data.rowId, data.action as never, {
      columnId: data.columnId,
      prompt: data.prompt,
    });
  });

export const runSequenceFn = createServerFn({ method: "POST" })
  .validator(
    (data: { workbookId: string; rowId: string; sequenceId: string }) => data,
  )
  .handler(async ({ data }) => {
    const { getWorkbook } = await import("./workbook-store");
    const { runSequenceOnRow } = await import("./column-actions");
    const wb = await getWorkbook(data.workbookId);
    if (!wb) throw new Error("Workbook not found");
    return runSequenceOnRow(wb, data.rowId, data.sequenceId);
  });

export const startBulkJobFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      workbookId: string;
      sheet?: "companies" | "people";
      sequenceId?: string;
      concurrency?: number;
      actions?: string[];
      rowIds?: string[];
    }) => data,
  )
  .handler(async ({ data }) => {
    const { createEnrichJob } = await import("./enrich-queue");
    return createEnrichJob(data as never);
  });

export const jobStatusFn = createServerFn({ method: "POST" })
  .validator((data: { jobId: string }) => data)
  .handler(async ({ data }) => {
    const { getJob } = await import("./enrich-queue");
    return getJob(data.jobId);
  });

export const cancelJobFn = createServerFn({ method: "POST" })
  .validator((data: { jobId: string }) => data)
  .handler(async ({ data }) => {
    const { cancelJob } = await import("./enrich-queue");
    return cancelJob(data.jobId);
  });

export const companyIntelFn = createServerFn({ method: "POST" })
  .validator((data: { domain: string }) => data)
  .handler(async ({ data }) => {
    const { gatherCompanyIntel } = await import("./company-intel");
    return gatherCompanyIntel(data.domain);
  });

export const suggestCompanyFn = createServerFn({ method: "POST" })
  .validator((data: { query: string }) => data)
  .handler(async ({ data }) => {
    const { suggestCompanies } = await import("./company-suggest");
    return suggestCompanies(data.query);
  });
