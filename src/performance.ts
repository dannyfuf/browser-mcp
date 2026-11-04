import { appendFile, readFile, stat, writeFile } from 'node:fs/promises';
import { type CDPSession, type Page, PredefinedNetworkConditions, type Protocol } from 'puppeteer';
import { artifactPath } from './artifacts.ts';
import { type CoverageEntry, type CoverageSummary, summarizeCoverage } from './perf/coverage.ts';
import {
  type CpuProfile,
  type CpuProfileSummary,
  summarizeCpuProfile,
} from './perf/cpu-profile.ts';
import { summarizeTrace, type TraceFile, type TraceSummary } from './perf/trace.ts';

export const DEFAULT_TRACE_CATEGORIES = [
  '-*',
  'devtools.timeline',
  'v8.execute',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'toplevel',
  'blink.console',
  'blink.user_timing',
  'latencyInfo',
  'disabled-by-default-devtools.timeline.stack',
  'disabled-by-default-v8.cpu_profiler',
  'loading',
];

export type NetworkPreset = 'none' | 'offline' | 'slow3g' | 'fast3g' | 'slow4g' | 'fast4g';

export interface EmulationSettings {
  cpuThrottlingRate: number;
  network: NetworkPreset;
  cacheDisabled: boolean;
}

export interface TraceStopResult {
  tracePath: string;
  summary: TraceSummary;
  capFired: boolean;
  openIn: string;
}

export interface CpuStopResult {
  profilePath: string;
  summary: CpuProfileSummary;
}

export interface CoverageStopResult {
  coveragePath: string;
  summary: CoverageSummary;
}

interface TraceRuntime {
  page: Page;
  targetId: string;
  tracePath: string;
  frameId?: string;
  status: 'recording' | 'stopping' | 'stopped';
  capFired: boolean;
  timer?: ReturnType<typeof setTimeout>;
  stopPromise?: Promise<TraceStopResult>;
}

interface CpuRuntime {
  cdp: CDPSession;
  profilePath: string;
  stopPromise?: Promise<CpuStopResult>;
}

interface CoverageRuntime {
  page: Page;
  includeCss: boolean;
  coveragePath: string;
  stopPromise?: Promise<CoverageStopResult>;
}

const DEFAULT_TRACE_DURATION_S = 60;
const MAX_TRACE_DURATION_S = 300;
const DEFAULT_EMULATION: EmulationSettings = {
  cpuThrottlingRate: 1,
  network: 'none',
  cacheDisabled: false,
};

let activeTrace: TraceRuntime | undefined;
const cpuProfiles = new Map<string, CpuRuntime>();
const coverages = new Map<string, CoverageRuntime>();
const emulations = new Map<string, EmulationSettings>();

export async function startTrace(
  page: Page,
  targetId: string,
  opts: { screenshots?: boolean; categories?: string[]; maxDurationS?: number },
): Promise<{ tracePath: string; maxDurationS: number }> {
  if (activeTrace)
    throw new Error('a browser trace is already active; stop it before starting another');
  const maxDurationS = opts.maxDurationS ?? DEFAULT_TRACE_DURATION_S;
  if (!Number.isFinite(maxDurationS) || maxDurationS <= 0 || maxDurationS > MAX_TRACE_DURATION_S) {
    throw new Error(`maxDurationS must be between 1 and ${MAX_TRACE_DURATION_S}`);
  }
  const tracePath = artifactPath('trace', 'json');
  const runtime: TraceRuntime = {
    page,
    targetId,
    tracePath,
    frameId: await mainFrameId(page),
    status: 'recording',
    capFired: false,
  };
  activeTrace = runtime;
  try {
    await page.tracing.start({
      path: tracePath,
      screenshots: opts.screenshots ?? false,
      categories: [...(opts.categories ?? DEFAULT_TRACE_CATEGORIES)],
    });
  } catch (error) {
    activeTrace = undefined;
    throw error;
  }
  runtime.timer = setTimeout(() => {
    runtime.capFired = true;
    runtime.stopPromise ??= performStopTrace(runtime);
    void runtime.stopPromise.catch(() => undefined);
  }, maxDurationS * 1_000);
  return { tracePath, maxDurationS };
}

