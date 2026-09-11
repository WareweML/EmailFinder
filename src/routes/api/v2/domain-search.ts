import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v2/domain-search")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const url = new URL(request.url);
        const domain = url.searchParams.get("domain")?.trim();
        if (!domain) {
          return Response.json(
            { errors: [{ id: "missing_domain", detail: "domain is required" }] },
            { status: 400 },
          );
        }
        const title = url.searchParams.get("title")?.trim();
        const { fastLinkedInDomainSearch } = await import(
          "@/lib/email-finder/linkedin-company"
        );
        const result = await fastLinkedInDomainSearch(domain);
        if (!title) return Response.json(result);
        const q = title.toLowerCase();
        return Response.json({
          ...result,
          emails: result.emails.filter((e) => {
            const t = (e.title ?? "").toLowerCase();
            const name = `${e.firstName ?? ""} ${e.lastName ?? ""}`.toLowerCase();
            return t.includes(q) || name.includes(q);
          }),
          people: result.people.filter(
            (p) =>
              (p.title ?? "").toLowerCase().includes(q) ||
              p.fullName.toLowerCase().includes(q),
          ),
          titleFilter: title,
        });
      },
    },
  },
});
