import { createFileRoute } from "@tanstack/react-router";
import { API_ENDPOINTS } from "@/lib/email-finder/api-catalog";

export const Route = createFileRoute("/api/v2/")({
  server: {
    handlers: {
      GET: async () =>
        Response.json({
          version: "v2",
          name: "Mailgraph API",
          endpoints: API_ENDPOINTS.map((e) => ({
            id: e.id,
            group: e.group,
            method: e.method,
            path: e.path,
            title: e.title,
            summary: e.summary,
            params: e.params,
            response: e.response,
          })),
        }),
    },
  },
});