export async function stopTrace(top = 10): Promise<TraceStopResult> {
  const runtime = activeTrace;
  if (!runtime) throw new Error('no browser trace is active');
  try {
    runtime.stopPromise ??= performStopTrace(runtime, top);
    return await runtime.stopPromise;
  } finally {
    if (runtime.status === 'stopped') activeTrace = undefined;
  }
}

export async function startCpuProfile(
  targetId: string,
  page: Page,
  samplingIntervalUs?: number,
): Promise<{ profilePath: string }> {
  if (cpuProfiles.has(targetId))
    throw new Error(`tab ${targetId} already has an active CPU profile`);
  const cdp = await page.createCDPSession();
  const profilePath = artifactPath('cpu', 'cpuprofile');
  try {
    await cdp.send('Profiler.enable');
    if (samplingIntervalUs !== undefined) {
      await cdp.send('Profiler.setSamplingInterval', { interval: samplingIntervalUs });
    }
    await cdp.send('Profiler.start');
  } catch (error) {
    await cdp.detach().catch(() => undefined);
    throw error;
  }
  cpuProfiles.set(targetId, { cdp, profilePath });
  return { profilePath };
}

export async function stopCpuProfile(targetId: string, top = 10): Promise<CpuStopResult> {
  const runtime = cpuProfiles.get(targetId);
  if (!runtime) throw new Error(`tab ${targetId} has no active CPU profile`);
  try {
    runtime.stopPromise ??= performStopCpu(runtime, top);
    return await runtime.stopPromise;
  } finally {
    cpuProfiles.delete(targetId);
  }
}

export async function startCoverage(
  targetId: string,
  page: Page,
  includeCss = true,
): Promise<{ coveragePath: string; includeCss: boolean }> {
  if (coverages.has(targetId)) throw new Error(`tab ${targetId} already has active coverage`);
  const coveragePath = artifactPath('coverage', 'json');
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  try {
    if (includeCss) await page.coverage.startCSSCoverage({ resetOnNavigation: false });
  } catch (error) {
    await page.coverage.stopJSCoverage().catch(() => undefined);
    throw error;
  }
  coverages.set(targetId, { page, includeCss, coveragePath });
  return { coveragePath, includeCss };
}

export async function stopCoverage(targetId: string, top = 10): Promise<CoverageStopResult> {
  const runtime = coverages.get(targetId);
  if (!runtime) throw new Error(`tab ${targetId} has no active coverage`);
  try {
    runtime.stopPromise ??= performStopCoverage(runtime, top);
    return await runtime.stopPromise;
  } finally {
    coverages.delete(targetId);
  }
}

export async function emulatePerformance(
  page: Page,
  targetId: string,
  updates: {
    cpuThrottlingRate?: number;
    network?: NetworkPreset;
    disableCache?: boolean;
  },
): Promise<EmulationSettings> {
  const current = emulations.get(targetId) ?? DEFAULT_EMULATION;
  const next = {
    cpuThrottlingRate: updates.cpuThrottlingRate ?? current.cpuThrottlingRate,
    network: updates.network ?? current.network,
    cacheDisabled: updates.disableCache ?? current.cacheDisabled,
  };
  if (updates.cpuThrottlingRate !== undefined) {
    await page.emulateCPUThrottling(next.cpuThrottlingRate === 1 ? null : next.cpuThrottlingRate);
  }
  if (updates.network !== undefined) {
    if (next.network === 'offline') {
      await page.emulateNetworkConditions({ offline: true, download: -1, upload: -1, latency: 0 });
    } else if (next.network === 'none') {
      await page.emulateNetworkConditions(null);
    } else {
      await page.emulateNetworkConditions(networkConditions(next.network));
    }
  }
  if (updates.disableCache !== undefined) await page.setCacheEnabled(!next.cacheDisabled);
  emulations.set(targetId, next);
  return next;
}

