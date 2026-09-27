import { expect, it } from "vitest";
import { projectTypingDiagnostics } from "../../scripts/lib/ios-typing-diagnostics.js";

it("publishes typing facts without copying arbitrary issue or editor data", () => {
  const log = [
    "unrelated private content",
    'prefix IOS_TYPING_PROBE {"source":"test","event":"issue","stage":"seed-0","category":"keyboard-focus","sourceLine":1883,"errorCode":-1,"description":"private description","text":"private message","uptimeMs":1234.5}',
    'IOS_TYPING_PROBE {"source":"app","event":"focus-result","editorId":2,"firstResponder":false,"result":false,"textLength":0,"stage":"private stage","category":"private category","enabled":"private value","endpoint":"https://private.invalid"}',
    'IOS_TYPING_PROBE {"source":"app","event":"environment-changed","environmentEnabled":false,"enabled":true,"text":"private draft"}',
    'IOS_TYPING_PROBE {"source":"app","event":"composer-readiness","pickerRequest":false,"pendingHandoff":false,"ownerMismatch":true,"gatewayConnected":true,"canQueueOffline":false,"owner":"private owner"}',
    'IOS_TYPING_PROBE {"source":"app","event":"owner-replaced","ownerChanged":false,"authorityChanged":true,"sessionChanged":false,"agentChanged":false,"contractChanged":false,"presentationPreserved":true,"storedAuthAllowedBefore":false,"storedAuthAllowedAfter":true,"sessionKey":"private session","token":"private token"}',
    'IOS_TYPING_PROBE {"source":"app","event":"private event"}',
    "IOS_TYPING_PROBE malformed",
  ].join("\n");
  expect(projectTypingDiagnostics(log)).toEqual([
    {
      source: "test",
      event: "issue",
      stage: "seed-0",
      category: "keyboard-focus",
      sourceLine: 1883,
      errorCode: -1,
      uptimeMs: 1234.5,
    },
    {
      source: "app",
      event: "focus-result",
      editorId: 2,
      firstResponder: false,
      result: false,
      textLength: 0,
    },
    {
      source: "app",
      event: "environment-changed",
      environmentEnabled: false,
      enabled: true,
    },
    {
      source: "app",
      event: "composer-readiness",
      pickerRequest: false,
      pendingHandoff: false,
      ownerMismatch: true,
      gatewayConnected: true,
      canQueueOffline: false,
    },
    {
      source: "app",
      event: "owner-replaced",
      ownerChanged: false,
      authorityChanged: true,
      sessionChanged: false,
      agentChanged: false,
      contractChanged: false,
      presentationPreserved: true,
      storedAuthAllowedBefore: false,
      storedAuthAllowedAfter: true,
    },
  ]);
});

it("bounds numeric facts and retains the final events of a busy editor", () => {
  const lines = Array.from(
    { length: 4100 },
    (_, index) =>
      `IOS_TYPING_PROBE ${JSON.stringify({
        source: "app",
        event: "text-changed",
        textLength: index,
        sequence: 9000,
        selectionLength: -1,
        modelLength: 1e40,
        keyboardHeight: 10001,
      })}`,
  ).join("\n");
  const facts = projectTypingDiagnostics(lines);
  expect(facts).toHaveLength(4096);
  expect(facts[0]).toEqual({ source: "app", event: "text-changed", textLength: 4 });
  expect(facts.at(-1)).toEqual({ source: "app", event: "text-changed", textLength: 4099 });
});
