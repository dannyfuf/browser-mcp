import { z } from 'zod';
import { session } from '../browser.ts';
import {
  emulatePerformance,
  heapSnapshot,
  performanceMetrics,
  startCoverage,
  startCpuProfile,
  startTrace,
  stopCoverage,
  stopCpuProfile,
  stopTrace,
} from '../performance.ts';
import { jsonOk, type ToolDef, tool } from './registry.ts';

const optionalTab = z.number().int().positive().optional();
const top = z.number().int().min(1).max(50).optional();

const startTraceTool = tool({
  name: 'browser_start_trace',
  description:
    'Start a Chrome DevTools Performance trace. Typical workflow: start_trace → reproduce the slowdown with other browser_* tools → stop_trace. Only one trace can run per browser; it auto-stops after 60s by default (maximum 300s).',
  inputShape: {
    tab: optionalTab,
    screenshots: z.boolean().optional(),
    categories: z.array(z.string().min(1)).min(1).optional(),
    max_duration_s: z.number().positive().max(300).optional(),
  },
  handler: async ({ tab, screenshots, categories, max_duration_s }) => {
    const page = await selectedPage(tab);
    return jsonOk(
      await startTrace(page, pageTargetId(page), {
        screenshots,
        categories,
        maxDurationS: max_duration_s,
      }),
    );
  },
});

const stopTraceTool = tool({
  name: 'browser_stop_trace',
  description:
    'Stop the active trace and return its DevTools-loadable trace path plus a compact bottleneck summary (long tasks, self time, layout, shifts, and user timing). Open it with DevTools → Performance → Load profile.',
  inputShape: { top },
  handler: async ({ top }) => jsonOk(await stopTrace(top)),
});

const startCpuProfileTool = tool({
  name: 'browser_start_cpu_profile',
  description:
    'Start sampling JavaScript CPU activity in a tab. Use start_cpu_profile → reproduce with browser_* tools → stop_cpu_profile when tracing is too broad and you need the hottest functions/scripts.',
  inputShape: {
    tab: optionalTab,
    sampling_interval_us: z.number().int().positive().max(1_000_000).optional(),
  },
  handler: async ({ tab, sampling_interval_us }) => {
    const page = await selectedPage(tab);
    return jsonOk(await startCpuProfile(pageTargetId(page), page, sampling_interval_us));
  },
});

const stopCpuProfileTool = tool({
  name: 'browser_stop_cpu_profile',
  description:
    'Stop the current tab CPU profile. Returns a Chrome DevTools .cpuprofile path and bounded summaries by function self/total time and script URL.',
  inputShape: { top },
  handler: async ({ top }) => {
    const page = await session.getCurrentPage();
    return jsonOk(await stopCpuProfile(pageTargetId(page), top));
  },
});

const metricsTool = tool({
  name: 'browser_performance_metrics',
  description:
    'Take a lightweight performance snapshot: CDP CPU/heap/DOM counters, navigation and paint timing, buffered Web Vitals where supported, long animation frames, and slow/large resources. Use before and after a change; the result reports active throttling.',
  inputShape: { tab: optionalTab },
  handler: async ({ tab }) => {
    const page = await selectedPage(tab);
    return jsonOk(await performanceMetrics(page, pageTargetId(page)));
  },
});

const emulateTool = tool({
  name: 'browser_emulate',
  description:
    "Apply CPU/network throttling or disable cache for the selected tab. Throttling helps reproduce real-user bottlenecks hidden by fast development machines. Use rate=1, network='none', and disable_cache=false to reset.",
  inputShape: {
    tab: optionalTab,
    cpu_throttling_rate: z.number().min(1).max(20).optional(),
    network: z.enum(['none', 'offline', 'slow3g', 'fast3g', 'slow4g', 'fast4g']).optional(),
    disable_cache: z.boolean().optional(),
  },
  handler: async ({ tab, cpu_throttling_rate, network, disable_cache }) => {
    const page = await selectedPage(tab);
    return jsonOk(
      await emulatePerformance(page, pageTargetId(page), {
        cpuThrottlingRate: cpu_throttling_rate,
        network,
        disableCache: disable_cache,
      }),
    );
  },
});

const heapSnapshotTool = tool({
  name: 'browser_heap_snapshot',
  description:
    'Write a Chrome DevTools .heapsnapshot for memory-retention investigation. The snapshot streams directly to the artifact file; optional garbage collection defaults to true. Returns path, bytes, and heap used before/after GC.',
  inputShape: {
    tab: optionalTab,
    collect_garbage: z.boolean().optional(),
  },
  handler: async ({ tab, collect_garbage }) => {
    const page = await selectedPage(tab);
    return jsonOk(await heapSnapshot(page, collect_garbage ?? true));
  },
});

const startCoverageTool = tool({
  name: 'browser_start_coverage',
  description:
    'Start JavaScript and optional CSS coverage across navigations. Typical workflow: start_coverage → exercise the important flow with browser_* tools → stop_coverage to find unused bundle bytes.',
  inputShape: {
    tab: optionalTab,
    include_css: z.boolean().optional(),
  },
  handler: async ({ tab, include_css }) => {
    const page = await selectedPage(tab);
    return jsonOk(await startCoverage(pageTargetId(page), page, include_css ?? true));
  },
});

const stopCoverageTool = tool({
  name: 'browser_stop_coverage',
  description:
    'Stop coverage for the current tab, write full raw JS/CSS coverage JSON, and return the files with the most unused bytes plus aggregate totals.',
  inputShape: { top },
  handler: async ({ top }) => {
    const page = await session.getCurrentPage();
    return jsonOk(await stopCoverage(pageTargetId(page), top));
  },
});

async function selectedPage(tab?: number) {
  if (tab !== undefined) await session.switchTab(tab);
  return await session.getCurrentPage();
}

function pageTargetId(page: Awaited<ReturnType<typeof session.getCurrentPage>>): string {
  return (page.target() as unknown as { _targetId: string })._targetId;
}

export const performanceTools: ToolDef<any>[] = [
  startTraceTool,
  stopTraceTool,
  startCpuProfileTool,
  stopCpuProfileTool,
  metricsTool,
  emulateTool,
  heapSnapshotTool,
  startCoverageTool,
  stopCoverageTool,
];