export function getEmulationSettings(targetId: string): EmulationSettings {
  return emulations.get(targetId) ?? { ...DEFAULT_EMULATION };
}

export async function performanceMetrics(
  page: Page,
  targetId: string,
): Promise<Record<string, unknown>> {
  const cdp = await page.createCDPSession();
  let cdpMetrics: Record<string, number> = {};
  try {
    await cdp.send('Performance.enable');
    const response = await cdp.send('Performance.getMetrics');
    const wanted = new Set([
      'JSHeapUsedSize',
      'JSHeapTotalSize',
      'Nodes',
      'JSEventListeners',
      'Documents',
      'LayoutCount',
      'RecalcStyleCount',
      'LayoutDuration',
      'RecalcStyleDuration',
      'ScriptDuration',
      'TaskDuration',
    ]);
    cdpMetrics = Object.fromEntries(
      response.metrics
        .filter(({ name }) => wanted.has(name))
        .map(({ name, value }) => [name, name.endsWith('Duration') ? round(value * 1_000) : value]),
    );
  } finally {
    await cdp.detach().catch(() => undefined);
  }

  const pageMetrics = await collectPageMetrics(page).catch(() => emptyPageMetrics());
  return {
    url: page.url(),
    emulation: getEmulationSettings(targetId),
    cdp: cdpMetrics,
    cdpDurationUnit: 'milliseconds',
    ...pageMetrics,
  };
}

export async function heapSnapshot(
  page: Page,
  collectGarbage = true,
): Promise<{
  heapPath: string;
  byteSize: number;
  jsHeapUsedBefore: number;
  jsHeapUsedAfterGc: number;
}> {
  const cdp = await page.createCDPSession();
  const heapPath = artifactPath('heap', 'heapsnapshot');
  await writeFile(heapPath, '');
  let tail = Promise.resolve();
  let writeError: unknown;
  const onChunk = ({ chunk }: Protocol.HeapProfiler.AddHeapSnapshotChunkEvent): void => {
    tail = tail
      .then(async () => await appendFile(heapPath, chunk))
      .catch((error: unknown) => {
        writeError ??= error;
      });
  };
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  try {
    await cdp.send('HeapProfiler.enable');
    const before = await cdp.send('Runtime.getHeapUsage');
    if (collectGarbage) await cdp.send('HeapProfiler.collectGarbage');
    const after = await cdp.send('Runtime.getHeapUsage');
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    await tail;
    if (writeError) throw writeError;
    return {
      heapPath,
      byteSize: (await stat(heapPath)).size,
      jsHeapUsedBefore: before.usedSize,
      jsHeapUsedAfterGc: after.usedSize,
    };
  } finally {
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
    await cdp.detach().catch(() => undefined);
  }
}

export async function finalizePerformance(targetId: string): Promise<void> {
  const errors: unknown[] = [];
  if (activeTrace?.targetId === targetId) {
    try {
      await stopTrace();
    } catch (error) {
      errors.push(error);
    }
  }
  if (cpuProfiles.has(targetId)) {
    try {
      await stopCpuProfile(targetId);
    } catch (error) {
      errors.push(error);
    }
  }
  if (coverages.has(targetId)) {
    try {
      await stopCoverage(targetId);
    } catch (error) {
      errors.push(error);
    }
  }
  emulations.delete(targetId);
  if (errors.length > 0) throw errors[0];
}

export async function finalizeAllPerformance(): Promise<void> {
  const targetIds = new Set([...cpuProfiles.keys(), ...coverages.keys()]);
  if (activeTrace) targetIds.add(activeTrace.targetId);
  const results = await Promise.allSettled([...targetIds].map(finalizePerformance));
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
  emulations.clear();
}

export function isTraceActiveForTarget(targetId: string): boolean {
  return activeTrace?.targetId === targetId && activeTrace.status !== 'stopped';
}

