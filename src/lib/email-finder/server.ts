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
    try {
      return await findByLinkedIn(data);
    } catch (e) {
      return {
        query: {
          fullName: data.fullName ?? "",
          domain: data.domain ?? "",
          linkedinUrl: data.linkedinUrl,
        },
        name: { first: "", last: "", raw: data.fullName ?? "" },
        domainIntel: {
          domain: data.domain ?? "",
          normalizedDomain: data.domain ?? "",
          hasMx: false,
          mxHosts: [],
          mxProvider: null,
          isCatchAllLikely: false,
          isDisposable: false,
          patterns: [],
          knownEmails: [],
          sampleSize: 0,
          confidence: 0,
        },
        best: null,
        alternatives: [],
        pipeline: [
          {
            id: "linkedin",
            label: "LinkedIn find",
            status: "error" as const,
            detail: e instanceof Error ? e.message : "Find failed",
            ms: 0,
          },
        ],
        durationMs: 0,
        waterfall: [
          {
            id: "linkedin",
            provider: "LinkedIn",
            status: "error" as const,
            detail: e instanceof Error ? e.message : "Find failed",
            ms: 0,
            emailsFound: 0,
          },
        ],
        winningProvider: null,
        indexStats: { totalEmails: 0, domains: 0 },
      };
    }
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
    const { parseRoleFilter, titleMatchesRoles } = await import("./role-filter");
    const result = await fastLinkedInDomainSearch(data.domain, {
      titleFilter: data.titleFilter,
    });
    const roles = parseRoleFilter(data.titleFilter);
    if (roles.length) {
      const emails = result.emails.filter((e) => titleMatchesRoles(e.title, roles));
      const people = result.people.filter((p) => titleMatchesRoles(p.title, roles));
      return { ...result, emails, people, titleFilter: data.titleFilter };
    }
    return { ...result, titleFilter: data.titleFilter ?? null };
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

export const lookupPersonFn = createServerFn({ method: "POST" })
  .validator(
    (data: { domain: string; companyName?: string; query: string }) => data,
  )
  .handler(async ({ data }) => {
    const { lookupPersonAtCompany } = await import("./linkedin-company");
    return lookupPersonAtCompany(data);
  });

export const findCompanyFn = createServerFn({ method: "POST" })
  .validator((data: { domain: string }) => data)
  .handler(async ({ data }) => {
    const { findCompany } = await import("./company-find");
    return findCompany(data.domain);
  });

export const findPersonFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      email?: string;
      linkedinUrl?: string;
      fullName?: string;
      firstName?: string;
      lastName?: string;
      domain?: string;
      company?: string;
      phone?: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { findPerson } = await import("./person-find");
    return findPerson(data);
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
    return Promise.race([
      suggestCompanies(data.query),
      new Promise<Awaited<ReturnType<typeof suggestCompanies>>>((resolve) =>
        setTimeout(() => resolve([]), 6500),
      ),
    ]);
  });

export const resolveCompanyFn = createServerFn({ method: "POST" })
  .validator((data: { query: string }) => data)
  .handler(async ({ data }) => {
    const q = data.query.trim();
    if (!q) return { domain: "" };
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(q.replace(/^https?:\/\//, "").split("/")[0] ?? "")) {
      const d = q.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]!.toLowerCase();
      return { domain: d };
    }
    const { resolveCompanyDomain } = await import("./company-suggest");
    return { domain: (await resolveCompanyDomain(q)) ?? "" };
  });

export const mapsSearchFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      mode: "text" | "types";
      query?: string;
      location: string;
      includeTypes?: string[];
      excludeTypes?: string[];
      rank?: "popularity" | "distance";
      limit?: number;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { searchMapsLeads } = await import("./maps-leads");
    return searchMapsLeads(data);
  });

