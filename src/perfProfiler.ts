export const SLICE_PROFILING_ENABLED = true;

interface StageStat {
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
}

const stats = new Map<string, StageStat>();
const currentStats = new Map<string, StageStat>();
const listeners = new Set<() => void>();
let sliceBuildCount = 0;
let notifyQueued = false;
let currentContext = "slice";

declare global {
  interface Window {
    __sliceProfiler?: {
      print: () => void;
      snapshot: () => Array<{ stage: string; count: number; lastMs: number; avgMs: number; maxMs: number }>;
      recent: () => Array<{ stage: string; count: number; lastMs: number; avgMs: number; maxMs: number }>;
      reset: () => void;
    };
  }
}

export function measureStage<T>(name: string, work: () => T): T {
  if (!SLICE_PROFILING_ENABLED) {
    return work();
  }

  const start = performance.now();
  try {
    return work();
  } finally {
    recordStage(name, performance.now() - start);
  }
}

export function recordStage(name: string, durationMs: number) {
  if (!SLICE_PROFILING_ENABLED) {
    return;
  }

  const stat = stats.get(name) ?? {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    lastMs: 0,
  };

  stat.count += 1;
  stat.totalMs += durationMs;
  stat.maxMs = Math.max(stat.maxMs, durationMs);
  stat.lastMs = durationMs;
  stats.set(name, stat);

  const currentStat = currentStats.get(name) ?? {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    lastMs: 0,
  };
  currentStat.count += 1;
  currentStat.totalMs += durationMs;
  currentStat.maxMs = Math.max(currentStat.maxMs, durationMs);
  currentStat.lastMs = durationMs;
  currentStats.set(name, currentStat);

  queueNotify();
}

export function beginSliceProfileCycle(context: string) {
  if (!SLICE_PROFILING_ENABLED) {
    return;
  }

  currentContext = context;
  currentStats.clear();
  queueNotify();
}

export function markSliceBuildComplete(context: string) {
  if (!SLICE_PROFILING_ENABLED) {
    return;
  }

  sliceBuildCount += 1;
  if (sliceBuildCount === 1 || sliceBuildCount % 12 === 0) {
    printRecentSliceProfile(context);
  }
}

export function printSliceProfile(context = "slice") {
  if (!SLICE_PROFILING_ENABLED || stats.size === 0) {
    return;
  }

  const rows = getSliceProfileSnapshot();

  console.info(`[slice profiler] ${context} #${sliceBuildCount}`);
  console.table(rows);
}

export function getSliceProfileSnapshot() {
  return makeRows(stats, "max");
}

export function getRecentSliceProfileSnapshot() {
  return makeRows(currentStats, "last");
}

export function printRecentSliceProfile(context = currentContext) {
  if (!SLICE_PROFILING_ENABLED || currentStats.size === 0) {
    return;
  }

  const rows = getRecentSliceProfileSnapshot();
  console.info(`[slice profiler recent] ${context} #${sliceBuildCount}`);
  console.table(rows);
}

function makeRows(source: Map<string, StageStat>, sortBy: "last" | "max") {
  return Array.from(source.entries())
    .map(([stage, stat]) => ({
      stage,
      count: stat.count,
      lastMs: Number(stat.lastMs.toFixed(2)),
      avgMs: Number((stat.totalMs / stat.count).toFixed(2)),
      maxMs: Number(stat.maxMs.toFixed(2)),
    }))
    .sort((a, b) => {
      const aTotal = a.stage.includes("total");
      const bTotal = b.stage.includes("total");
      if (aTotal !== bTotal) {
        return aTotal ? 1 : -1;
      }
      return sortBy === "last" ? b.lastMs - a.lastMs : b.maxMs - a.maxMs;
    });
}

export function subscribeSliceProfile(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetSliceProfile() {
  stats.clear();
  currentStats.clear();
  sliceBuildCount = 0;
  queueNotify();
}

function queueNotify() {
  if (notifyQueued || typeof window === "undefined") {
    return;
  }

  notifyQueued = true;
  window.requestAnimationFrame(() => {
    notifyQueued = false;
    listeners.forEach((listener) => listener());
  });
}

if (typeof window !== "undefined") {
  window.__sliceProfiler = {
    print: () => printSliceProfile("manual"),
    snapshot: getSliceProfileSnapshot,
    recent: getRecentSliceProfileSnapshot,
    reset: resetSliceProfile,
  };
}
