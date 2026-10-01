import { expect, it, vi } from "vitest";
import type {
  createGatewayCloseTestDepsFactory,
  createGatewayCloseTestHandlerFactory,
  GatewayCloseParams,
} from "./server-close.test-support.js";

type GatewayCloseClient = GatewayCloseParams["clients"] extends Set<infer T> ? T : never;
const WEBSOCKET_CLOSE_GRACE_MS = 1_000;
const WEBSOCKET_CLOSE_FORCE_CONTINUE_MS = 250;
const HTTP_CLOSE_GRACE_MS = 1_000;
const HTTP_CLOSE_FORCE_WAIT_MS = 5_000;

export function registerGatewayCloseListenerCases({
  createGatewayCloseHandler,
  createGatewayCloseTestDeps,
  mocks,
}: {
  createGatewayCloseHandler: ReturnType<typeof createGatewayCloseTestHandlerFactory>;
  createGatewayCloseTestDeps: ReturnType<typeof createGatewayCloseTestDepsFactory>;
  mocks: { logWarn: ReturnType<typeof vi.fn> };
}) {
  it("terminates lingering websocket clients when websocket close exceeds the grace window", async () => {
    vi.useFakeTimers();

    let closeCallback: (() => void) | null = null;
    const terminate = vi.fn(() => {
      closeCallback?.();
    });
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        wss: {
          clients: new Set([{ terminate }]),
          close: (cb: () => void) => {
            closeCallback = cb;
          },
          // SAFETY: shutdown only reads clients/close for WS, or close/closeIdleConnections/closeAllConnections for HTTP; this fixture supplies those exact transport operations.
        } as never,
      }),
    );

    const closePromise = close({ reason: "test shutdown" });
    await vi.advanceTimersByTimeAsync(WEBSOCKET_CLOSE_GRACE_MS);
    const result = await closePromise;

    expect(result.warnings).toContain("websocket-server");
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues shutdown when websocket close hangs without tracked clients", async () => {
    vi.useFakeTimers();

    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        wss: {
          clients: new Set(),
          close: () => undefined,
          // SAFETY: shutdown only reads clients/close for WS, or close/closeIdleConnections/closeAllConnections for HTTP; this fixture supplies those exact transport operations.
        } as never,
      }),
    );

    const closePromise = close({ reason: "test shutdown" });
    await vi.advanceTimersByTimeAsync(WEBSOCKET_CLOSE_GRACE_MS + WEBSOCKET_CLOSE_FORCE_CONTINUE_MS);
    const result = await closePromise;

    expect(result.warnings).toContain("websocket-server");
    expect(vi.getTimerCount()).toBe(0);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("websocket server close still pending after 250ms force window"),
      ),
    ).toBe(true);
  });

  it("records a warning when a websocket client close throws", async () => {
    const clients = new Set<GatewayCloseClient>([
      {
        socket: {
          close: vi.fn(() => {
            throw new Error("already closed");
          }),
        },
      },
      { socket: { close: vi.fn() } },
    ]);
    const close = createGatewayCloseHandler(createGatewayCloseTestDeps({ clients }));

    const result = await close({ reason: "test shutdown" });

    expect(result.warnings).toContain("ws-clients");
    expect(clients.size).toBe(0);
  });

  it("forces lingering HTTP connections closed and records a timeout warning", async () => {
    vi.useFakeTimers();

    let closeCallback: ((err?: Error | null) => void) | null = null;
    const closeAllConnections = vi.fn(() => {
      closeCallback?.(null);
    });
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        httpServer: {
          close: (cb: (err?: Error | null) => void) => {
            closeCallback = cb;
          },
          closeAllConnections,
          closeIdleConnections: vi.fn(),
          // SAFETY: shutdown only reads clients/close for WS, or close/closeIdleConnections/closeAllConnections for HTTP; this fixture supplies those exact transport operations.
        } as never,
      }),
    );

    const closePromise = close({ reason: "test shutdown" });
    await vi.advanceTimersByTimeAsync(HTTP_CLOSE_GRACE_MS);
    const result = await closePromise;

    expect(result.warnings).toContain("http-server");
    expect(closeAllConnections).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("http-server close exceeded 1000ms"),
      ),
    ).toBe(true);
  });

  it("fails shutdown when http server close still hangs after force close", async () => {
    vi.useFakeTimers();

    const closeHttpServer = vi.fn(() => undefined);
    const closeAllConnections = vi.fn();
    const tailscaleCleanup = vi.fn(async () => undefined);
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        httpServer: {
          close: closeHttpServer,
          closeAllConnections,
          closeIdleConnections: vi.fn(),
          // SAFETY: shutdown only reads clients/close for WS, or close/closeIdleConnections/closeAllConnections for HTTP; this fixture supplies those exact transport operations.
        } as never,
        tailscaleCleanup,
      }),
    );

    const closePromise = close({ reason: "test shutdown" });
    const closeExpectation = expect(closePromise).rejects.toThrow(
      "http-server close still pending after forced connection shutdown (5000ms)",
    );
    await vi.waitFor(() => expect(closeHttpServer).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(HTTP_CLOSE_GRACE_MS);
    expect(closeAllConnections).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HTTP_CLOSE_FORCE_WAIT_MS);
    await closeExpectation;

    expect(tailscaleCleanup).toHaveBeenCalledTimes(1);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("http-server close exceeded 1000ms"),
      ),
    ).toBe(true);
  });

  it("attempts every HTTP listener before rejecting a stuck close", async () => {
    vi.useFakeTimers();

    const stuckServer = {
      close: vi.fn(() => undefined),
      closeAllConnections: vi.fn(),
      closeIdleConnections: vi.fn(),
    };
    const laterServer = {
      close: vi.fn((cb: (err?: Error | null) => void) => cb(null)),
      closeIdleConnections: vi.fn(),
    };
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        // SAFETY: both HTTP stand-ins supply the close and forced-connection operations exercised by shutdown.
        httpServers: [stuckServer as never, laterServer as never],
      }),
    );

    const closePromise = close({ reason: "test shutdown" });
    const closeExpectation = expect(closePromise).rejects.toThrow(
      "http-server[0] close still pending after forced connection shutdown (5000ms)",
    );
    await vi.waitFor(() => expect(stuckServer.close).toHaveBeenCalledOnce());
    expect(laterServer.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(HTTP_CLOSE_GRACE_MS + HTTP_CLOSE_FORCE_WAIT_MS);
    await closeExpectation;

    expect(stuckServer.closeAllConnections).toHaveBeenCalledOnce();
  });

  it("labels warnings for multiple HTTP servers with their index", async () => {
    const okServer = {
      close: (cb: (err?: Error | null) => void) => cb(null),
      closeIdleConnections: vi.fn(),
    };
    const failServer = {
      close: (cb: (err?: Error | null) => void) => cb(new Error("port busy")),
      closeIdleConnections: vi.fn(),
    };
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        // SAFETY: both HTTP stand-ins supply close and closeIdleConnections; forced shutdown is not entered.
        httpServers: [okServer as never, failServer as never],
      }),
    );

    const result = await close({ reason: "test shutdown" });

    expect(result.warnings).toContain("http-server[1]");
    expect(result.warnings).not.toContain("http-server[0]");
  });

  it("ignores unbound http servers during shutdown", async () => {
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        httpServer: {
          close: (cb: (err?: NodeJS.ErrnoException | null) => void) =>
            cb(
              Object.assign(new Error("Server is not running."), {
                code: "ERR_SERVER_NOT_RUNNING",
              }),
            ),
          closeIdleConnections: vi.fn(),
          // SAFETY: shutdown only reads clients/close for WS, or close/closeIdleConnections/closeAllConnections for HTTP; this fixture supplies those exact transport operations.
        } as never,
      }),
    );

    const result = await close({ reason: "startup failed before bind" });
    expect(result.warnings).toStrictEqual([]);
  });
}
