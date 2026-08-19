/**
 * Bulk enrich queue — 100+ domains with concurrency + progress.
 * In-process queue (persisted job snapshot to disk for status polls).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  getWorkbook,
  saveWorkbook,
  type EnrichAction,
  type Workbook,
} from "./workbook-store";
import { runActionOnRow, runSequenceOnRow } from "./column-actions";

const JOB_DIR = path.join(process.cwd(), "data", "jobs");
const DEFAULT_CONCURRENCY = 3;
const MAX_ROWS = 200;

export type JobStatus = "queued" | "running" | "done" | "cancelled" | "error";

export interface EnrichJob {
  id: string;
  workbookId: string;
  rowIds: string[];
  /** either sequence or raw actions */
  sequenceId?: string;
  actions?: EnrichAction[];
  concurrency: number;
  status: JobStatus;
  total: number;
  done: number;
  failed: number;
  running: number;
  currentRowIds: string[];
  errors: Array<{ rowId: string; error: string }>;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

const jobs = new Map<string, EnrichJob>();
const runningControllers = new Map<string, { cancelled: boolean }>();

async function ensureJobDir() {
  await fs.mkdir(JOB_DIR, { recursive: true });
}

async function persistJob(job: EnrichJob) {
  await ensureJobDir();
  job.updatedAt = new Date().toISOString();
  await fs.writeFile(
    path.join(JOB_DIR, `${job.id}.json`),
    JSON.stringify(job, null, 2),
    "utf8",
  );
  jobs.set(job.id, job);
}

export async function getJob(id: string): Promise<EnrichJob | null> {
  if (jobs.has(id)) return jobs.get(id)!;
  try {
    const raw = await fs.readFile(path.join(JOB_DIR, `${id}.json`), "utf8");
    const job = JSON.parse(raw) as EnrichJob;
    jobs.set(id, job);
    return job;
  } catch {
    return null;
  }
}

export async function createEnrichJob(input: {
  workbookId: string;
  rowIds?: string[];
  /** if empty, all company rows */
  sheet?: "companies" | "people";
  sequenceId?: string;
  actions?: EnrichAction[];
  concurrency?: number;
}): Promise<EnrichJob> {
  const wb = await getWorkbook(input.workbookId);
  if (!wb) throw new Error("Workbook not found");

  let rowIds = input.rowIds;
  if (!rowIds?.length) {
    const sheet = input.sheet ?? "companies";
    rowIds =
      sheet === "people"
        ? wb.peopleRows.map((r) => r.id)
        : wb.companyRows.map((r) => r.id);
  }
  rowIds = rowIds.slice(0, MAX_ROWS);

  const job: EnrichJob = {
    id: randomUUID(),
    workbookId: input.workbookId,
    rowIds,
    sequenceId: input.sequenceId ?? wb.activeSequenceId,
    actions: input.actions,
    concurrency: Math.min(
      8,
      Math.max(1, input.concurrency ?? DEFAULT_CONCURRENCY),
    ),
    status: "queued",
    total: rowIds.length,
    done: 0,
    failed: 0,
    running: 0,
    currentRowIds: [],
    errors: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await persistJob(job);
  // fire and forget
  void processJob(job.id);
  return job;
}

async function processJob(jobId: string) {
  const ctrl = { cancelled: false };
  runningControllers.set(jobId, ctrl);

  let job = await getJob(jobId);
  if (!job) return;
  job.status = "running";
  await persistJob(job);

  let wb = await getWorkbook(job.workbookId);
  if (!wb) {
    job.status = "error";
    job.errors.push({ rowId: "", error: "Workbook missing" });
    await persistJob(job);
    return;
  }

  const queue = [...job.rowIds];
  const workers: Promise<void>[] = [];

  const work = async () => {
    while (queue.length && !ctrl.cancelled) {
      const rowId = queue.shift()!;
      job = (await getJob(jobId))!;
      job.running += 1;
      job.currentRowIds = [...job.currentRowIds, rowId];
      await persistJob(job);

      try {
        wb = (await getWorkbook(job.workbookId))!;
        if (job.sequenceId) {
          wb = await runSequenceOnRow(wb, rowId, job.sequenceId);
        } else if (job.actions?.length) {
          for (const action of job.actions) {
            wb = await runActionOnRow(wb, rowId, action);
          }
        } else {
          wb = await runSequenceOnRow(
            wb,
            rowId,
            wb.activeSequenceId ?? "seq-full-company",
          );
        }
        await saveWorkbook(wb);
        job = (await getJob(jobId))!;
        job.done += 1;
      } catch (e) {
        job = (await getJob(jobId))!;
        job.failed += 1;
        job.errors.push({
          rowId,
          error: e instanceof Error ? e.message : "failed",
        });
      } finally {
        job.running = Math.max(0, job.running - 1);
        job.currentRowIds = job.currentRowIds.filter((id) => id !== rowId);
        await persistJob(job);
      }
    }
  };

  for (let i = 0; i < job.concurrency; i++) {
    workers.push(work());
  }
  await Promise.all(workers);

  job = (await getJob(jobId))!;
  job.status = ctrl.cancelled ? "cancelled" : "done";
  job.finishedAt = new Date().toISOString();
  job.running = 0;
  job.currentRowIds = [];
  await persistJob(job);
  runningControllers.delete(jobId);
}

export async function cancelJob(jobId: string): Promise<EnrichJob | null> {
  const ctrl = runningControllers.get(jobId);
  if (ctrl) ctrl.cancelled = true;
  const job = await getJob(jobId);
  if (job && (job.status === "running" || job.status === "queued")) {
    job.status = "cancelled";
    await persistJob(job);
  }
  return job;
}

/** Parse bulk paste — up to 200 domains. */
export function parseDomainList(text: string): string[] {
  const lines = text.split(/[\n,;\t]+/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    let d = line
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
    if (out.length >= MAX_ROWS) break;
  }
  return out;
}