async function performStopTrace(runtime: TraceRuntime, top = 10): Promise<TraceStopResult> {
  runtime.status = 'stopping';
  if (runtime.timer) clearTimeout(runtime.timer);
  try {
    await runtime.page.tracing.stop();
    const trace = JSON.parse(await readFile(runtime.tracePath, 'utf8')) as TraceFile;
    return {
      tracePath: runtime.tracePath,
      summary: summarizeTrace(trace, top, runtime.frameId),
      capFired: runtime.capFired,
      openIn: 'Chrome DevTools → Performance → Load profile',
    };
  } finally {
    runtime.status = 'stopped';
  }
}

async function performStopCpu(runtime: CpuRuntime, top: number): Promise<CpuStopResult> {
  try {
    const { profile } = await runtime.cdp.send('Profiler.stop');
    await writeFile(runtime.profilePath, `${JSON.stringify(profile)}\n`);
    return {
      profilePath: runtime.profilePath,
      summary: summarizeCpuProfile(profile as CpuProfile, top),
    };
  } finally {
    await runtime.cdp.send('Profiler.disable').catch(() => undefined);
    await runtime.cdp.detach().catch(() => undefined);
  }
}

async function performStopCoverage(
  runtime: CoverageRuntime,
  top: number,
): Promise<CoverageStopResult> {
  const js = (await runtime.page.coverage.stopJSCoverage()) as CoverageEntry[];
  const css = runtime.includeCss
    ? ((await runtime.page.coverage.stopCSSCoverage()) as CoverageEntry[])
    : [];
  const raw = { js, css };
  await writeFile(runtime.coveragePath, `${JSON.stringify(raw)}\n`);
  return {
    coveragePath: runtime.coveragePath,
    summary: summarizeCoverage(js, css, top),
  };
}

