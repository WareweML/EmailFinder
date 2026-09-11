import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v2/people/find")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const url = new URL(request.url);
        const email = url.searchParams.get("email")?.trim() || undefined;
        const linkedinUrl =
          url.searchParams.get("linkedin_url")?.trim() ||
          url.searchParams.get("linkedinUrl")?.trim() ||
          undefined;
        const fullName =
          url.searchParams.get("full_name")?.trim() ||
          url.searchParams.get("fullName")?.trim() ||
          undefined;
        const firstName =
          url.searchParams.get("first_name")?.trim() ||
          url.searchParams.get("firstName")?.trim() ||
          undefined;
        const lastName =
          url.searchParams.get("last_name")?.trim() ||
          url.searchParams.get("lastName")?.trim() ||
          undefined;
        const domain = url.searchParams.get("domain")?.trim() || undefined;
        const company = url.searchParams.get("company")?.trim() || undefined;
        const phone = url.searchParams.get("phone")?.trim() || undefined;
        if (!email && !linkedinUrl && !fullName && !(firstName && lastName)) {
          return Response.json(
            {
              errors: [
                {
                  id: "missing_identity",
                  detail: "email, linkedin_url, full_name, or first_name+last_name is required",
                },
              ],
            },
            { status: 400 },
          );
        }
        const { findPerson } = await import("@/lib/email-finder/person-find");
        const result = await findPerson({
          email,
          linkedinUrl,
          fullName,
          firstName,
          lastName,
          domain,
          company,
          phone,
        });
        return Response.json(result);
      },
    },
  },
});
