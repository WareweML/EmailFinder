import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Building2,
  Download,
  Filter,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Square,
  Table2,
  Users,
  Workflow,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  addDomainsToWorkbookFn,
  createWorkbookFn,
  listWorkbooksFn,
  loadWorkbookFn,
  saveViewFn,
  saveWorkbookFn,
  setActiveSequenceFn,
} from "@/lib/email-finder/workbook-api";
import type {
  CellState,
  EnrichAction,
  SavedView,
  Workbook,
  WorkbookRow,
} from "@/lib/email-finder/workbook-store";
import type { EnrichJob } from "@/lib/email-finder/enrich-queue";
import { cn } from "@/lib/utils";

async function loadJobs() {
  return import("@/lib/email-finder/server");
}

function isWorkbook(v: unknown): v is Workbook {
  return !!v && typeof v === "object" && Array.isArray((v as Workbook).companyRows);
}

type Sheet = "companies" | "people";

function unwrapWorkbook(v: unknown): Workbook | null {
  if (isWorkbook(v)) return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (isWorkbook(o.data)) return o.data;
    if (isWorkbook(o.result)) return o.result;
  }
  return null;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function localFallbackWorkbook(): Workbook {
  const now = "2026-01-01T00:00:00.000Z";
  const views: SavedView[] = [
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
  ];
  return {
    id: "local-default",
    name: "Mailgraph default",
    createdAt: now,
    updatedAt: now,
    companyRows: [
      {
        id: "local-warewe",
        kind: "company",
        domain: "warewe.com",
        cells: {
          domain: { value: "warewe.com", status: "idle" },
          company: { value: null, status: "idle" },
          legal: { value: null, status: "idle" },
          industry: { value: null, status: "idle" },
          mx: { value: null, status: "idle" },
          pattern: { value: null, status: "idle" },
          people: { value: null, status: "idle" },
          emails: { value: null, status: "idle" },
          linkedin: { value: null, status: "idle" },
          phone: { value: null, status: "idle" },
          tech: { value: null, status: "idle" },
          confidence: { value: null, status: "idle" },
          ai: { value: null, status: "idle" },
        },
        createdAt: now,
        updatedAt: now,
      },
    ],
    peopleRows: [],
    sequences: [],
    views,
    activeViewId: views[0]!.id,
  };
}

const COMPANY_COLS: Array<{
  id: string;
  label: string;
  action?: EnrichAction;
}> = [
  { id: "domain", label: "Domain" },
  { id: "company", label: "Company", action: "company_enrich" },
  { id: "legal", label: "Legal" },
  { id: "industry", label: "Industry" },
  { id: "mx", label: "MX" },
  { id: "phone", label: "Phone", action: "phone" },
  { id: "tech", label: "Tech", action: "tech_stack" },
  { id: "people", label: "People", action: "find_people" },
  { id: "emails", label: "Emails" },
  { id: "pattern", label: "Pattern" },
  { id: "linkedin", label: "LinkedIn", action: "linkedin_company" },
  { id: "confidence", label: "Conf" },
  { id: "ai", label: "AI", action: "ai_column" },
];

const PEOPLE_COLS: Array<{
  id: string;
  label: string;
  action?: EnrichAction;
}> = [
  { id: "name", label: "Name" },
  { id: "title", label: "Title" },
  { id: "domain", label: "Domain" },
  { id: "email", label: "Email", action: "email_waterfall" },
  { id: "status", label: "Status", action: "verify_email" },
  { id: "confidence", label: "Conf" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "phone", label: "Phone", action: "phone" },
  { id: "ai", label: "AI", action: "ai_column" },
];

function cellText(c?: CellState): string {
  if (!c || c.value == null || c.value === "") return "—";
  return String(c.value);
}

function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows
    .map((r) =>
      r
        .map((c) => {
          const s = c ?? "";
          if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
          return s;
        })
        .join(","),
    )
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function matchTitleFilter(title: string | undefined, filter: string): boolean {
  if (!filter.trim()) return true;
  const t = (title ?? "").toLowerCase();
  // support | OR
  return filter
    .toLowerCase()
    .split("|")
    .some((part) => t.includes(part.trim()) || (title ?? "").toLowerCase().includes(part.trim()));
}

