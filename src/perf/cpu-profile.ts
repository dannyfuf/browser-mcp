export interface CpuProfileNode {
  id: number;
  callFrame: {
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  children?: number[];
}

export interface CpuProfile {
  nodes: CpuProfileNode[];
  samples?: number[];
  timeDeltas?: number[];
  startTime: number;
  endTime: number;
}

interface FunctionTime {
  functionName: string;
  location: string;
  selfMs: number;
  totalMs: number;
  selfPercent: number;
  totalPercent: number;
}

export interface CpuProfileSummary {
  totalMs: number;
  topFunctionsBySelfTime: FunctionTime[];
  topFunctionsByTotalTime: FunctionTime[];
  selfTimeByUrl: Array<{ url: string; selfMs: number; percent: number }>;
  specialTotalsMs: { idle: number; program: number; garbageCollector: number };
}

export function summarizeCpuProfile(profile: CpuProfile, top = 10): CpuProfileSummary {
  const parents = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parents.set(child, node.id);
  }
  const selfUs = new Map<number, number>();
  const totalUs = new Map<number, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let index = 0; index < samples.length; index++) {
    const id = samples[index];
    const delta = deltas[index] ?? 0;
    selfUs.set(id, (selfUs.get(id) ?? 0) + delta);
    let cursor: number | undefined = id;
    const seen = new Set<number>();
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor);
      totalUs.set(cursor, (totalUs.get(cursor) ?? 0) + delta);
      cursor = parents.get(cursor);
    }
  }

  const sampledUs = deltas.reduce((sum, delta) => sum + delta, 0);
  const totalProfileUs = sampledUs || Math.max(0, profile.endTime - profile.startTime);
  const rows = profile.nodes.map((node) => {
    const self = selfUs.get(node.id) ?? 0;
    const total = totalUs.get(node.id) ?? self;
    return {
      functionName: node.callFrame.functionName || '(anonymous)',
      location: location(node),
      selfMs: round(self / 1_000),
      totalMs: round(total / 1_000),
      selfPercent: percent(self, totalProfileUs),
      totalPercent: percent(total, totalProfileUs),
    };
  });
  const special = { idle: 0, program: 0, garbageCollector: 0 };
  for (const node of profile.nodes) {
    const value = (selfUs.get(node.id) ?? 0) / 1_000;
    if (node.callFrame.functionName === '(idle)') special.idle += value;
    if (node.callFrame.functionName === '(program)') special.program += value;
    if (node.callFrame.functionName === '(garbage collector)') special.garbageCollector += value;
  }
  const excluded = new Set(['(root)', '(idle)', '(program)', '(garbage collector)']);
  const functions = rows.filter(({ functionName }) => !excluded.has(functionName));
  const byUrl = new Map<string, number>();
  for (const node of profile.nodes) {
    if (excluded.has(node.callFrame.functionName)) continue;
    const value = selfUs.get(node.id) ?? 0;
    const url = truncate(node.callFrame.url || '(native/unknown)', 200);
    byUrl.set(url, (byUrl.get(url) ?? 0) + value);
  }

  return {
    totalMs: round(totalProfileUs / 1_000),
    topFunctionsBySelfTime: [...functions].sort((a, b) => b.selfMs - a.selfMs).slice(0, top),
    topFunctionsByTotalTime: [...functions].sort((a, b) => b.totalMs - a.totalMs).slice(0, top),
    selfTimeByUrl: [...byUrl.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([url, value]) => ({
        url,
        selfMs: round(value / 1_000),
        percent: percent(value, totalProfileUs),
      })),
    specialTotalsMs: {
      idle: round(special.idle),
      program: round(special.program),
      garbageCollector: round(special.garbageCollector),
    },
  };
}

function location(node: CpuProfileNode): string {
  const { url, lineNumber, columnNumber } = node.callFrame;
  return `${truncate(url || '(native/unknown)', 200)}:${lineNumber + 1}:${columnNumber + 1}`;
}

function percent(value: number, total: number): number {
  return total === 0 ? 0 : round((value / total) * 100);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
