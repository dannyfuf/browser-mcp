import { expect } from '@std/expect';
import { test } from '@std/testing/bdd';
import { summarizeTrace, type TraceFile } from '../src/perf/trace.ts';

test('summarizes nested trace self-time, long tasks, layouts, shifts, and user timing', () => {
  const trace: TraceFile = {
    traceEvents: [
      { name: 'thread_name', ph: 'M', pid: 7, tid: 11, ts: 0, args: { name: 'CrRendererMain' } },
      {
        name: 'TracingStartedInBrowser',
        ph: 'I',
        pid: 1,
        tid: 1,
        ts: 90_000,
        args: { data: { frames: [{ frame: 'frame-1', processId: 7 }] } },
      },
      {
        name: 'RunTask',
        cat: 'devtools.timeline',
        ph: 'X',
        pid: 7,
        tid: 11,
        ts: 100_000,
        dur: 100_000,
      },
      {
        name: 'FunctionCall',
        cat: 'devtools.timeline',
        ph: 'X',
        pid: 7,
        tid: 11,
        ts: 105_000,
        dur: 50_000,
        args: {
          data: { functionName: 'slowClick', url: 'https://example.test/app.js', lineNumber: 9 },
        },
      },
      { name: 'EvaluateScript', cat: 'devtools.timeline', ph: 'B', pid: 7, tid: 11, ts: 155_000 },
      { name: 'EvaluateScript', cat: 'devtools.timeline', ph: 'E', pid: 7, tid: 11, ts: 175_000 },
      {
        name: 'Layout',
        cat: 'devtools.timeline',
        ph: 'X',
        pid: 7,
        tid: 11,
        ts: 175_000,
        dur: 20_000,
        args: { data: { isForced: true } },
      },
      {
        name: 'Paint',
        cat: 'devtools.timeline',
        ph: 'X',
        pid: 7,
        tid: 11,
        ts: 180_000,
        dur: 10_000,
      },
      {
        name: 'LayoutShift',
        cat: 'loading',
        ph: 'I',
        pid: 7,
        tid: 11,
        ts: 190_000,
        args: { data: { weighted_score_delta: 0.125 } },
      },
      { name: 'checkout-ready', cat: 'blink.user_timing', ph: 'R', pid: 7, tid: 11, ts: 195_000 },
    ],
  };

  const summary = summarizeTrace(trace, 10, 'frame-1');
  expect(summary.durationMs).toBe(100);
  expect(summary.mainThread).toMatchObject({ pid: 7, tid: 11 });
  expect(summary.longTasks).toHaveLength(1);
  expect(summary.longTasks[0].durationMs).toBe(100);
  expect(summary.longTasks[0].contributors[0]).toMatchObject({
    name: 'FunctionCall: slowClick',
    location: 'https://example.test/app.js:10',
    selfMs: 50,
  });
  expect(summary.mainThreadBreakdownMs.scripting).toBe(70);
  expect(summary.mainThreadBreakdownMs.rendering).toBe(10);
  expect(summary.mainThreadBreakdownMs.painting).toBe(10);
  expect(summary.mainThreadBreakdownMs.other).toBe(10);
  expect(summary.forcedLayouts).toEqual({ count: 1, totalMs: 20 });
  expect(summary.layoutShifts).toEqual({ count: 1, totalScore: 0.125 });
  expect(summary.userTimings[0]).toMatchObject({ name: 'checkout-ready', durationMs: 0 });
});

test('falls back to the busiest renderer main thread', () => {
  const summary = summarizeTrace({
    traceEvents: [
      { name: 'thread_name', ph: 'M', pid: 1, tid: 1, ts: 0, args: { name: 'CrRendererMain' } },
      { name: 'thread_name', ph: 'M', pid: 2, tid: 2, ts: 0, args: { name: 'CrRendererMain' } },
      { name: 'RunTask', ph: 'X', pid: 1, tid: 1, ts: 0, dur: 10_000 },
      { name: 'RunTask', ph: 'X', pid: 2, tid: 2, ts: 0, dur: 20_000 },
    ],
  });
  expect(summary.mainThread).toMatchObject({
    pid: 2,
    tid: 2,
    selection: 'busiest CrRendererMain fallback',
  });
});
