import { readFile, rm, stat } from 'node:fs/promises';
import { expect } from '@std/expect';
import { afterAll, beforeAll, test } from '@std/testing/bdd';
import { session } from '../src/browser.ts';
import { isTraceActiveForTarget } from '../src/performance.ts';
import { type ToolDef, type ToolResult, tools } from '../src/tools/registry.ts';
import { type FixtureServer, startFixtureServer } from './fixtures/server.ts';

process.env.BROWSER_HEADLESS = '1';

let fixture: FixtureServer;
let artifactDir: string;
const originalArtifactDir = process.env.BROWSER_ARTIFACT_DIR;

beforeAll(async () => {
  artifactDir = await Deno.makeTempDir({ prefix: 'browser-mcp-performance-' });
  process.env.BROWSER_ARTIFACT_DIR = artifactDir;
  fixture = startFixtureServer();
});

afterAll(async () => {
  await session.close();
  await fixture.stop();
  restoreEnvironment('BROWSER_ARTIFACT_DIR', originalArtifactDir);
  await rm(artifactDir, { force: true, recursive: true });
});

test('trace reports the deliberately slow click as a long task', async () => {
  await call('browser_navigate', { url: fixture.url });
  await call('browser_start_trace', { max_duration_s: 10 });
  await expect(call('browser_start_trace', { max_duration_s: 10 })).rejects.toThrow(
    'trace is already active',
  );
  await call('browser_click', { selector: '#slow' });
  const result = asJson<{
    tracePath: string;
    summary: { durationMs: number; longTasks: Array<{ durationMs: number }> };
  }>(await call('browser_stop_trace', { top: 5 }));

  expect((await stat(result.tracePath)).size).toBeGreaterThan(0);
  expect(result.summary.durationMs).toBeGreaterThan(0);
  expect(result.summary.longTasks.some(({ durationMs }) => durationMs > 50)).toBe(true);
  await expect(call('browser_stop_trace')).rejects.toThrow('no browser trace is active');
});

test('CPU profile, metrics, emulation, coverage, and heap snapshot work end-to-end', async () => {
  await call('browser_start_cpu_profile', { sampling_interval_us: 1_000 });
  await expect(call('browser_start_cpu_profile')).rejects.toThrow('active CPU profile');
  await call('browser_click', { selector: '#slow' });
  const cpu = asJson<{ profilePath: string; summary: { totalMs: number } }>(
    await call('browser_stop_cpu_profile', { top: 5 }),
  );
  expect((await stat(cpu.profilePath)).size).toBeGreaterThan(0);
  expect(cpu.summary.totalMs).toBeGreaterThan(0);
  await expect(call('browser_stop_cpu_profile')).rejects.toThrow('no active CPU profile');

  const throttled = asJson<{ cpuThrottlingRate: number; network: string; cacheDisabled: boolean }>(
    await call('browser_emulate', {
      cpu_throttling_rate: 2,
      network: 'fast4g',
      disable_cache: true,
    }),
  );
  expect(throttled).toEqual({ cpuThrottlingRate: 2, network: 'fast4g', cacheDisabled: true });
  const metrics = asJson<{
    cdp: { JSHeapUsedSize: number };
    emulation: { cpuThrottlingRate: number };
    resources: { count: number };
  }>(await call('browser_performance_metrics'));
  expect(metrics.cdp.JSHeapUsedSize).toBeGreaterThan(0);
  expect(metrics.emulation.cpuThrottlingRate).toBe(2);
  expect(metrics.resources.count).toBeGreaterThanOrEqual(0);
  await call('browser_emulate', { cpu_throttling_rate: 1, network: 'none', disable_cache: false });

  await call('browser_start_coverage', { include_css: true });
  await expect(call('browser_start_coverage')).rejects.toThrow('active coverage');
  await call('browser_click', { selector: '#slow' });
  const coverage = asJson<{
    coveragePath: string;
    summary: { totals: { totalBytes: number } };
  }>(await call('browser_stop_coverage', { top: 5 }));
  expect((await stat(coverage.coveragePath)).size).toBeGreaterThan(0);
  expect(coverage.summary.totals.totalBytes).toBeGreaterThan(0);
  await expect(call('browser_stop_coverage')).rejects.toThrow('no active coverage');

  const heap = asJson<{
    heapPath: string;
    byteSize: number;
    jsHeapUsedBefore: number;
    jsHeapUsedAfterGc: number;
  }>(await call('browser_heap_snapshot'));
  expect(heap.byteSize).toBeGreaterThan(0);
  expect((await stat(heap.heapPath)).size).toBe(heap.byteSize);
  expect(heap.jsHeapUsedBefore).toBeGreaterThan(0);
  expect(heap.jsHeapUsedAfterGc).toBeGreaterThan(0);
});

test('closing a tab finalizes its active trace file', async () => {
  const tab = asJson<{ id: number }>(await call('browser_new_tab', { url: fixture.url }));
  const page = await session.getCurrentPage();
  const targetId = pageTargetId(page);
  const start = asJson<{ tracePath: string }>(
    await call('browser_start_trace', { max_duration_s: 10 }),
  );
  await call('browser_click', { selector: '#slow' });

  await call('browser_close_tab', { id: tab.id });

  expect(isTraceActiveForTarget(targetId)).toBe(false);
  expect((await stat(start.tracePath)).size).toBeGreaterThan(0);
  const raw = JSON.parse(await readFile(start.tracePath, 'utf8')) as { traceEvents?: unknown[] };
  expect(raw.traceEvents?.length).toBeGreaterThan(0);
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const definition = tools.find((candidate) => candidate.name === name) as ToolDef<any> | undefined;
  if (!definition) throw new Error(`tool ${name} not registered`);
  return await definition.handler(args);
}

function asJson<T>(result: ToolResult): T {
  const text = result.content.find((content) => content.type === 'text');
  if (text?.type !== 'text') throw new Error('tool returned no text JSON');
  return JSON.parse(text.text) as T;
}

function pageTargetId(page: Awaited<ReturnType<typeof session.getCurrentPage>>): string {
  return (page.target() as unknown as { _targetId: string })._targetId;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
