import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** The caller tracks fixture directories and restores PATH in its test lifecycle. */
export function createOpenCodeCliInstaller(
  temporaryDirectories: string[],
  originalPath: string | undefined,
) {
  return async function installFakeOpenCode(
    assistantText = "hi",
    sessionTitle = "Catalog session",
    toolInput: unknown = { command: "pwd" },
    version = 1,
    archivedFirst = false,
  ): Promise<string> {
    // openclaw-temp-dir: allow preserves the existing CLI fixture and caller-owned cleanup tracker.
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-opencode-catalog-"));
    temporaryDirectories.push(directory);
    const executable = path.join(directory, "opencode");
    const session = {
      id: "ses_test",
      title: sessionTitle,
      created: 1_700_000_000_000,
      updated: 1_700_000_001_000,
      projectId: "project",
      directory: "/workspace",
    };
    const model = { providerID: "anthropic", modelID: "claude" };
    const exported = {
      info: session,
      messages: [
        {
          info: { id: "msg_user", role: "user", time: { created: session.created }, model },
          parts: [{ id: "prt_user", type: "text", text: "hello" }],
        },
        {
          info: {
            id: "msg_assistant",
            role: "assistant",
            time: { created: session.updated },
            ...model,
          },
          parts: [
            { id: "prt_reason", type: "reasoning", text: "thinking" },
            { id: "prt_answer", type: "text", text: assistantText },
            {
              id: "prt_tool",
              type: "tool",
              tool: "bash",
              state: { status: "completed", input: toolInput, output: "/workspace" },
            },
          ],
        },
      ],
    };
    const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (process.env.CATALOG_UNRELATED_ENV) process.exit(3);
if (args[0] === "--version") {
  process.stdout.write(${JSON.stringify(`${version}.0.0`)});
  process.exit(0);
}
// Released @opencode/cli 2.0.16, source3a103fe: session.list/log and
// parentID=null are OpenAPI contracts, not the dev v2.* preview API.
if (${version} === 2) {
  if (args.includes("--pure") || !args.includes("--standalone")) process.exit(2);
  if (process.env.OPENCODE_CONFIG_PROJECT_DISABLE !== "1" || !process.env.OPENCODE_CONFIG_DIR) process.exit(3);
  if (args[0] === "api" && args[2] === "session.list") {
    if (!args.some((arg) => arg.startsWith("cursor=")) && (!args.includes("parentID=null") || !args.includes("order=desc"))) process.exit(9);
    if (${archivedFirst} && !args.some((arg) => arg.startsWith("cursor="))) {
      process.stdout.write(JSON.stringify({
        data: Array.from({ length: 100 }, (_, id) => ({
          id: "ses_archived" + id, time: { archived: 1 }, location: { directory: "/workspace" },
        })),
        cursor: { next: "live-page" },
      }));
      process.exit(0);
    }
    process.stdout.write(${JSON.stringify(
      JSON.stringify({
        data: [
          {
            id: session.id,
            title: session.title,
            time: { created: session.created, updated: session.updated },
            location: { directory: session.directory },
          },
        ],
      }),
    )});
  } else if (args[0] === "session" && args[1] === "export") {
    process.stdout.write(${JSON.stringify(
      JSON.stringify({
        info: session,
        messages: [
          { id: "msg_user", type: "user", text: "hello", time: { created: session.created } },
          {
            id: "msg_assistant",
            type: "assistant",
            model,
            time: { created: session.updated },
            content: [
              { type: "reasoning", text: "thinking" },
              { type: "text", text: assistantText },
              {
                type: "tool",
                id: "prt_tool",
                name: "bash",
                state: {
                  status: "completed",
                  input: toolInput,
                  content: [{ type: "text", text: "/workspace" }],
                },
              },
            ],
          },
        ],
      }),
    )});
  } else process.exitCode = 2;
  process.exit();
}
if (args[0] === "--pure" && args[1] === "db" && args.includes("--format") && args.includes("json")) {
  process.stdout.write(args[2].includes("event_sequence")
    ? ${JSON.stringify(JSON.stringify([{ id: "ses_test", seq: 4 }]))}
    : ${JSON.stringify(JSON.stringify([session]))});
} else if (args[0] === "--pure" && args[1] === "export" && args[2] === "ses_test") {
  process.stdout.write(${JSON.stringify(JSON.stringify(exported))});
} else {
  process.exitCode = 2;
}
`;
    // Flush and close the executable before exec: a still-open write handle makes
    // the immediately following spawn fail with ETXTBSY under parallel CI shards.
    const executableHandle = await fs.open(executable, "w");
    try {
      await executableHandle.writeFile(script);
      await executableHandle.sync();
    } finally {
      await executableHandle.close();
    }
    if (process.platform === "win32") {
      await fs.writeFile(path.join(directory, "opencode.js"), script);
      // This exact direct-forwarder shape is parsed into a Node entrypoint;
      // the batch wrapper itself is never executed through cmd.exe.
      await fs.writeFile(
        path.join(directory, "opencode.cmd"),
        '@echo off\r\n"%~dp0\\opencode.js" %*\r\n',
      );
    } else {
      await fs.chmod(executable, 0o755);
    }
    process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
    process.env.CATALOG_UNRELATED_ENV = "present";
    return directory;
  };
}
