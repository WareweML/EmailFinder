import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v2/maps/search")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const location = String(body.location ?? "").trim();
        const mode = body.mode === "types" ? "types" : "text";
        if (!location) {
          return Response.json(
            { errors: [{ id: "missing_location", detail: "location is required" }] },
            { status: 400 },
          );
        }
        const { searchMapsLeads } = await import("@/lib/email-finder/maps-leads");
        const result = await searchMapsLeads({
          mode,
          query: typeof body.query === "string" ? body.query : undefined,
          location,
          includeTypes: Array.isArray(body.includeTypes)
            ? (body.includeTypes as string[])
            : undefined,
          excludeTypes: Array.isArray(body.excludeTypes)
            ? (body.excludeTypes as string[])
            : undefined,
          rank: body.rank === "distance" ? "distance" : "popularity",
          limit: typeof body.limit === "number" ? body.limit : undefined,
        });
        return Response.json(result);
      },
    },
  },
});
