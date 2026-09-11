import { useMemo, useState, useTransition } from "react";
import { Download, Loader2, MapPin, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UNIQUE_MAPS_TYPES } from "@/lib/email-finder/maps-types";
import { mapsSearchFn } from "@/lib/email-finder/server";
import type { MapsLead } from "@/lib/email-finder/maps-leads";
import { cn } from "@/lib/utils";

export function MapsPanel() {
  const [mode, setMode] = useState<"text" | "types">("types");
  const [query, setQuery] = useState("");
  const [primaryType, setPrimaryType] = useState("");
  const [location, setLocation] = useState("");
  const [include, setInclude] = useState<string[]>([]);
  const [exclude, setExclude] = useState<string[]>([]);
  const [typeQ, setTypeQ] = useState("");
  const [exQ, setExQ] = useState("");
  const [rank, setRank] = useState<"popularity" | "distance">("popularity");
  const [limit, setLimit] = useState(500);
  const [pending, start] = useTransition();
  const [leads, setLeads] = useState<MapsLead[]>([]);
  const [detail, setDetail] = useState("");
  const [ms, setMs] = useState<number | null>(null);

  const filteredIn = useMemo(() => {
    const q = typeQ.trim().toLowerCase();
    return UNIQUE_MAPS_TYPES.filter((t) => !q || t.label.toLowerCase().includes(q)).slice(
      0,
      80,
    );
  }, [typeQ]);
  const filteredEx = useMemo(() => {
    const q = exQ.trim().toLowerCase();
    return UNIQUE_MAPS_TYPES.filter((t) => !q || t.label.toLowerCase().includes(q)).slice(
      0,
      80,
    );
  }, [exQ]);

  function toggle(list: string[], id: string, set: (v: string[]) => void) {
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id].slice(0, 50));
  }

  function run() {
    if (!location.trim()) {
      toast.error("Enter a location");
      return;
    }
    if (mode === "types" && include.length === 0) {
      toast.error("Select at least one business type");
      return;
    }
    if (mode === "text" && !query.trim() && !primaryType) {
      toast.error("Describe what you're looking for or pick a type");
      return;
    }
    start(async () => {
      try {
        const r = await mapsSearchFn({
          data: {
            mode,
            query: query.trim() || undefined,
            location: location.trim(),
            includeTypes:
              mode === "types"
                ? include
                : primaryType
                  ? [primaryType]
                  : undefined,
            excludeTypes: exclude,
            rank,
            limit,
          },
        });
        setLeads(r.leads as MapsLead[]);
        setDetail(r.detail);
        setMs(r.ms);
        toast.success(`${r.leads.length} local businesses`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Maps search failed");
      }
    });
  }

  function exportCsv() {
    const header = [
      "Name",
      "Google Maps URL",
      "Website",
      "Phone",
      "Address",
      "Rating",
      "Reviews",
      "Category",
      "Lat",
      "Lng",
    ];
    const lines = [
      header.join(","),
      ...leads.map((l) =>
        [
          l.name,
          l.mapsUrl ?? "",
          l.website ?? "",
          l.phone ?? "",
          l.address,
          l.rating ?? "",
          l.reviews ?? "",
          l.category,
          l.lat ?? "",
          l.lng ?? "",
        ]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(","),
      ),
    ];
    const blob = new Blob(["\uFEFF" + lines.join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `mailgraph-maps-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="mx-auto mt-6 grid w-full max-w-6xl gap-4 lg:grid-cols-[360px_1fr]">
      <aside className="rounded-xl border border-border bg-surface p-4 space-y-4 max-h-[80vh] overflow-y-auto">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-accent">
            Google Maps
          </p>
          <h2 className="text-lg font-semibold mt-1">Find local businesses</h2>
          <p className="text-xs text-fg-muted mt-1">
            Search by name, category, or description.
          </p>
        </div>
        <div className="flex rounded-lg bg-bg p-1 text-sm">
          <button
            type="button"
            onClick={() => setMode("text")}
            className={cn(
              "flex-1 rounded-md py-1.5 font-medium",
              mode === "text" ? "bg-surface shadow-sm" : "text-fg-muted",
            )}
          >
            Free text
          </button>
          <button
            type="button"
            onClick={() => setMode("types")}
            className={cn(
              "flex-1 rounded-md py-1.5 font-medium",
              mode === "types" ? "bg-surface shadow-sm" : "text-fg-muted",
            )}
          >
            Business types
          </button>
        </div>

        {mode === "text" && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Describe what you're looking for</Label>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Italian restaurants with outdoor seating near downtown"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Primary business type</Label>
              <select
                value={primaryType}
                onChange={(e) => setPrimaryType(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="">Any</option>
                {UNIQUE_MAPS_TYPES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <Label>Location</Label>
          <Input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Austin, Texas · Sydney CBD · Gurugram"
          />
        </div>

        {mode === "types" && (
          <>
            <TypePicker
              title="Include"
              required
              query={typeQ}
              onQuery={setTypeQ}
              selected={include}
              options={filteredIn}
              onToggle={(id) => toggle(include, id, setInclude)}
              onAll={() => setInclude(filteredIn.map((t) => t.id).slice(0, 50))}
            />
            <TypePicker
              title="Exclude"
              query={exQ}
              onQuery={setExQ}
              selected={exclude}
              options={filteredEx}
              onToggle={(id) => toggle(exclude, id, setExclude)}
            />
          </>
        )}

        <div className="space-y-3 border-t border-border pt-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            Advanced
          </p>
          <div className="space-y-1.5">
            <Label>Rank results by</Label>
            <select
              value={rank}
              onChange={(e) => setRank(e.target.value as "popularity" | "distance")}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            >
              <option value="popularity">Popularity</option>
              <option value="distance">Distance</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Results per location</Label>
            <Input
              type="number"
              min={1}
              max={2000}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value) || 500)}
            />
            <p className="text-[11px] text-fg-subtle">
              Up to 2,000 · grids the map until unique places run out
            </p>
          </div>
        </div>

        <Button
          type="button"
          onClick={run}
          disabled={pending}
          className="w-full bg-accent text-accent-fg"
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
          Find businesses
        </Button>
      </aside>

      <section className="min-w-0">
        <div className="flex items-center justify-between gap-3 mb-3">
          <p className="text-sm text-fg-muted">
            {detail || "Local businesses · name, address, phone, website"}
            {ms != null ? ` · ${ms}ms` : ""}
          </p>
          {leads.length > 0 && (
            <Button type="button" variant="secondary" onClick={exportCsv}>
              <Download className="size-3.5" />
              Export
            </Button>
          )}
        </div>
        {pending && !leads.length && (
          <div className="rounded-xl border border-border bg-surface px-5 py-10 text-center">
            <Loader2 className="size-6 animate-spin mx-auto text-accent" />
            <p className="mt-3 text-sm">Searching maps around that location…</p>
          </div>
        )}
        {leads.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-border bg-surface">
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wider text-fg-subtle border-b border-border">
                <tr>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Maps</th>
                  <th className="px-3 py-2 font-medium">Website</th>
                  <th className="px-3 py-2 font-medium">Phone</th>
                  <th className="px-3 py-2 font-medium">Address</th>
                  <th className="px-3 py-2 font-medium">Rating</th>
                  <th className="px-3 py-2 font-medium">Reviews</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((l) => (
                  <tr
                    key={l.mapsUrl || l.name}
                    className="border-t border-border align-top"
                  >
                    <td className="px-3 py-2 font-medium">{l.name}</td>
                    <td className="px-3 py-2">
                      {l.mapsUrl && (
                        <a
                          href={l.mapsUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent hover:underline"
                        >
                          Maps
                        </a>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {l.website && (
                        <a
                          href={l.website}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent hover:underline"
                        >
                          {l.domain}
                        </a>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
                      {l.phone}
                    </td>
                    <td className="px-3 py-2 text-xs text-fg-muted max-w-[220px]">
                      {l.address}
                    </td>
                    <td className="px-3 py-2">{l.rating ?? ""}</td>
                    <td className="px-3 py-2">
                      {l.reviews != null ? l.reviews.toLocaleString() : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function TypePicker({
  title,
  required,
  query,
  onQuery,
  selected,
  options,
  onToggle,
  onAll,
}: {
  title: string;
  required?: boolean;
  query: string;
  onQuery: (v: string) => void;
  selected: string[];
  options: typeof UNIQUE_MAPS_TYPES;
  onToggle: (id: string) => void;
  onAll?: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label>
          {title} {required && <span className="text-accent">*</span>}
        </Label>
        {onAll && (
          <button type="button" onClick={onAll} className="text-[11px] text-accent">
            Select all
          </button>
        )}
      </div>
      <Input
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Bank, restaurant…"
      />
      <p className="text-[11px] text-fg-subtle">
        {selected.length} selected · {UNIQUE_MAPS_TYPES.length} available
      </p>
      <div className="max-h-40 overflow-y-auto rounded-md border border-border divide-y divide-border">
        {options.map((t) => (
          <label
            key={t.id}
            className="flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-bg cursor-pointer"
          >
            <input
              type="checkbox"
              checked={selected.includes(t.id)}
              onChange={() => onToggle(t.id)}
            />
            {t.label}
          </label>
        ))}
      </div>
    </div>
  );
}
