import type { Plugin } from "vite";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";
// @ts-expect-error JS plugin alongside the TS vite config
import { grokPwaPlugin } from "./scripts/grok-pwa-plugin.mjs";

/**
 * Finish PGLite bootstrap during dev-server setup (before traffic). Vite awaits
 * async `configureServer` hooks. Production: `src/lib/db` kicks `ensureDbReady`
 * on import.
 */
function pgliteBootstrapPlugin(): Plugin {
  return {
    name: "app-builder:pglite-bootstrap",
    apply: "serve",
    async configureServer(server) {
      try {
        const mod = (await server.ssrLoadModule("/src/lib/db.ts")) as {
          ensureDbReady?: () => Promise<void>;
        };
        if (typeof mod.ensureDbReady === "function") {
          await mod.ensureDbReady();
        }
      } catch (err) {
        console.error("[app-builder] DB bootstrap failed:", err);
        throw err;
      }
    },
  };
}

/**
 * Live-preview OAuth popup — handled HERE so the agent never has to create a
 * `/auth/popup` route (and cannot break it by scaffolding a React page that
 * paints the full app shell in the popup).
 *
 * `signIn` (client.ts) opens `/auth/popup?providerId=…` in a top-level window.
 * This middleware runs before TanStack Start, calls `handleAuthPopupRequest`,
 * and returns the 302 / completion HTML. Deployed apps do not use the popup
 * (full-page OAuth redirect), so `apply: "serve"` is enough.
 */
function authPopupPlugin(): Plugin {
  return {
    name: "app-builder:auth-popup",
    apply: "serve",
    configureServer(server) {
      // Register immediately (not in a returned post-hook) so we run BEFORE
      // TanStack Start / the SPA HTML fallback. A model-authored
      // `src/routes/auth/popup.tsx` React page must never win this path.
      server.middlewares.use(async (req, res, next) => {
        try {
          const rawUrl = req.url ?? "";
          const pathOnly = rawUrl.split("?", 1)[0] ?? "";
          if (pathOnly !== "/auth/popup") {
            next();
            return;
          }
          if ((req.method ?? "GET").toUpperCase() !== "GET") {
            res.statusCode = 405;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.end("Method Not Allowed");
            return;
          }

          const host = String(
            req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost:8080",
          );
          const proto = String(
            req.headers["x-forwarded-proto"] ??
              ((req.socket as { encrypted?: boolean } | undefined)?.encrypted ? "https" : "http"),
          );
          const requestHeaders = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
              for (const v of value) requestHeaders.append(key, v);
            } else {
              requestHeaders.set(key, value);
            }
          }
          // Ensure Host is the public preview host so Better Auth's dynamic
          // baseURL / redirect_uri match the popup origin.
          if (!requestHeaders.has("host")) requestHeaders.set("host", host);

          const request = new Request(`${proto}://${host}${rawUrl}`, {
            method: "GET",
            headers: requestHeaders,
          });

          const mod = (await server.ssrLoadModule("/src/lib/auth/popup.server.ts")) as {
            handleAuthPopupRequest: (req: Request) => Promise<Response>;
          };
          const response = await mod.handleAuthPopupRequest(request);

          res.statusCode = response.status;
          // Preserve multiple Set-Cookie headers (OAuth state + session).
          const setCookies =
            typeof response.headers.getSetCookie === "function"
              ? response.headers.getSetCookie()
              : [];
          response.headers.forEach((value, key) => {
            if (key.toLowerCase() === "set-cookie") return;
            res.setHeader(key, value);
          });
          for (const cookie of setCookies) {
            res.appendHeader("set-cookie", cookie);
          }
          const body = Buffer.from(await response.arrayBuffer());
          res.end(body);
        } catch (err) {
          console.error("[app-builder] /auth/popup handler failed:", err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.end("auth popup failed");
          }
        }
      });
    },
  };
}