export function ClayWorkspace() {
  const [wb, setWb] = useState<Workbook>(() => localFallbackWorkbook());
  const [metas, setMetas] = useState<
    Array<{ id: string; name: string; companyCount: number; peopleCount: number }>
  >([]);
  const [sheet, setSheet] = useState<Sheet>("companies");
  const [paste, setPaste] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<EnrichJob | null>(null);
  const [aiPrompt, setAiPrompt] = useState(
    "One-line outreach angle. Evidence only.",
  );
  const [viewName, setViewName] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const activeView = useMemo(() => {
    if (!wb) return null;
    return (
      wb.views.find((v) => v.id === wb.activeViewId) ??
      wb.views.find((v) => v.sheet === sheet) ??
      wb.views[0] ??
      null
    );
  }, [wb, sheet]);

  const titleFilter = activeView?.titleFilter ?? "";

  const load = useCallback(async (id?: string) => {
    setSyncing(true);
    try {
      const raw = await withTimeout(
        loadWorkbookFn({ data: { id } }),
        6000,
        "Load workbook",
      );
      const workbook = unwrapWorkbook(raw);
      if (!workbook) return;
      setWb(workbook);
      try {
        const list = await withTimeout(
          listWorkbooksFn({ data: {} }),
          3000,
          "List workbooks",
        );
        setMetas(Array.isArray(list) ? list : []);
      } catch {
        setMetas([
          {
            id: workbook.id,
            name: workbook.name,
            companyCount: workbook.companyRows.length,
            peopleCount: workbook.peopleRows.length,
          },
        ]);
      }
    } catch {
      // Keep the grid that is already on screen.
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [load]);

  const persistLocal = (next: Workbook) => {
    setWb(next);
  };

  const saveNow = async () => {
    if (!wb) return;
    setBusy(true);
    try {
      const saved = await saveWorkbookFn({ data: { workbook: wb } });
      setWb(saved);
      toast.success("Workbook saved");
      setMetas(await listWorkbooksFn({ data: {} }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const createNew = async () => {
    setBusy(true);
    try {
      const created = await createWorkbookFn({
        data: { name: `Workbook ${new Date().toLocaleDateString()}` },
      });
      setWb(created);
      setMetas(await listWorkbooksFn({ data: {} }));
      toast.success("New workbook");
    } finally {
      setBusy(false);
    }
  };

  const addDomains = async () => {
    if (!wb || !paste.trim()) {
      toast.error("Paste domains (supports 100+)");
      return;
    }
    setBusy(true);
    try {
      const res = await addDomainsToWorkbookFn({
        data: { workbookId: wb.id, text: paste },
      });
      setWb(res.workbook);
      setPaste("");
      toast.success(`Added ${res.added} · total ${res.total}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Add failed");
    } finally {
      setBusy(false);
    }
  };

  const runCell = async (
    rowId: string,
    action: EnrichAction,
    columnId: string,
  ) => {
    if (!wb) return;
    setBusy(true);
    try {
      const { runCellActionFn } = await import("@/lib/email-finder/server");
      const next = await runCellActionFn({
        data: {
          workbookId: wb.id,
          rowId,
          action,
          columnId,
          prompt: action === "ai_column" ? aiPrompt : undefined,
        },
      });
      setWb(next);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Cell action failed");
    } finally {
      setBusy(false);
    }
  };

  const pollJob = (jobId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const { jobStatusFn } = await import("@/lib/email-finder/server");
        const j = await jobStatusFn({ data: { jobId } });
        if (!j) return;
        setJob(j);
        // refresh workbook while job runs
        const refreshed = await loadWorkbookFn({ data: { id: wb?.id } });
        setWb(refreshed);
        if (j.status === "done" || j.status === "cancelled" || j.status === "error") {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          toast.success(
            j.status === "done"
              ? `Queue done · ${j.done} ok · ${j.failed} failed`
              : `Job ${j.status}`,
          );
          setBusy(false);
        }
      } catch {
        // ignore poll errors
      }
    }, 1500);
  };

  const startBulk = async () => {
    if (!wb) return;
    setBusy(true);
    try {
      const { startBulkJobFn } = await loadJobs();
      const j = await startBulkJobFn({
        data: {
          workbookId: wb.id,
          sheet: sheet === "people" ? "people" : "companies",
          sequenceId: wb.activeSequenceId,
          concurrency: 3,
        },
      });
      setJob(j);
      toast.message(`Queue started · ${j.total} rows · concurrency ${j.concurrency}`);
      pollJob(j.id);
    } catch (e) {
      setBusy(false);
      toast.error(e instanceof Error ? e.message : "Queue failed");
    }
  };

  const cancelBulk = async () => {
    if (!job) return;
    const { cancelJobFn } = await import("@/lib/email-finder/server");
    await cancelJobFn({ data: { jobId: job.id } });
    toast.message("Cancel requested");
  };

  const setSequence = async (sequenceId: string) => {
    if (!wb) return;
    const next = await setActiveSequenceFn({
      data: { workbookId: wb.id, sequenceId },
    });
    setWb(next);
  };

  const applyView = async (view: SavedView) => {
    if (!wb) return;
    const next = {
      ...wb,
      activeViewId: view.id,
    };
    setSheet(view.sheet);
    const saved = await saveWorkbookFn({ data: { workbook: next } });
    setWb(saved);
  };

  const saveCurrentView = async () => {
    if (!wb || !viewName.trim()) {
      toast.error("Name the view");
      return;
    }
    const view: SavedView = {
      id: `view-${Date.now()}`,
      name: viewName.trim(),
      sheet,
      titleFilter: titleFilter || undefined,
      visibleColumns:
        sheet === "companies"
          ? COMPANY_COLS.map((c) => c.id)
          : PEOPLE_COLS.map((c) => c.id),
    };
    const next = await saveViewFn({
      data: { workbookId: wb.id, view, activate: true },
    });
    setWb(next);
    setViewName("");
    toast.success("View saved");
  };

  const updateTitleFilter = async (value: string) => {
    if (!wb || !activeView) return;
    const view: SavedView = { ...activeView, titleFilter: value, sheet };
    // optimistic
    setWb({
      ...wb,
      views: wb.views.map((v) => (v.id === view.id ? view : v)),
    });
  };

  const commitTitleFilter = async () => {
    if (!wb || !activeView) return;
    const view = wb.views.find((v) => v.id === activeView.id);
    if (!view) return;
    const next = await saveViewFn({
      data: { workbookId: wb.id, view, activate: true },
    });
    setWb(next);
  };

  const companyRows = useMemo(() => {
    if (!wb) return [];
    let rows = wb.companyRows;
    if (activeView?.domainFilter) {
      const q = activeView.domainFilter.toLowerCase();
      rows = rows.filter((r) => r.domain.includes(q));
    }
    return rows;
  }, [wb, activeView]);

  const peopleRows = useMemo(() => {
    if (!wb) return [];
    let rows = wb.peopleRows;
    if (titleFilter) {
      rows = rows.filter(
        (r) =>
          matchTitleFilter(r.title ?? String(r.cells.title?.value ?? ""), titleFilter) ||
          matchTitleFilter(r.fullName, titleFilter),
      );
    }
    return rows;
  }, [wb, titleFilter]);

  const visibleCompanyCols = useMemo(() => {
    const ids = activeView?.sheet === "companies" ? activeView.visibleColumns : null;
    if (!ids?.length) return COMPANY_COLS;
    return COMPANY_COLS.filter((c) => ids.includes(c.id));
  }, [activeView]);

  const visiblePeopleCols = useMemo(() => {
    const ids = activeView?.sheet === "people" ? activeView.visibleColumns : null;
    if (!ids?.length) return PEOPLE_COLS;
    return PEOPLE_COLS.filter((c) => ids.includes(c.id));
  }, [activeView]);

  const exportCsv = () => {
    if (!wb) return;
    if (sheet === "companies") {
      downloadCsv(
        `${wb.name}-companies.csv`,
        [
          visibleCompanyCols.map((c) => c.label),
          ...companyRows.map((r) =>
            visibleCompanyCols.map((c) => cellText(r.cells[c.id])),
          ),
        ],
      );
    } else {
      downloadCsv(
        `${wb.name}-people.csv`,
        [
          visiblePeopleCols.map((c) => c.label),
          ...peopleRows.map((r) =>
            visiblePeopleCols.map((c) => cellText(r.cells[c.id])),
          ),
        ],
      );
    }
  };

  if (!wb) {
    return (
      <div className="flex items-center justify-center py-20 text-fg-muted">
        <Loader2 className="size-5 animate-spin mr-2" /> Starting workbook…
      </div>
    );
  }

  const jobPct =
    job && job.total > 0
      ? Math.round(((job.done + job.failed) / job.total) * 100)
      : 0;

  return (
    <div className="space-y-4">
      {/* Top bar */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Input
              value={wb.name}
              onChange={(e) => setWb({ ...wb, name: e.target.value })}
              onBlur={() => void saveNow()}
              className="h-9 max-w-xs font-display font-semibold text-base border-transparent hover:border-border focus:border-border"
            />
            <span className="text-[11px] text-fg-subtle" suppressHydrationWarning>
              {syncing ? "syncing…" : "ready"}
            </span>
          </div>
          <p className="text-xs text-fg-muted">
            Persistent workbook · cell actions · bulk queue · phone/tech · views
            · sequences
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            className="h-9 rounded-md border border-border bg-surface px-2 text-xs"
            value={wb.id}
            onChange={(e) => void load(e.target.value)}
          >
            {metas.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.companyCount}c/{m.peopleCount}p)
              </option>
            ))}
          </select>
          <Button type="button" variant="secondary" size="sm" onClick={createNew}>
            <Plus className="size-3.5" /> New
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => void saveNow()}>
            <Save className="size-3.5" /> Save
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={exportCsv}>
            <Download className="size-3.5" /> CSV
          </Button>
        </div>
      </div>

      {/* Sequence + view controls */}
      <div className="rounded-xl border border-border bg-surface p-3 shadow-sm space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Workflow className="size-4 text-fg-muted" />
          <span className="text-xs font-medium text-fg-muted">Sequence</span>
          <select
            className="h-8 rounded-md border border-border bg-bg px-2 text-xs"
            value={wb.activeSequenceId ?? ""}
            onChange={(e) => void setSequence(e.target.value)}
          >
            {wb.sequences.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.steps.length} steps)
              </option>
            ))}
          </select>
          <Button
            type="button"
            size="sm"
            className="bg-accent text-accent-fg hover:bg-accent/90"
            disabled={busy && job?.status === "running"}
            onClick={() => void startBulk()}
          >
            {job?.status === "running" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
            Run queue ({sheet === "companies" ? companyRows.length : peopleRows.length})
          </Button>
          {job?.status === "running" && (
            <Button type="button" size="sm" variant="secondary" onClick={() => void cancelBulk()}>
              <Square className="size-3.5" /> Cancel
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => void load(wb.id)}
          >
            <RefreshCw className="size-3.5" /> Refresh
          </Button>
        </div>

        {job && (
          <div className="space-y-1">
            <div className="flex justify-between text-[11px] text-fg-muted">
              <span>
                Job {job.status} · {job.done}/{job.total} done · {job.failed} failed ·{" "}
                {job.running} running
              </span>
              <span>{jobPct}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-bg overflow-hidden">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${jobPct}%` }}
              />
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Filter className="size-3.5 text-fg-muted" />
          <span className="text-xs font-medium text-fg-muted">View</span>
          {wb.views.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => void applyView(v)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[11px]",
                wb.activeViewId === v.id
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border text-fg-muted hover:bg-bg",
              )}
            >
              {v.name}
            </button>
          ))}
          <Input
            value={viewName}
            onChange={(e) => setViewName(e.target.value)}
            placeholder="Save view as…"
            className="h-8 w-32 text-xs"
          />
          <Button type="button" size="sm" variant="secondary" onClick={() => void saveCurrentView()}>
            Save view
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={titleFilter}
            onChange={(e) => void updateTitleFilter(e.target.value)}
            onBlur={() => void commitTitleFilter()}
            placeholder="Title filter (ceo|founder|engineer)"
            className="h-8 max-w-xs text-xs"
          />
          <Input
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            placeholder="AI column prompt"
            className="h-8 flex-1 min-w-[200px] text-xs"
          />
          <Sparkles className="size-3.5 text-fg-subtle" />
        </div>

        <div className="grid gap-2 lg:grid-cols-[1fr_auto]">
          <Textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder={"Paste up to 200 domains (one per line)\nwarewe.com\nstripe.com\n…"}
            className="min-h-[64px] font-mono text-xs"
          />
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void addDomains()}>
            <Plus className="size-3.5" /> Add domains
          </Button>
        </div>
      </div>

      {/* Sheet switch */}
      <div className="flex items-center justify-between">
        <div className="inline-flex rounded-lg border border-border bg-surface p-1">
          <button
            type="button"
            onClick={() => setSheet("companies")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm",
              sheet === "companies"
                ? "bg-bg border border-border shadow-sm"
                : "text-fg-muted",
            )}
          >
            <Building2 className="size-3.5" /> Companies ({companyRows.length})
          </button>
          <button
            type="button"
            onClick={() => setSheet("people")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm",
              sheet === "people"
                ? "bg-bg border border-border shadow-sm"
                : "text-fg-muted",
            )}
          >
            <Users className="size-3.5" /> People ({peopleRows.length})
          </button>
        </div>
        <p className="text-[11px] text-fg-subtle hidden sm:block">
          Click column header ⚡ to run action on all visible rows · cell ▶ for one
        </p>
      </div>

      {sheet === "companies" ? (
        <DataTable
          cols={visibleCompanyCols}
          rows={companyRows}
          onRunCell={(rowId, col) => {
            if (!col.action) return;
            void runCell(rowId, col.action, col.id);
          }}
          onRunColumn={(col) => {
            if (!col.action || !wb) return;
            // queue that single action on all company rows
            void (async () => {
              setBusy(true);
              try {
                const { startBulkJobFn } = await loadJobs();
                const j = await startBulkJobFn({
                  data: {
                    workbookId: wb.id,
                    sheet: "companies",
                    actions: [col.action!],
                    concurrency: 3,
                  },
                });
                setJob(j);
                pollJob(j.id);
              } catch (e) {
                setBusy(false);
                toast.error(e instanceof Error ? e.message : "Failed");
              }
            })();
          }}
        />
      ) : (
        <DataTable
          cols={visiblePeopleCols}
          rows={peopleRows}
          empty={
            <div className="p-10 text-center">
              <Table2 className="size-8 mx-auto text-fg-subtle mb-2" />
              <p className="text-sm text-fg-muted">
                Run sequence with <strong>Find people</strong> step, or queue bulk
              </p>
            </div>
          }
          onRunCell={(rowId, col) => {
            if (!col.action) return;
            void runCell(rowId, col.action, col.id);
          }}
          onRunColumn={(col) => {
            if (!col.action || !wb) return;
            void (async () => {
              setBusy(true);
              try {
                const { startBulkJobFn } = await loadJobs();
                const j = await startBulkJobFn({
                  data: {
                    workbookId: wb.id,
                    sheet: "people",
                    actions: [col.action!],
                    concurrency: 3,
                  },
                });
                setJob(j);
                pollJob(j.id);
              } catch (e) {
                setBusy(false);
                toast.error(e instanceof Error ? e.message : "Failed");
              }
            })();
          }}
        />
      )}
    </div>
  );
}

