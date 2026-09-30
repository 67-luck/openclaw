import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";

// Imported only by the setup-only fixture. Worker inheritance must not multiply samplers.
if (isMainThread) {
  const rounded = (value) =>
    Number.isFinite(value) ? Math.max(0, Math.round(value * 1_000) / 1_000) : 0;
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let previousAt = performance.now();
  let previousCpu = process.cpuUsage();
  let previousUtilization = performance.eventLoopUtilization();
  const timer = setInterval(() => {
    const now = performance.now();
    const cpu = process.cpuUsage();
    const utilization = performance.eventLoopUtilization();
    const memory = process.memoryUsage();
    const sample = {
      epochMs: Date.now(),
      uptimeMs: rounded(process.uptime() * 1_000),
      intervalMs: rounded(now - previousAt),
      cpuUserMs: rounded((cpu.user - previousCpu.user) / 1_000),
      cpuSystemMs: rounded((cpu.system - previousCpu.system) / 1_000),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      eventLoopUtilization: rounded(
        performance.eventLoopUtilization(utilization, previousUtilization).utilization,
      ),
      eventLoopDelayMaxMs: rounded(delay.max / 1_000_000),
      eventLoopDelayP99Ms: rounded(delay.percentile(99) / 1_000_000),
    };
    previousAt = now;
    previousCpu = cpu;
    previousUtilization = utilization;
    delay.reset();
    try {
      process.stdout.write(`IOS_SETUP_PROBE_RESOURCE ${JSON.stringify(sample)}\n`);
    } catch {
      clearInterval(timer);
      delay.disable();
    }
  }, 1_000);
  timer.unref();
}
