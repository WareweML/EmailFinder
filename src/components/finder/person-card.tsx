import { ExternalLink } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { PersonFindData } from "@/lib/email-finder/person-find";

function row(label: string, value: unknown) {
  if (value == null || value === "" || (Array.isArray(value) && !value.length)) return null;
  return (
    <p className="text-sm">
      <span className="text-fg-muted">{label}: </span>
      {Array.isArray(value) ? value.join(", ") : String(value)}
    </p>
  );
}

export function PersonCard({
  data,
  sources,
  ms,
  error,
}: {
  data: PersonFindData;
  sources?: string[];
  ms?: number;
  error?: string;
}) {
  const li = data.profiles.find((p) => p.network === "linkedin")?.url ?? data.linkedin_url;
  return (
    <Card className="shadow-sm overflow-hidden">
      <div className="h-1 bg-accent" />
      <CardContent className="p-5 space-y-3">
        <div>
          <h3 className="font-display text-xl font-semibold">{data.full_name || "—"}</h3>
          <p className="text-sm text-fg-muted">
            {[data.job_title, data.job_company_name].filter(Boolean).join(" · ")}
          </p>
        </div>
        {error ? (
          <p className="text-sm border border-border rounded-md p-3 leading-relaxed bg-surface-hover">
            {error}
          </p>
        ) : null}
        {li ? (
          <p className="text-sm">
            <span className="text-fg-muted">LinkedIn: </span>
            <a href={li} target="_blank" rel="noreferrer" className="text-accent break-all">
              {li}
            </a>
          </p>
        ) : null}
        {row("Email", data.work_email)}
        {row("Phone", data.mobile_phone)}
        {data.pwned != null
          ? row(
              "HIBP",
              data.pwned
                ? `${data.pwn_count} breach${data.pwn_count === 1 ? "" : "es"}${data.pwn_breaches[0] ? ` · ${data.pwn_breaches.slice(0, 4).join(", ")}` : ""}`
                : "not in HIBP",
            )
          : null}
        {row("Location", data.location_name ?? [data.location_locality, data.location_region, data.location_country].filter(Boolean).join(", "))}
        {row("Role", data.job_title_role)}
        {row("Levels", data.job_title_levels)}
        {row("Salary", data.inferred_salary)}
        {data.experience.length ? (
          <div>
            <p className="text-xs uppercase tracking-wide text-fg-muted mb-1">Experience</p>
            <ul className="space-y-1">
              {data.experience.map((e, i) => (
                <li key={`${e.company.name}-${e.start_date}-${i}`} className="text-sm">
                  <span className="font-medium">{e.title.name ?? "—"}</span>
                  {e.company.name ? <span className="text-fg-muted"> · {e.company.name}</span> : null}
                  {e.start_date || e.end_date || e.is_primary ? (
                    <span className="text-fg-muted">
                      {" "}
                      ({e.start_date ?? "?"}–{e.is_primary ? "now" : e.end_date ?? "?"})
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {row("Education", data.education.map((e) => e.school.name).filter(Boolean))}
        {row("Skills", data.skills.slice(0, 12))}
        {ms != null ? row("Duration", `${ms} ms`) : null}
        {data.profiles.length ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {data.profiles.map((p) => (
              <a
                key={p.network}
                href={p.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs rounded-full border border-border px-2 py-0.5 hover:bg-surface-hover"
              >
                {p.network}
                <ExternalLink className="size-3" />
              </a>
            ))}
          </div>
        ) : li ? (
          <a href={li} target="_blank" rel="noreferrer" className="text-xs text-accent inline-flex items-center gap-1">
            LinkedIn <ExternalLink className="size-3" />
          </a>
        ) : null}
        {sources?.length ? row("Sources", sources) : null}
      </CardContent>
    </Card>
  );
}