function DataTable({
  cols,
  rows,
  onRunCell,
  onRunColumn,
  empty,
}: {
  cols: Array<{ id: string; label: string; action?: EnrichAction }>;
  rows: WorkbookRow[];
  onRunCell: (
    rowId: string,
    col: { id: string; label: string; action?: EnrichAction },
  ) => void;
  onRunColumn: (col: {
    id: string;
    label: string;
    action?: EnrichAction;
  }) => void;
  empty?: React.ReactNode;
}) {
  if (!rows.length && empty) {
    return (
      <div className="rounded-xl border border-border bg-surface shadow-sm">
        {empty}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-surface shadow-sm overflow-x-auto">
      <table className="w-full text-sm min-w-[1000px]">
        <thead>
          <tr className="border-b border-border bg-bg text-left text-[11px] uppercase tracking-wider text-fg-subtle">
            {cols.map((c) => (
              <th key={c.id} className="px-2 py-2 font-medium whitespace-nowrap">
                <div className="flex items-center gap-1">
                  {c.label}
                  {c.action && (
                    <button
                      type="button"
                      title={`Run ${c.action} on all rows`}
                      onClick={() => onRunColumn(c)}
                      className="rounded p-0.5 text-accent hover:bg-accent/10"
                    >
                      <Zap className="size-3" />
                    </button>
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-bg/70">
              {cols.map((c) => {
                const cell = r.cells[c.id];
                return (
                  <td key={c.id} className="px-2 py-1.5 align-top max-w-[180px]">
                    <div className="group flex items-start gap-1">
                      <div className="min-w-0 flex-1">
                        <div
                          className={cn(
                            "text-xs truncate",
                            c.id === "domain" || c.id === "email" || c.id === "name"
                              ? "font-mono"
                              : "",
                            c.id === "name" && "font-medium font-sans",
                            cell?.status === "error" && "text-danger",
                            cell?.status === "running" && "text-accent",
                          )}
                          title={cellText(cell)}
                        >
                          {cell?.status === "running" ? (
                            <Loader2 className="size-3 animate-spin inline" />
                          ) : (
                            cellText(cell)
                          )}
                        </div>
                        {cell?.confidence != null && c.id !== "confidence" && (
                          <div className="text-[10px] text-fg-subtle">
                            {cell.confidence}%
                          </div>
                        )}
                      </div>
                      {c.action && (
                        <button
                          type="button"
                          title={`Run ${c.action}`}
                          onClick={() => onRunCell(r.id, c)}
                          className="opacity-0 group-hover:opacity-100 shrink-0 rounded p-0.5 text-fg-muted hover:text-accent hover:bg-accent/10"
                        >
                          <Play className="size-3" />
                        </button>
                      )}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
