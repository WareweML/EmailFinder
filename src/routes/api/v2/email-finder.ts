import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v2/email-finder")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const url = new URL(request.url);
        const fullName =
          url.searchParams.get("full_name")?.trim() ||
          url.searchParams.get("fullName")?.trim();
        const domain = url.searchParams.get("domain")?.trim();
        const linkedinUrl =
          url.searchParams.get("linkedin_url")?.trim() ||
          url.searchParams.get("linkedinUrl")?.trim() ||
          undefined;
        const skipSmtp = url.searchParams.get("skip_smtp") === "true";
        if (!fullName || !domain) {
          return Response.json(
            {
              errors: [
                {
                  id: "missing_params",
                  detail: "full_name and domain are required",
                },
              ],
            },
            { status: 400 },
          );
        }
        const { findEmail } = await import("@/lib/email-finder/pipeline");
        const result = await findEmail({ fullName, domain, linkedinUrl, skipSmtp });
        return Response.json(result);
      },
    },
  },
});
