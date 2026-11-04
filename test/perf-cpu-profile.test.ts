import { expect } from '@std/expect';
import { test } from '@std/testing/bdd';
import { summarizeCpuProfile } from '../src/perf/cpu-profile.ts';

test('summarizes CPU self/total time and separates idle/program/gc', () => {
  const summary = summarizeCpuProfile(
    {
      startTime: 0,
      endTime: 100_000,
      nodes: [
        { id: 1, callFrame: frame('(root)', ''), children: [2, 4, 5, 6] },
        { id: 2, callFrame: frame('work', 'https://example.test/app.js'), children: [3] },
        { id: 3, callFrame: frame('child', 'https://example.test/chunk.js') },
        { id: 4, callFrame: frame('(idle)', '') },
        { id: 5, callFrame: frame('(program)', '') },
        { id: 6, callFrame: frame('(garbage collector)', '') },
      ],
      samples: [2, 3, 4, 5, 6],
      timeDeltas: [30_000, 20_000, 25_000, 15_000, 10_000],
    },
    5,
  );

  expect(summary.totalMs).toBe(100);
  expect(summary.topFunctionsBySelfTime[0]).toMatchObject({
    functionName: 'work',
    selfMs: 30,
    totalMs: 50,
  });
  expect(summary.selfTimeByUrl[0]).toMatchObject({
    url: 'https://example.test/app.js',
    selfMs: 30,
  });
  expect(summary.specialTotalsMs).toEqual({ idle: 25, program: 15, garbageCollector: 10 });
  expect(summary.topFunctionsBySelfTime.map(({ functionName }) => functionName)).not.toContain(
    '(idle)',
  );
});

function frame(functionName: string, url: string) {
  return { functionName, url, lineNumber: 0, columnNumber: 0 };
}
