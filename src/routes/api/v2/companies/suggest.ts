import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v2/companies/suggest")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const url = new URL(request.url);
        const query =
          url.searchParams.get("query")?.trim() ||
          url.searchParams.get("q")?.trim();
        if (!query) {
          return Response.json(
            { errors: [{ id: "missing_query", detail: "query is required" }] },
            { status: 400 },
          );
        }
        const { suggestCompanies } = await import("@/lib/email-finder/company-suggest");
        const data = await suggestCompanies(query);
        return Response.json({ data });
      },
    },
  },
});
