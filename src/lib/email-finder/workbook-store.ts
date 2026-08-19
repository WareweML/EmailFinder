/**
 * Persistent Clay-style workbooks on disk.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DIR = path.join(process.cwd(), "data", "workbooks");

export type CellStatus =
  | "idle"
  | "queued"
  | "running"
  | "done"
  | "error"
  | "skipped";

export type EnrichAction =
  | "company_enrich"
  | "find_people"
  | "email_waterfall"
  | "verify_email"
  | "phone"
  | "tech_stack"
  | "linkedin_company"
  | "ai_column";

/** JSON-serializable cell meta */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface CellState {
  value: string | number | null;
  status: CellStatus;
  sources?: string[];
  confidence?: number;
  error?: string;
  meta?: { [key: string]: JsonValue };
  updatedAt?: string;
}

export interface WorkbookRow {
  id: string;
  kind: "company" | "person";
  domain: string;
  fullName?: string;
  title?: string;
  linkedinUrl?: string;
  cells: { [key: string]: CellState };
  createdAt: string;
  updatedAt: string;
}

export interface SequenceStep {
  id: string;
  action: EnrichAction;
  columnId: string;
  prompt?: string;
  stopOnSuccess?: boolean;
}

export interface Sequence {
  id: string;
  name: string;
  steps: SequenceStep[];
}

export interface SavedView {
  id: string;
  name: string;
  sheet: "companies" | "people";
  titleFilter?: string;
  statusFilter?: string;
  domainFilter?: string;
  sortField?: string;
  sortDir?: "asc" | "desc";
  visibleColumns: string[];
}

export interface Workbook {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  companyRows: WorkbookRow[];
  peopleRows: WorkbookRow[];
  sequences: Sequence[];
  views: SavedView[];
  activeViewId?: string;
  activeSequenceId?: string;
}

export interface WorkbookMeta {
  id: string;
  name: string;
  updatedAt: string;
  companyCount: number;
  peopleCount: number;
}

function emptyCell(value: string | number | null = null): CellState {
  return { value, status: "idle" };
}

export function newCompanyRow(domain: string): WorkbookRow {
  const now = new Date().toISOString();
  const d = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]!;
  return {
    id: randomUUID(),
    kind: "company",
    domain: d,
    cells: {
      domain: emptyCell(d),
      company: emptyCell(null),
      legal: emptyCell(null),
      industry: emptyCell(null),
      mx: emptyCell(null),
      pattern: emptyCell(null),
      people: emptyCell(null),
      emails: emptyCell(null),
      linkedin: emptyCell(null),
      phone: emptyCell(null),
      tech: emptyCell(null),
      confidence: emptyCell(null),
      ai: emptyCell(null),
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function newPersonRow(input: {
  domain: string;
  fullName: string;
  title?: string;
  email?: string;
  linkedinUrl?: string;
  confidence?: number;
  status?: string;
}): WorkbookRow {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    kind: "person",
    domain: input.domain,
    fullName: input.fullName,
    title: input.title,
    linkedinUrl: input.linkedinUrl,
    cells: {
      name: emptyCell(input.fullName),
      title: emptyCell(input.title ?? null),
      domain: emptyCell(input.domain),
      email: emptyCell(input.email ?? null),
      status: emptyCell(input.status ?? null),
      confidence: emptyCell(input.confidence ?? null),
      linkedin: emptyCell(input.linkedinUrl ?? null),
      phone: emptyCell(null),
      ai: emptyCell(null),
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function defaultSequences(): Sequence[] {
  return [
    {
      id: "seq-full-company",
      name: "Full company enrich",
      steps: [
        { id: "s1", action: "company_enrich", columnId: "company" },
        { id: "s2", action: "phone", columnId: "phone" },
        { id: "s3", action: "tech_stack", columnId: "tech" },
        { id: "s4", action: "find_people", columnId: "people" },
      ],
    },
    {
      id: "seq-people-email",
      name: "People → email waterfall",
      steps: [
        { id: "s1", action: "find_people", columnId: "people" },
        { id: "s2", action: "email_waterfall", columnId: "email" },
      ],
    },
    {
      id: "seq-phone-tech",
      name: "Phone + tech only",
      steps: [
        { id: "s1", action: "phone", columnId: "phone" },
        { id: "s2", action: "tech_stack", columnId: "tech" },
      ],
    },
  ];
}

export function defaultViews(): SavedView[] {
  return [
    {
      id: "view-all-cos",
      name: "All companies",
      sheet: "companies",
      visibleColumns: [
        "domain",
        "company",
        "legal",
        "industry",
        "mx",
        "phone",
        "tech",
        "people",
        "emails",
        "pattern",
        "confidence",
        "ai",
      ],
    },
    {
      id: "view-all-people",
      name: "All people",
      sheet: "people",
      visibleColumns: [
        "name",
        "title",
        "domain",
        "email",
        "status",
        "confidence",
        "linkedin",
        "phone",
        "ai",
      ],
    },
    {
      id: "view-execs",
      name: "Executives",
      sheet: "people",
      titleFilter: "ceo|founder|cco|cto|vp|director|chief",
      visibleColumns: [
        "name",
        "title",
        "email",
        "status",
        "confidence",
        "linkedin",
      ],
    },
  ];
}

export function createWorkbook(name = "Untitled workbook"): Workbook {
  const now = new Date().toISOString();
  const views = defaultViews();
  const sequences = defaultSequences();
  return {
    id: randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
    companyRows: [newCompanyRow("warewe.com")],
    peopleRows: [],
    sequences,
    views,
    activeViewId: views[0]!.id,
    activeSequenceId: sequences[0]!.id,
  };
}

async function ensureDir() {
  await fs.mkdir(DIR, { recursive: true });
}

function filePath(id: string) {
  return path.join(DIR, `${id}.json`);
}

export async function listWorkbooks(): Promise<WorkbookMeta[]> {
  await ensureDir();
  const files = await fs.readdir(DIR).catch(() => [] as string[]);
  const metas: WorkbookMeta[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(DIR, f), "utf8");
      const wb = JSON.parse(raw) as Workbook;
      metas.push({
        id: wb.id,
        name: wb.name,
        updatedAt: wb.updatedAt,
        companyCount: wb.companyRows?.length ?? 0,
        peopleCount: wb.peopleRows?.length ?? 0,
      });
    } catch {
      // skip
    }
  }
  return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getWorkbook(id: string): Promise<Workbook | null> {
  try {
    const raw = await fs.readFile(filePath(id), "utf8");
    return JSON.parse(raw) as Workbook;
  } catch {
    return null;
  }
}

export async function saveWorkbook(wb: Workbook): Promise<Workbook> {
  await ensureDir();
  wb.updatedAt = new Date().toISOString();
  await fs.writeFile(filePath(wb.id), JSON.stringify(wb, null, 2), "utf8");
  return wb;
}

export async function deleteWorkbook(id: string): Promise<void> {
  await fs.unlink(filePath(id)).catch(() => undefined);
}

export async function getOrCreateDefault(): Promise<Workbook> {
  const list = await listWorkbooks();
  if (list[0]) {
    const wb = await getWorkbook(list[0].id);
    if (wb) return wb;
  }
  const wb = createWorkbook("Mailgraph default");
  await saveWorkbook(wb);
  return wb;
}
