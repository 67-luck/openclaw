import process from "node:process";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProxyHandle } from "../infra/net/proxy/proxy-lifecycle.js";
import type { CliPluginInvocationResources } from "./plugin-invocation-resources.js";
import { registerSignalExitBarrier, waitForSignalExitBarriers } from "./signal-exit-barrier.js";

export function createCliManagedProxy(
  resources?: Pick<CliPluginInvocationResources, "runCleanup">,
) {
  let proxyHandle: ProxyHandle | null = null;
  let proxyStopPromise: Promise<void> | undefined;
  let onSigterm: (() => void) | null = null;
  let onSigint: (() => void) | null = null;
  let onExit: (() => void) | null = null;
  let unregisterProxySignalExitBarrier: (() => void) | null = null;

  const uninstallProxySignalHandlers = () => {
    if (onSigterm) {
      process.off("SIGTERM", onSigterm);
      onSigterm = null;
    }
    if (onSigint) {
      process.off("SIGINT", onSigint);
      onSigint = null;
    }
    if (onExit) {
      process.off("exit", onExit);
      onExit = null;
    }
  };
  const stopStartedProxy = () => {
    if (proxyStopPromise) {
      return proxyStopPromise;
    }
    unregisterProxySignalExitBarrier?.();
    unregisterProxySignalExitBarrier = null;
    uninstallProxySignalHandlers();
    const handle = proxyHandle;
    proxyHandle = null;
    const stop = async () => {
      if (handle) {
        const { stopProxy } = await import("../infra/net/proxy/proxy-lifecycle.js");
        await stopProxy(handle);
      }
    };
    proxyStopPromise = Promise.resolve().then(() =>
      resources ? resources.runCleanup(stop) : stop(),
    );
    return proxyStopPromise;
  };
  const killStartedProxy = () => {
    const handle = proxyHandle;
    proxyHandle = null;
    handle?.kill("SIGTERM");
  };
  const installProxySignalHandlers = () => {
    if (!proxyHandle || onSigterm || onSigint || onExit) {
      return;
    }
    unregisterProxySignalExitBarrier = registerSignalExitBarrier(stopStartedProxy);
    const shutdown = (exitCode: number) => {
      void waitForSignalExitBarriers().finally(() => {
        process.exit(exitCode);
      });
    };
    onSigterm = () => shutdown(143);
    onSigint = () => shutdown(130);
    onExit = () => killStartedProxy();
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
    process.once("exit", onExit);
  };
  const replaceStartedProxy = async (config: OpenClawConfig["proxy"]) => {
    await stopStartedProxy();
    const { startProxy } = await import("../infra/net/proxy/proxy-lifecycle.js");
    proxyHandle = await startProxy(config);
    proxyStopPromise = undefined;
    installProxySignalHandlers();
  };
  return { stop: stopStartedProxy, replace: replaceStartedProxy };
}
