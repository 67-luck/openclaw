import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("people"),
  loaderDeps: (_context, location) => location.search,
  loader: (_context, { location }) => new URLSearchParams(location.search).get("person") ?? "",
  component: () =>
    import("./people-page.ts").then(() => ({
      header: true,
      render: (personId: string | undefined) =>
        html`<openclaw-people-page .personId=${personId ?? ""}></openclaw-people-page>`,
    })),
});