async function mainFrameId(page: Page): Promise<string | undefined> {
  const cdp = await page.createCDPSession();
  try {
    const response = await cdp.send('Page.getFrameTree');
    return response.frameTree.frame.id;
  } catch {
    return undefined;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

function networkConditions(preset: Exclude<NetworkPreset, 'none' | 'offline'>) {
  const names = {
    slow3g: 'Slow 3G',
    fast3g: 'Fast 3G',
    slow4g: 'Slow 4G',
    fast4g: 'Fast 4G',
  } as const;
  return PredefinedNetworkConditions[names[preset]];
}

async function collectPageMetrics(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(async () => {
    type EntryRecord = PerformanceEntry & Record<string, unknown>;
    const supported = new Set(PerformanceObserver.supportedEntryTypes ?? []);
    const entries = async (type: string): Promise<EntryRecord[]> => {
      if (!supported.has(type)) return [];
      return await new Promise((resolve) => {
        const found: EntryRecord[] = [];
        const observer = new PerformanceObserver((list) => {
          found.push(...(list.getEntries() as EntryRecord[]));
        });
        try {
          observer.observe({ type, buffered: true });
          setTimeout(() => {
            observer.disconnect();
            resolve(found);
          }, 0);
        } catch {
          observer.disconnect();
          resolve([]);
        }
      });
    };
    const selector = (node: unknown): string | null => {
      if (!(node instanceof Element)) return null;
      if (node.id) return `#${CSS.escape(node.id)}`;
      const name = node.tagName.toLowerCase();
      const className = [...node.classList]
        .slice(0, 2)
        .map((value) => `.${CSS.escape(value)}`)
        .join('');
      return `${name}${className}`.slice(0, 160);
    };
    const navigation = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    const paints = Object.fromEntries(
      performance.getEntriesByType('paint').map((entry) => [entry.name, entry.startTime]),
    );
    const lcpEntries = await entries('largest-contentful-paint');
    const lcp = lcpEntries.at(-1);
    const shifts = (await entries('layout-shift')).filter(
      (entry) => !(entry as EntryRecord & { hadRecentInput?: boolean }).hadRecentInput,
    );
    const eventEntries = await entries('event');
    const inp = [...eventEntries].sort((left, right) => right.duration - left.duration)[0];
    const loaf = (await entries('long-animation-frame'))
      .sort((left, right) => right.duration - left.duration)
      .slice(0, 5);
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const resourceRow = (entry: PerformanceResourceTiming) => ({
      url: entry.name.slice(0, 200),
      durationMs: Math.round(entry.duration * 100) / 100,
      transferBytes: entry.transferSize,
      initiatorType: entry.initiatorType,
    });
    const shiftRows = shifts.flatMap((entry) => {
      const value = entry as EntryRecord & {
        value?: number;
        sources?: Array<{ node?: unknown }>;
      };
      return (value.sources ?? []).map((source) => ({
        selector: selector(source.node),
        score: value.value ?? 0,
      }));
    });
    const lcpValue = lcp as (EntryRecord & { element?: unknown; url?: string }) | undefined;
    const inpValue = inp as
      | (EntryRecord & { target?: unknown; interactionId?: number })
      | undefined;
    return {
      navigation: navigation
        ? {
            ttfbMs: navigation.responseStart,
            domContentLoadedMs: navigation.domContentLoadedEventEnd,
            loadMs: navigation.loadEventEnd,
            transferBytes: navigation.transferSize,
          }
        : null,
      paint: {
        fpMs: typeof paints['first-paint'] === 'number' ? paints['first-paint'] : null,
        fcpMs:
          typeof paints['first-contentful-paint'] === 'number'
            ? paints['first-contentful-paint']
            : null,
      },
      webVitals: {
        lcp: lcpValue
          ? {
              ms: lcpValue.startTime,
              selector: selector(lcpValue.element),
              url: typeof lcpValue.url === 'string' ? lcpValue.url.slice(0, 200) : null,
            }
          : null,
        cls: supported.has('layout-shift')
          ? {
              score: shifts.reduce(
                (sum, entry) =>
                  sum +
                  (typeof (entry as EntryRecord).value === 'number'
                    ? ((entry as EntryRecord).value as number)
                    : 0),
                0,
              ),
              topSources: shiftRows.sort((left, right) => right.score - left.score).slice(0, 5),
            }
          : null,
        inpApproximation: inpValue
          ? {
              durationMs: inpValue.duration,
              name: inpValue.name,
              target: selector(inpValue.target),
              interactionId: inpValue.interactionId ?? null,
            }
          : null,
        longAnimationFrames: supported.has('long-animation-frame')
          ? loaf.map((entry) => {
              const value = entry as EntryRecord & {
                blockingDuration?: number;
                scripts?: Array<Record<string, unknown>>;
              };
              return {
                startTimeMs: value.startTime,
                durationMs: value.duration,
                blockingDurationMs: value.blockingDuration ?? null,
                scripts: (value.scripts ?? []).slice(0, 5).map((script) => ({
                  sourceURL:
                    typeof script.sourceURL === 'string' ? script.sourceURL.slice(0, 200) : null,
                  invoker: typeof script.invoker === 'string' ? script.invoker.slice(0, 160) : null,
                  durationMs: script.duration ?? null,
                })),
              };
            })
          : null,
      },
      resources: {
        count: resources.length,
        totalTransferBytes: resources.reduce((sum, entry) => sum + entry.transferSize, 0),
        slowest: [...resources]
          .sort((left, right) => right.duration - left.duration)
          .slice(0, 10)
          .map(resourceRow),
        largest: [...resources]
          .sort((left, right) => right.transferSize - left.transferSize)
          .slice(0, 10)
          .map(resourceRow),
      },
    };
  });
}

function emptyPageMetrics(): Record<string, unknown> {
  return {
    navigation: null,
    paint: { fpMs: null, fcpMs: null },
    webVitals: { lcp: null, cls: null, inpApproximation: null, longAnimationFrames: null },
    resources: { count: 0, totalTransferBytes: 0, slowest: [], largest: [] },
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
