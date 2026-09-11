import { useEffect, useRef, useState } from "react";
import { Building2, Loader2 } from "lucide-react";
import { suggestCompanyFn } from "@/lib/email-finder/server";
import type { CompanySuggestion } from "@/lib/email-finder/company-suggest";
import { cn } from "@/lib/utils";

export function CompanySuggestInput({
  value,
  onChange,
  onPick,
  placeholder = "Company name or domain…",
  className,
  inputClassName,
}: {
  value: string;
  onChange: (v: string) => void;
  onPick: (s: CompanySuggestion) => void;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hits, setHits] = useState<CompanySuggestion[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    const q = value.trim();
    if (q.length < 2) {
      setHits([]);
      setOpen(false);
      return;
    }
    const id = ++seq.current;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = (await suggestCompanyFn({
          data: { query: q },
        })) as CompanySuggestion[];
        if (seq.current !== id) return;
        setHits(res);
        setOpen(res.length > 0);
      } catch {
        if (seq.current === id) setHits([]);
      } finally {
        if (seq.current === id) setLoading(false);
      }
    }, 320);
    return () => clearTimeout(t);
  }, [value]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div ref={boxRef} className={cn("relative", className)}>
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          if (hits[0] && open) {
            e.preventDefault();
            onPick(hits[0]);
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        autoComplete="off"
        className={inputClassName}
      />
      {loading && (
        <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 size-4 animate-spin text-fg-subtle" />
      )}
      {open && hits.length > 0 && (
        <ul className="absolute z-30 mt-1 w-full overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
          {hits.map((h) => (
            <li key={`${h.source}-${h.domain}`}>
              <button
                type="button"
                onClick={() => {
                  onPick(h);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-bg"
              >
                {h.logoUrl ? (
                  <img
                    src={h.logoUrl}
                    alt=""
                    className="size-7 rounded bg-bg object-contain"
                  />
                ) : (
                  <span className="flex size-7 items-center justify-center rounded bg-bg text-fg-muted">
                    <Building2 className="size-3.5" />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {h.name}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-fg-muted">
                    {h.domain}
                  </span>
                </span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-fg-subtle">
                  {h.confidence}% · {h.source}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
