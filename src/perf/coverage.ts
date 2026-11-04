export interface CoverageEntry {
  url: string;
  text: string;
  ranges: Array<{ start: number; end: number }>;
}

export interface CoverageFileSummary {
  url: string;
  kind: 'js' | 'css';
  totalBytes: number;
  usedBytes: number;
  unusedBytes: number;
  unusedPercent: number;
}

export interface CoverageSummary {
  totals: { totalBytes: number; usedBytes: number; unusedBytes: number; unusedPercent: number };
  files: CoverageFileSummary[];
}

export function summarizeCoverage(
  js: CoverageEntry[],
  css: CoverageEntry[],
  top = 10,
): CoverageSummary {
  const files = [
    ...js.map((entry) => summarizeEntry(entry, 'js')),
    ...css.map((entry) => summarizeEntry(entry, 'css')),
  ].sort((left, right) => right.unusedBytes - left.unusedBytes);
  const totalBytes = files.reduce((sum, file) => sum + file.totalBytes, 0);
  const usedBytes = files.reduce((sum, file) => sum + file.usedBytes, 0);
  const unusedBytes = Math.max(0, totalBytes - usedBytes);
  return {
    totals: {
      totalBytes,
      usedBytes,
      unusedBytes,
      unusedPercent: percentage(unusedBytes, totalBytes),
    },
    files: files.slice(0, top),
  };
}

function summarizeEntry(entry: CoverageEntry, kind: 'js' | 'css'): CoverageFileSummary {
  const totalBytes = new TextEncoder().encode(entry.text).byteLength;
  const usedBytes = Math.min(totalBytes, unionLength(entry.ranges, entry.text));
  const unusedBytes = Math.max(0, totalBytes - usedBytes);
  return {
    url: truncate(entry.url || '(inline)', 200),
    kind,
    totalBytes,
    usedBytes,
    unusedBytes,
    unusedPercent: percentage(unusedBytes, totalBytes),
  };
}

function unionLength(ranges: CoverageEntry['ranges'], text: string): number {
  if (ranges.length === 0) return 0;
  const sorted = ranges
    .map(({ start, end }) => ({ start: Math.max(0, start), end: Math.min(text.length, end) }))
    .filter(({ start, end }) => end > start)
    .sort((left, right) => left.start - right.start);
  if (sorted.length === 0) return 0;
  let total = 0;
  let { start, end } = sorted[0];
  for (const range of sorted.slice(1)) {
    if (range.start <= end) end = Math.max(end, range.end);
    else {
      total += new TextEncoder().encode(text.slice(start, end)).byteLength;
      ({ start, end } = range);
    }
  }
  return total + new TextEncoder().encode(text.slice(start, end)).byteLength;
}

function percentage(value: number, total: number): number {
  return total === 0 ? 0 : Math.round((value / total) * 10_000) / 100;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
