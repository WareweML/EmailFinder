import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v2/discover/companies")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const { discoverCompanies } = await import("@/lib/email-finder/voyager-search");
        const result = await discoverCompanies(body as never);
        return Response.json(result);
      },
    },
  },
});
