import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createControlUiE2eArtifactDir } from "../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import {
  createControlUiMockBootstrapConfig,
  createControlUiMockGatewayInitScript,
  startControlUiE2eServer,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { runWithFailedTrailer } from "./lib/failed-trailer.mts";

await runWithFailedTrailer("native-link-proof", async () => {
  const parent = path.resolve(".artifacts/native-link-proof");
  const artifactDir = createControlUiE2eArtifactDir("mac-browser", parent);
  const sourceSha = process.argv[2];
  if (!sourceSha || !/^[a-f0-9]{40}$/.test(sourceSha)) {
    throw new Error("Pass the exact product source SHA");
  }
  const events = new Map<string, unknown>();
  const waiters = new Map<string, Set<ServerResponse>>();
  const respond = (res: ServerResponse, value: unknown) => {
    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify(value));
  };
  const record = (stage: string, value: unknown) => {
    events.set(stage, value);
    fs.writeFileSync(path.join(artifactDir, stage + ".json"), JSON.stringify(value, null, 2));
    for (const res of waiters.get(stage) ?? []) {
      respond(res, value);
    }
    waiters.delete(stage);
  };
  const proofPath = "/opened/" + randomUUID();
  const external = createServer((req, res) => {
    if (req.url === proofPath) {
      record("opened", {
        url: targetUrl,
        userAgent: req.headers["user-agent"],
        observedAt: new Date().toISOString(),
      });
      res.writeHead(200, { "Content-Type": "text/html", Connection: "close" });
      res.end(
        "<!doctype html><title>OpenClaw native browser proof</title><h1>Link opened in the external browser</h1><p>Synthetic loopback test page. No live account or user data.</p>",
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  external.listen(0, "127.0.0.1");
  await once(external, "listening");
  const address = external.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing proof server port");
  }
  const targetUrl = "http://127.0.0.1:" + address.port + proofPath;
  const upstream = await startControlUiE2eServer(undefined, { source: true });
  const scenario = {
    assistantName: "OpenClaw",
    agentModel: null,
    models: [],
    historyMessages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Open the [native browser proof page](" + targetUrl + ")." },
        ],
      },
    ],
  };
  const mock = createControlUiMockGatewayInitScript(scenario);
  // Observe readiness only. Neither WebKit's native handlers nor link routing are mocked.
  const readiness = [
    "(() => { let sent = false; const stage = location.pathname.includes('/settings/') ? 'settings' : 'chat';",
    "const observer = new MutationObserver(check); async function check() { if (sent) return;",
    "const ready = stage === 'settings' ? [...document.querySelectorAll('.settings-row__title')].some(e => e.textContent.trim() === 'Open links outside OpenClaw') : [...document.querySelectorAll('a')].some(e => e.href === " +
      JSON.stringify(targetUrl) +
      ");",
    "if (!ready) return; sent = true; observer.disconnect(); if (stage === 'settings') await customElements.whenDefined('wa-switch');",
    "await fetch('/__native-proof__/ready/' + stage, {method:'POST'}); } observer.observe(document, {subtree:true,childList:true}); check(); })();",
  ].join("\n");
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/__native-proof__/ready/")) {
        record(url.pathname.split("/").at(-1)!, { observedAt: new Date().toISOString() });
        respond(res, { ok: true });
        return;
      }
      if (url.pathname === "/__native-proof__/state") {
        respond(res, Object.fromEntries(events));
        return;
      }
      if (url.pathname.startsWith("/__native-proof__/wait/")) {
        const stage = url.pathname.split("/").at(-1)!;
        if (events.has(stage)) {
          respond(res, events.get(stage));
          return;
        }
        const waiting = waiters.get(stage) ?? new Set<ServerResponse>();
        waiting.add(res);
        waiters.set(stage, waiting);
        res.once("close", () => waiting.delete(res));
        return;
      }
      if (url.pathname.endsWith("/control-ui-config.json")) {
        respond(res, createControlUiMockBootstrapConfig(scenario));
        return;
      }
      const response = await fetch(new URL(req.url ?? "/", upstream.baseUrl));
      const type = response.headers.get("content-type") ?? "application/octet-stream";
      let bytes = Buffer.from(await response.arrayBuffer());
      if (type.includes("text/html")) {
        const injected = mock + "\n" + readiness;
        bytes = Buffer.from(
          bytes
            .toString()
            .replace(
              "</head>",
              "<script>" + injected.replaceAll("</script", "<\\/script") + "</script></head>",
            ),
        );
      }
      res.writeHead(response.status, {
        "Content-Type": type,
        "Cache-Control": "no-store",
        Connection: "close",
      });
      res.end(bytes);
    })().catch((error: unknown) => {
      console.error("[native-link-proof] HTTP fixture failed", error);
      res.writeHead(500);
      res.end("Fixture failed");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const front = server.address();
  if (!front || typeof front === "string") {
    throw new Error("Missing UI server port");
  }
  const config = {
    uiUrl: "http://127.0.0.1:" + front.port + "/",
    targetUrl,
    artifactDir: pathToFileURL(artifactDir).href,
    sourceSha,
  };
  fs.writeFileSync(path.join(parent, "current.json"), JSON.stringify(config, null, 2));
  console.log("[native-link-proof] Ready for native app at " + config.uiUrl);
  await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
  });
  server.closeAllConnections();
  external.closeAllConnections();
  await Promise.all([
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
    new Promise<void>((resolve) => {
      external.close(() => resolve());
    }),
    upstream.close(),
  ]);
});
