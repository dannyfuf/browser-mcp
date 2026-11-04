import { expect } from '@std/expect';
import { test } from '@std/testing/bdd';
import { summarizeCoverage } from '../src/perf/coverage.ts';

test('merges overlapping coverage ranges and sorts files by unused bytes', () => {
  const summary = summarizeCoverage(
    [
      {
        url: 'app.js',
        text: '0123456789',
        ranges: [
          { start: 0, end: 4 },
          { start: 2, end: 6 },
        ],
      },
      { url: 'unused.js', text: 'abcdefgh', ranges: [] },
    ],
    [{ url: 'style.css', text: 'abcdef', ranges: [{ start: 0, end: 3 }] }],
    3,
  );

  expect(summary.totals).toEqual({
    totalBytes: 24,
    usedBytes: 9,
    unusedBytes: 15,
    unusedPercent: 62.5,
  });
  expect(summary.files[0]).toMatchObject({ url: 'unused.js', unusedBytes: 8, unusedPercent: 100 });
  expect(summary.files.find(({ url }) => url === 'app.js')).toMatchObject({
    usedBytes: 6,
    unusedBytes: 4,
  });
});
