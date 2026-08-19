import { createFileRoute } from "@tanstack/react-router";
import { FinderApp } from "@/components/finder/finder-app";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return <FinderApp />;
}
