import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v2/signals/monitors")({
  server: {
    handlers: {
      GET: async () => {
        const { listMonitors, SIGNAL_CATALOG } = await import("@/lib/email-finder/signals");
        return Response.json({ catalog: SIGNAL_CATALOG, monitors: listMonitors() });
      },
      POST: async ({ request }: { request: Request }) => {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const { upsertMonitor } = await import("@/lib/email-finder/signals");
        const monitor = upsertMonitor(body as never);
        return Response.json({ monitor });
      },
    },
  },
});
