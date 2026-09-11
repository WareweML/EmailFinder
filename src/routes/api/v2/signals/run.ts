import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v2/signals/run")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const body = (await request.json().catch(() => ({}))) as { id?: string };
        if (!body.id) return Response.json({ error: "id required" }, { status: 400 });
        const { runMonitor } = await import("@/lib/email-finder/signals");
        const result = await runMonitor(body.id);
        return Response.json(result);
      },
    },
  },
});
