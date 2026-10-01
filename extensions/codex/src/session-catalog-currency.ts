import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import {
  findCodexAppServerSpawnError,
  reportCodexCatalogSpawnFailure,
  type CodexAppServerSpawnError,
} from "./app-server/spawn-error.js";

type CurrencyOptions = {
  scheduler: PluginServiceSchedulerV1;
  local: boolean;
  reconcileFiles(): Promise<void>;
  reconcileNative(full: boolean): Promise<void>;
  report(error: unknown): void;
};

const SAFETY_INTERVAL_MS = 15 * 60_000;

/** One periodic reconciliation cycle per home, without a recursive watcher inventory. */
export class CodexCatalogCurrency {
  private started = false;
  private initial: ReturnType<PluginServiceSchedulerV1["schedule"]> | undefined;
  private hydration: ReturnType<PluginServiceSchedulerV1["schedule"]> | undefined;
  private terminalFailure: CodexAppServerSpawnError | undefined;
  private running: Promise<void> | undefined;
  private safetyRefresh: Promise<void> | undefined;
  private nativeDirty = false;
  private nextNativeAt = 0;
  private nextFilesAt = 0;

  constructor(private readonly options: CurrencyOptions) {}

  private get closed(): boolean {
    return this.options.scheduler.signal.aborted;
  }

  hasActiveWork(): boolean {
    return (
      this.hydration !== undefined ||
      this.initial !== undefined ||
      this.running !== undefined ||
      this.safetyRefresh !== undefined
    );
  }

  assertRunnable(): void {
    if (this.terminalFailure) {
      throw this.terminalFailure;
    }
  }

  stopForTerminalFailure(error: unknown): boolean {
    const failure = findCodexAppServerSpawnError(error);
    if (!failure) {
      return false;
    }
    if (!this.closed) {
      this.terminalFailure = failure;
      void this.close();
      reportCodexCatalogSpawnFailure(failure);
    }
    return true;
  }

  scheduleHydration(run: () => Promise<void>): void {
    if (this.closed || this.hydration) {
      return;
    }
    this.hydration = this.options.scheduler.schedule({
      id: "hydration",
      delayMs: 0,
      run: async () => {
        this.hydration = undefined;
        await run().catch((error: unknown) => this.options.report(error));
      },
    });
  }

  cancelHydration(): void {
    this.hydration?.cancel();
    this.hydration = undefined;
  }

  requestNativeRefresh(): void {
    this.nativeDirty = true;
  }

  /** Full safety walks serve catalog demand; an idle resident index does not start one. */
  refreshNativeIfDue(): Promise<void> {
    if (this.closed || !this.started || Date.now() < this.nextNativeAt) {
      return Promise.resolve();
    }
    if (this.safetyRefresh) {
      return this.safetyRefresh;
    }

    const completion = Promise.withResolvers<void>();
    let admitted = false;
    const cancelPending = () => {
      if (!admitted) {
        completion.resolve();
      }
    };
    this.options.scheduler.signal.addEventListener("abort", cancelPending, { once: true });
    this.safetyRefresh = completion.promise.finally(() => {
      this.options.scheduler.signal.removeEventListener("abort", cancelPending);
      this.safetyRefresh = undefined;
    });
    this.options.scheduler.schedule({
      id: "native-safety",
      delayMs: 0,
      run: async () => {
        admitted = true;
        try {
          if (this.running) {
            await this.running;
          }
          if (this.closed || Date.now() < this.nextNativeAt) {
            return;
          }
          await this.options.reconcileNative(true).catch((error: unknown) => {
            this.options.report(
              new Error(
                `Codex catalog reconciliation failed; waiting for the next safety interval and catalog demand: ${coerceErrorMessage(error)}`,
                { cause: error },
              ),
            );
          });
          // A failed walk must not restart on every busy catalog read.
          this.nextNativeAt = Date.now() + SAFETY_INTERVAL_MS;
        } finally {
          completion.resolve();
        }
      },
    });
    return this.safetyRefresh;
  }

  start(): void {
    if (this.closed || this.started) {
      return;
    }
    this.nextNativeAt = Date.now() + SAFETY_INTERVAL_MS;
    this.nextFilesAt = this.nextNativeAt;
    this.started = true;
    this.options.scheduler.schedule({
      id: "currency",
      delayMs: 30_000,
      everyMs: 30_000,
      run: () => {
        const startedAt = Date.now();
        const filesDue = this.options.local && startedAt >= this.nextFilesAt;
        const nativeDue = this.nativeDirty && !this.safetyRefresh;
        if (!filesDue && !nativeDue) {
          return;
        }
        // Consume only work admitted to this cycle; activity stays queued during a full walk.
        if (nativeDue) {
          this.nativeDirty = false;
        }
        if (filesDue) {
          this.nextFilesAt = startedAt + SAFETY_INTERVAL_MS;
        }
        const run = async () => {
          if (filesDue) {
            await this.options.reconcileFiles();
          }
          if (nativeDue) {
            await this.options.reconcileNative(false);
          }
        };
        this.running = run()
          .catch((error: unknown) => {
            this.options.report(
              new Error(
                `Codex catalog reconciliation failed; waiting for new activity or the next file safety cycle: ${coerceErrorMessage(error)}`,
                { cause: error },
              ),
            );
          })
          .finally(() => {
            this.running = undefined;
          });
        return this.running;
      },
    });
    if (this.options.local) {
      // Restored snapshots serve immediately; the initial delta scan runs separately.
      this.initial = this.options.scheduler.schedule({
        id: "initial-files",
        delayMs: 0,
        run: async () => {
          try {
            await this.options
              .reconcileFiles()
              .catch((error: unknown) => this.options.report(error));
          } finally {
            this.initial = undefined;
          }
        },
      });
    }
  }

  close(): Promise<void> {
    const scheduled = this.options.scheduler.stop();
    this.hydration = undefined;
    this.initial = undefined;
    return scheduled;
  }
}
