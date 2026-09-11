import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v2/icp/find")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const body = (await request.json().catch(() => ({}))) as {
          website?: string;
          brief?: string;
          customers?: Array<{ name?: string; domain: string; acv: number }>;
          competitors?: string[];
        };
        if (!body.website) return Response.json({ error: "website required" }, { status: 400 });
        const { findIcp } = await import("@/lib/email-finder/icp-find");
        const report = await findIcp({
          website: body.website,
          brief: body.brief,
          customers: body.customers,
          competitors: body.competitors,
        });
        return Response.json(report);
      },
    },
  },
});
