import { expect } from '@std/expect';
import { test } from '@std/testing/bdd';
import { z } from 'zod';
import { type ToolDef, tools } from '../src/tools/registry.ts';

const names = [
  'browser_start_trace',
  'browser_stop_trace',
  'browser_start_cpu_profile',
  'browser_stop_cpu_profile',
  'browser_performance_metrics',
  'browser_emulate',
  'browser_heap_snapshot',
  'browser_start_coverage',
  'browser_stop_coverage',
];

test('registers all performance tools', () => {
  for (const name of names) expect(getTool(name).name).toBe(name);
});

test('trace schemas accept documented inputs and enforce caps', () => {
  const start = schema('browser_start_trace');
  expect(
    start.safeParse({
      tab: 1,
      screenshots: true,
      categories: ['devtools.timeline'],
      max_duration_s: 300,
    }).success,
  ).toBe(true);
  expect(start.safeParse({}).success).toBe(true);
  expect(start.safeParse({ max_duration_s: 301 }).success).toBe(false);
  expect(start.safeParse({ categories: [] }).success).toBe(false);

  const stop = schema('browser_stop_trace');
  expect(stop.safeParse({ top: 50 }).success).toBe(true);
  expect(stop.safeParse({ top: 0 }).success).toBe(false);
});

test('CPU, metrics, heap, and coverage schemas match their public inputs', () => {
  expect(
    schema('browser_start_cpu_profile').safeParse({ tab: 1, sampling_interval_us: 1 }).success,
  ).toBe(true);
  expect(schema('browser_start_cpu_profile').safeParse({ sampling_interval_us: 0 }).success).toBe(
    false,
  );
  expect(schema('browser_stop_cpu_profile').safeParse({ top: 10 }).success).toBe(true);
  expect(schema('browser_performance_metrics').safeParse({ tab: 2 }).success).toBe(true);
  expect(
    schema('browser_heap_snapshot').safeParse({ tab: 2, collect_garbage: false }).success,
  ).toBe(true);
  expect(schema('browser_start_coverage').safeParse({ tab: 2, include_css: false }).success).toBe(
    true,
  );
  expect(schema('browser_stop_coverage').safeParse({ top: 10 }).success).toBe(true);
});

test('emulation schema accepts reset values and rejects invalid throttling', () => {
  const emulate = schema('browser_emulate');
  expect(
    emulate.safeParse({ cpu_throttling_rate: 1, network: 'none', disable_cache: false }).success,
  ).toBe(true);
  expect(emulate.safeParse({ cpu_throttling_rate: 20, network: 'slow3g' }).success).toBe(true);
  expect(emulate.safeParse({ cpu_throttling_rate: 21 }).success).toBe(false);
  expect(emulate.safeParse({ network: 'dialup' }).success).toBe(false);
});

test('tab-selecting start tools reject an unknown tab before starting capture', async () => {
  for (const name of [
    'browser_start_trace',
    'browser_start_cpu_profile',
    'browser_start_coverage',
  ]) {
    await expect(getTool(name).handler({ tab: 999_999 })).rejects.toThrow('tab 999999 not found');
  }
});

function getTool(name: string): ToolDef<any> {
  const definition = tools.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`tool ${name} not registered`);
  return definition;
}

function schema(name: string) {
  return z.object(getTool(name).inputShape).strict();
}
