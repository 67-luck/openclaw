// Frozen against the actual openclaw@2026.9.6 plugin-entry declaration.
// Deliberately V0: no liveAuthorityVersion, candidate imports, or V1 callbacks.
async function backend(profile, action, payload) {
  const url = new URL(profile.endpoint);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("Legacy worker fixture requires its isolated loopback backend");
  }
  const response = await fetch(new URL(action, url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(600_000),
  });
  if (!response.ok) {
    throw new Error(`Legacy worker backend ${action}: ${response.status}`);
  }
  return response.json();
}

export default {
  id: "legacy-worker-provider",
  register(api) {
    api.registerWorkerProvider({
      id: "survivor-legacy",
      requiresNodeEnrollment: true,
      provisionBeforeInstallation: true,
      resolveProvisionTimeoutMs: () => 600_000,
      resolveAllocation: (profile, operationId) => backend(profile, "resolve", { operationId }),
      async provision(profile, operationId, options) {
        // Allocate before the published enrollment callback. The controlled
        // backend runs a real node; Gateway owns enrollment, bundle transfer,
        // admission, persistence, and teardown authority.
        const allocation = await backend(profile, "allocate", { operationId });
        const enrollment = await options.beginNodeEnrollment();
        await backend(profile, "launch", {
          leaseId: allocation.leaseId,
          mode: enrollment.mode,
          setupCode: enrollment.mode === "connect" ? enrollment.setupCode : undefined,
          displayName: enrollment.displayName,
        });
        return {
          ...allocation,
          node: { deviceId: await enrollment.waitForDeviceId() },
        };
      },
      inspect: ({ profile, leaseId }) => backend(profile, "inspect", { leaseId }),
      destroy: async ({ profile, leaseId }) => {
        await backend(profile, "destroy", { leaseId });
      },
    });
  },
};