function companyFindApiPlugin(): Plugin {
  return {
    name: "mailgraph:enrich-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathOnly = (req.url ?? "").split("?", 1)[0] ?? "";
        const method = (req.method ?? "GET").toUpperCase();
        const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost:8080");
        const proto = String(req.headers["x-forwarded-proto"] ?? "http");
        const full = new URL(req.url ?? "/", `${proto}://${host}`);

        if (pathOnly === "/api/v2/companies/find") {
          if (method !== "GET") {
            res.statusCode = 405;
            res.end("Method Not Allowed");
            return;
          }
          try {
            const domain = full.searchParams.get("domain")?.trim();
            if (!domain) {
              res.statusCode = 400;
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ errors: [{ id: "missing_domain", detail: "domain is required" }] }));
              return;
            }
            const mod = (await server.ssrLoadModule(
              "/src/lib/email-finder/company-find.ts",
            )) as { findCompany: (d: string) => Promise<unknown> };
            const result = await mod.findCompany(domain);
            res.statusCode = 200;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify(result));
          } catch (err) {
            console.error("[company-find]", err);
            if (!res.headersSent) {
              res.statusCode = 500;
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ errors: [{ id: "internal", detail: String(err) }] }));
            }
          }
          return;
        }

        if (pathOnly === "/api/v2/people/find") {
          if (method !== "GET") {
            res.statusCode = 405;
            res.end("Method Not Allowed");
            return;
          }
          try {
            const email = full.searchParams.get("email")?.trim() || undefined;
            const linkedinUrl =
              full.searchParams.get("linkedin_url")?.trim() ||
              full.searchParams.get("linkedinUrl")?.trim() ||
              undefined;
            const fullName =
              full.searchParams.get("full_name")?.trim() ||
              full.searchParams.get("fullName")?.trim() ||
              undefined;
            const firstName =
              full.searchParams.get("first_name")?.trim() ||
              full.searchParams.get("firstName")?.trim() ||
              undefined;
            const lastName =
              full.searchParams.get("last_name")?.trim() ||
              full.searchParams.get("lastName")?.trim() ||
              undefined;
            const domain = full.searchParams.get("domain")?.trim() || undefined;
            const company = full.searchParams.get("company")?.trim() || undefined;
            const phone = full.searchParams.get("phone")?.trim() || undefined;
            if (!email && !linkedinUrl && !fullName && !(firstName && lastName)) {
              res.statusCode = 400;
              res.setHeader("content-type", "application/json");
              res.end(
                JSON.stringify({
                  errors: [
                    {
                      id: "missing_identity",
                      detail: "email, linkedin_url, full_name, or first_name+last_name is required",
                    },
                  ],
                }),
              );
              return;
            }
            const mod = (await server.ssrLoadModule(
              "/src/lib/email-finder/person-find.ts",
            )) as { findPerson: (i: Record<string, string | undefined>) => Promise<unknown> };
            const result = await mod.findPerson({
              email,
              linkedinUrl,
              fullName,
              firstName,
              lastName,
              domain,
              company,
              phone,
            });
            res.statusCode = 200;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify(result));
          } catch (err) {
            console.error("[people-find]", err);
            if (!res.headersSent) {
              res.statusCode = 500;
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ errors: [{ id: "internal", detail: String(err) }] }));
            }
          }
          return;
        }

        next();
      });
    },
  };
}

// `0.0.0.0:8080` is the live-preview contract — don't change host/port.
// Keep `nitro` gated to `build` (the Vercel deploy target): enabled in dev it
// opens a second dev-server port, which breaks the single-port preview.
// The dev server starts once `src/router.tsx` and `src/routes/` exist — see
// AGENTS.md § "First scaffold".
export default defineConfig(({ command }) => ({
  server: {
    host: "0.0.0.0",
    port: 8080,
    strictPort: true,
  },
  resolve: { tsconfigPaths: true },
  plugins: [
    pgliteBootstrapPlugin(),
    // Before tanstackStart so /auth/popup never falls through to the SPA.
    authPopupPlugin(),
    companyFindApiPlugin(),
    // PWA head + ?install=1 tutorial page; runs before Start/Nitro.
    grokPwaPlugin(),
    tailwindcss(),
    tanstackStart(),
    ...(command === "build"
      ? [
          nitro({
            preset: "vercel",
            // Auto-registers server/middleware/* (the PWA install page +
            // manifest + head-tag middleware). Nitro v3 defaults serverDir to
            // false, so removing this silently unwires /?install=1 on deploys.
            serverDir: "./server",
          }),
        ]
      : []),
    viteReact(),
  ],
}));
