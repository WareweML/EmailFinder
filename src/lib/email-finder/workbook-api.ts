/**
 * Thin workbook CRUD server fns — keep this file free of SMTP / crawl / SERP
 * so the workspace first paint does not wait on the full finder stack.
 */
import { createServerFn } from "@tanstack/react-start";
import {
  createWorkbook,
  deleteWorkbook,
  getOrCreateDefault,
  getWorkbook,
  listWorkbooks,
  newCompanyRow,
  saveWorkbook,
  type SavedView,
  type Sequence,
  type Workbook,
} from "./workbook-store";

function parseDomainList(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/[\n,;\t]+/)) {
    const d = line
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]
      ?.split("?")[0]
      ?.replace(/['"]/g, "");
    if (!d || !d.includes(".")) continue;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d)) continue;
    if (seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out;
}

export const listWorkbooksFn = createServerFn({ method: "POST" })
  .validator((data: Record<string, never> = {}) => data)
  .handler(async () => listWorkbooks());

export const loadWorkbookFn = createServerFn({ method: "POST" })
  .validator((data: { id?: string }) => data)
  .handler(async ({ data }) => {
    if (data.id) {
      const wb = await getWorkbook(data.id);
      if (wb) return wb;
    }
    return getOrCreateDefault();
  });

export const createWorkbookFn = createServerFn({ method: "POST" })
  .validator((data: { name?: string }) => data)
  .handler(async ({ data }) => {
    const wb = createWorkbook(data.name ?? "Untitled workbook");
    return saveWorkbook(wb);
  });

export const saveWorkbookFn = createServerFn({ method: "POST" })
  .validator((data: { workbook: Workbook }) => data)
  .handler(async ({ data }) => saveWorkbook(data.workbook));

export const deleteWorkbookFn = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    await deleteWorkbook(data.id);
    return { ok: true };
  });

export const addDomainsToWorkbookFn = createServerFn({ method: "POST" })
  .validator((data: { workbookId: string; text: string }) => data)
  .handler(async ({ data }) => {
    const wb = await getWorkbook(data.workbookId);
    if (!wb) throw new Error("Workbook not found");
    const domains = parseDomainList(data.text);
    const have = new Set(wb.companyRows.map((r) => r.domain));
    let added = 0;
    for (const d of domains) {
      if (have.has(d)) continue;
      have.add(d);
      wb.companyRows.push(newCompanyRow(d));
      added += 1;
    }
    await saveWorkbook(wb);
    return { workbook: wb, added, total: wb.companyRows.length };
  });

export const saveViewFn = createServerFn({ method: "POST" })
  .validator(
    (data: { workbookId: string; view: SavedView; activate?: boolean }) => data,
  )
  .handler(async ({ data }) => {
    const wb = await getWorkbook(data.workbookId);
    if (!wb) throw new Error("Workbook not found");
    const idx = wb.views.findIndex((v) => v.id === data.view.id);
    if (idx >= 0) wb.views[idx] = data.view;
    else wb.views.push(data.view);
    if (data.activate) wb.activeViewId = data.view.id;
    return saveWorkbook(wb);
  });

export const saveSequenceFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      workbookId: string;
      sequence: Sequence;
      activate?: boolean;
    }) => data,
  )
  .handler(async ({ data }) => {
    const wb = await getWorkbook(data.workbookId);
    if (!wb) throw new Error("Workbook not found");
    const idx = wb.sequences.findIndex((s) => s.id === data.sequence.id);
    if (idx >= 0) wb.sequences[idx] = data.sequence;
    else wb.sequences.push(data.sequence);
    if (data.activate) wb.activeSequenceId = data.sequence.id;
    return saveWorkbook(wb);
  });

export const setActiveSequenceFn = createServerFn({ method: "POST" })
  .validator((data: { workbookId: string; sequenceId: string }) => data)
  .handler(async ({ data }) => {
    const wb = await getWorkbook(data.workbookId);
    if (!wb) throw new Error("Workbook not found");
    wb.activeSequenceId = data.sequenceId;
    return saveWorkbook(wb);
  });
