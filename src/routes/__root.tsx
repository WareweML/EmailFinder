import type { ReactNode } from "react";
import {
  Outlet,
  createRootRoute,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { Toaster } from "sonner";
import { CreatedWithGrokBanner } from "@/components/created-with-grok-banner";
import appCss from "@/styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, viewport-fit=cover",
      },
      {
        title: "Mailgraph — Find email addresses from any company",
      },
      {
        name: "description",
        content:
          "Domain search that crawls public pages, sitemaps, and CMS APIs to find company emails with sources — plus name finder and SMTP verification.",
      },
      { name: "theme-color", content: "#f7f8fa" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap",
      },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <CreatedWithGrokBanner />
      <Outlet />
      <Toaster
        theme="light"
        position="bottom-right"
        toastOptions={{
          classNames: {
            toast: "bg-surface border border-border text-fg shadow-md",
            title: "text-fg",
            description: "text-fg-muted",
          },
        }}
      />
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-dvh bg-bg text-fg antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