export const discoverCompaniesFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      keywords?: string;
      companyName?: string;
      companyId?: string;
      domain?: string;
      industryId?: string;
      sizeId?: string;
      hqGeoId?: string;
      companyType?: string;
      revenueBand?: string;
      growthBand?: string;
      hiringOnly?: boolean;
      start?: number;
      count?: number;
      pages?: number;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { discoverCompanies } = await import("./voyager-search");
    return discoverCompanies(data);
  });

export const discoverPeopleFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      keywords?: string;
      firstName?: string;
      lastName?: string;
      title?: string;
      pastTitle?: string;
      skills?: string;
      school?: string;
      language?: string;
      yearsExp?: string;
      tenure?: string;
      companyId?: string;
      companyName?: string;
      pastCompanyId?: string;
      pastCompanyName?: string;
      companyKeywords?: string;
      domain?: string;
      geoId?: string;
      hqGeoId?: string;
      industryId?: string;
      sizeId?: string;
      companyType?: string;
      revenueBand?: string;
      growthBand?: string;
      hiringOnly?: boolean;
      start?: number;
      count?: number;
      pages?: number;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { discoverPeople } = await import("./voyager-search");
    return discoverPeople(data);
  });

export const discoverCountFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      kind: "companies" | "people";
      keywords?: string;
      companyName?: string;
      companyId?: string;
      domain?: string;
      industryId?: string;
      sizeId?: string;
      hqGeoId?: string;
      companyType?: string;
      firstName?: string;
      lastName?: string;
      title?: string;
      pastTitle?: string;
      skills?: string;
      school?: string;
      language?: string;
      yearsExp?: string;
      tenure?: string;
      pastCompanyId?: string;
      pastCompanyName?: string;
      companyKeywords?: string;
      geoId?: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { discoverCount } = await import("./voyager-search");
    const { kind, ...filters } = data;
    return discoverCount(kind, filters);
  });

export const enrichPeopleFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      people: Array<{
        name: string;
        title?: string;
        location?: string;
        url: string;
        slug?: string;
        source?: string;
        company?: string;
        domain?: string;
        linkedinUrl?: string;
      }>;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { enrichPeople } = await import("./linkedin-public");
    const hits = await enrichPeople(
      data.people.map((p) => ({ ...p, slug: p.slug || p.name })),
    );
    return { hits };
  });

export const listSignalMonitorsFn = createServerFn({ method: "POST" })
  .validator((data: Record<string, never> = {}) => data)
  .handler(async () => {
    const { listMonitors } = await import("./signals");
    return { monitors: listMonitors() };
  });

export const listSignalEventsFn = createServerFn({ method: "POST" })
  .validator((data: { monitorId?: string }) => data)
  .handler(async ({ data }) => {
    const { listEvents } = await import("./signals");
    return { events: listEvents(data.monitorId) };
  });

export const saveSignalMonitorFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      id?: string;
      name: string;
      kind: import("./signals-catalog").SignalKind;
      target: import("./signals-catalog").SignalTarget;
      entities: string[];
      topics?: string[];
      query?: string;
      url?: string;
      location?: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { upsertMonitor } = await import("./signals");
    return { monitor: upsertMonitor(data) };
  });

export const deleteSignalMonitorFn = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const { deleteMonitor } = await import("./signals");
    deleteMonitor(data.id);
    return { ok: true };
  });

export const runSignalMonitorFn = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const { runMonitor } = await import("./signals");
    return runMonitor(data.id);
  });

export const findIcpFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      website: string;
      brief?: string;
      customers?: Array<{ email?: string; name?: string; domain?: string; acv?: number }>;
      competitors?: string[];
    }) => data,
  )
  .handler(async ({ data }) => {
    const { findIcp } = await import("./icp-find");
    return findIcp(data);
  });

export const loadLastIcpFn = createServerFn({ method: "GET" }).handler(async () => {
  const { loadLastIcp, restorePaidSparkToroReport } = await import("./icp-store");
  return loadLastIcp() ?? restorePaidSparkToroReport();
});

