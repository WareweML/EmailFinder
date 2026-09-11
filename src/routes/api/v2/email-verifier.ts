import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v2/email-verifier")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const url = new URL(request.url);
        const email = url.searchParams.get("email")?.trim();
        if (!email) {
          return Response.json(
            { errors: [{ id: "missing_email", detail: "email is required" }] },
            { status: 400 },
          );
        }
        const { verifyEmail } = await import("@/lib/email-finder/verify");
        const result = await verifyEmail(email, {
          skipSmtp: url.searchParams.get("skip_smtp") === "true",
        });
        return Response.json(result);
      },
    },
  },
});
