import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v2/companies/find")({
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
        const { findCompany } = await import("@/lib/email-finder/company-find");
        const result = await findCompany(domain);
        return Response.json(result);
      },
    },
  },
});
