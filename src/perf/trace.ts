export interface TraceEvent {
  name?: string;
  cat?: string;
  ph?: string;
  pid?: number;
  tid?: number;
  ts?: number;
  dur?: number;
  args?: Record<string, unknown>;
}

export interface TraceFile {
  traceEvents?: TraceEvent[];
}

interface CompleteEvent extends TraceEvent {
  name: string;
  pid: number;
  tid: number;
  ts: number;
  dur: number;
  selfUs: number;
}

export interface TraceSummary {
  durationMs: number;
  mainThread: { pid: number; tid: number; name: string; selection: string } | null;
  mainThreadBreakdownMs: Record<TraceCategory, number>;
  longTasks: Array<{
    startOffsetMs: number;
    durationMs: number;
    contributors: Array<{ name: string; location?: string; selfMs: number }>;
  }>;
  topEventsBySelfTime: Array<{ name: string; selfMs: number }>;
  forcedLayouts: { count: number; totalMs: number };
  layouts: { count: number; totalMs: number };
  styleRecalcs: { count: number; totalMs: number };
  layoutShifts: { count: number; totalScore: number };
  userTimings: Array<{ name: string; startOffsetMs: number; durationMs: number }>;
}

type TraceCategory = 'scripting' | 'rendering' | 'painting' | 'loading' | 'gc' | 'other' | 'idle';

const CATEGORIES: TraceCategory[] = [
  'scripting',
  'rendering',
  'painting',
  'loading',
  'gc',
  'other',
  'idle',
];

export function summarizeTrace(trace: TraceFile, top = 10, frameId?: string): TraceSummary {
  const raw = trace.traceEvents ?? [];
  const complete = completeEvents(raw);
  const traceStart = complete.length > 0 ? Math.min(...complete.map(({ ts }) => ts)) : 0;
  const traceEnd = Math.max(...complete.map(({ ts, dur }) => ts + dur), traceStart);
  const main = findMainThread(raw, complete, frameId);
  const mainEvents = main
    ? complete.filter(({ pid, tid }) => pid === main.pid && tid === main.tid)
    : [];
  assignSelfTime(mainEvents);

  const breakdown = Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as Record<
    TraceCategory,
    number
  >;
  for (const event of mainEvents) breakdown[classify(event)] += event.selfUs / 1_000;

  const coveredUs = unionDuration(mainEvents.map(({ ts, dur }) => [ts, ts + dur]));
  const durationUs = Math.max(0, traceEnd - traceStart);
  breakdown.idle += Math.max(0, durationUs - coveredUs) / 1_000;

  const byName = new Map<string, number>();
  for (const event of mainEvents) {
    byName.set(event.name, (byName.get(event.name) ?? 0) + event.selfUs);
  }

  const longTasks = mainEvents
    .filter((event) => isTask(event.name) && event.dur > 50_000)
    .sort((left, right) => right.dur - left.dur)
    .slice(0, top)
    .map((task) => ({
      startOffsetMs: round((task.ts - traceStart) / 1_000),
      durationMs: round(task.dur / 1_000),
      contributors: mainEvents
        .filter(
          (event) =>
            event !== task &&
            event.selfUs > 0 &&
            event.ts >= task.ts &&
            event.ts + event.dur <= task.ts + task.dur,
        )
        .sort((left, right) => right.selfUs - left.selfUs)
        .slice(0, 3)
        .map((event) => ({
          name: eventDisplayName(event),
          ...(eventLocation(event) ? { location: eventLocation(event) } : {}),
          selfMs: round(event.selfUs / 1_000),
        })),
    }));

  const layouts = metric(mainEvents, (name) => name === 'Layout');
  const styleRecalcs = metric(mainEvents, (name) =>
    ['UpdateLayoutTree', 'RecalculateStyles', 'ScheduleStyleRecalculation'].includes(name),
  );
  const forcedLayouts = metric(
    mainEvents,
    (_name, event) =>
      Boolean(data(event).forcedLayout) ||
      Boolean(data(event).isForced) ||
      event.name === 'ForcedLayout',
  );
  const shifts = raw.filter(({ name }) => name === 'LayoutShift');

  return {
    durationMs: round(durationUs / 1_000),
    mainThread: main,
    mainThreadBreakdownMs: mapRounded(breakdown),
    longTasks,
    topEventsBySelfTime: [...byName.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, top)
      .map(([name, selfUs]) => ({ name, selfMs: round(selfUs / 1_000) })),
    forcedLayouts,
    layouts,
    styleRecalcs,
    layoutShifts: {
      count: shifts.length,
      totalScore: roundScore(
        shifts.reduce(
          (sum, event) => sum + numberValue(data(event).weighted_score_delta, data(event).score, 0),
          0,
        ),
      ),
    },
    userTimings: raw
      .filter(({ cat }) => cat?.split(',').includes('blink.user_timing'))
      .filter(
        (event): event is TraceEvent & { name: string; ts: number } =>
          typeof event.name === 'string' && typeof event.ts === 'number',
      )
      .slice(0, 100)
      .map((event) => ({
        name: event.name,
        startOffsetMs: round((event.ts - traceStart) / 1_000),
        durationMs: round((event.dur ?? 0) / 1_000),
      })),
  };
}

function completeEvents(events: TraceEvent[]): CompleteEvent[] {
  const result: CompleteEvent[] = [];
  const stacks = new Map<string, TraceEvent[]>();
  for (const event of events) {
    if (!validBase(event)) continue;
    if (event.ph === 'X' && typeof event.dur === 'number' && event.dur >= 0) {
      result.push({
        ...event,
        name: event.name,
        pid: event.pid,
        tid: event.tid,
        ts: event.ts,
        dur: event.dur,
        selfUs: 0,
      });
      continue;
    }
    const key = `${event.pid}:${event.tid}`;
    if (event.ph === 'B') {
      const stack = stacks.get(key) ?? [];
      stack.push(event);
      stacks.set(key, stack);
    } else if (event.ph === 'E') {
      const start = stacks.get(key)?.pop();
      if (start && event.ts >= (start.ts ?? event.ts) && validBase(start)) {
        result.push({
          ...start,
          name: start.name,
          pid: start.pid,
          tid: start.tid,
          ts: start.ts,
          dur: event.ts - start.ts,
          selfUs: 0,
        });
      }
    }
  }
  return result;
}

function validBase(event: TraceEvent): event is TraceEvent & {
  name: string;
  pid: number;
  tid: number;
  ts: number;
} {
  return (
    typeof event.name === 'string' &&
    typeof event.pid === 'number' &&
    typeof event.tid === 'number' &&
    typeof event.ts === 'number'
  );
}

function findMainThread(
  raw: TraceEvent[],
  complete: CompleteEvent[],
  frameId?: string,
): TraceSummary['mainThread'] {
  const names = raw
    .filter(
      (event) =>
        event.name === 'thread_name' &&
        typeof event.pid === 'number' &&
        typeof event.tid === 'number',
    )
    .map((event) => ({
      pid: event.pid as number,
      tid: event.tid as number,
      name: String(event.args?.name ?? ''),
    }))
    .filter(({ name }) => name === 'CrRendererMain');
  if (names.length === 0) return null;

  const framePid = findFramePid(raw, frameId);
  if (framePid !== undefined) {
    const match = names.find(({ pid }) => pid === framePid);
    if (match) return { ...match, selection: 'TracingStartedInBrowser frame process' };
  }

  const busiest = names
    .map((thread) => ({
      ...thread,
      busy: complete
        .filter(({ pid, tid }) => pid === thread.pid && tid === thread.tid)
        .reduce((sum, { dur }) => sum + dur, 0),
    }))
    .sort((left, right) => right.busy - left.busy)[0];
  return {
    pid: busiest.pid,
    tid: busiest.tid,
    name: busiest.name,
    selection: 'busiest CrRendererMain fallback',
  };
}

function findFramePid(events: TraceEvent[], frameId?: string): number | undefined {
  if (!frameId) return undefined;
  for (const event of events) {
    if (event.name !== 'TracingStartedInBrowser') continue;
    const frames = data(event).frames;
    if (!Array.isArray(frames)) continue;
    const frame = frames.find((candidate) => {
      if (!candidate || typeof candidate !== 'object') return false;
      const record = candidate as Record<string, unknown>;
      return record.frame === frameId || record.frameId === frameId;
    }) as Record<string, unknown> | undefined;
    const pid = frame?.processId ?? frame?.process_id ?? frame?.pid;
    if (typeof pid === 'number') return pid;
  }
  return undefined;
}

function assignSelfTime(events: CompleteEvent[]): void {
  const sorted = [...events].sort((left, right) => left.ts - right.ts || right.dur - left.dur);
  const stack: Array<{ event: CompleteEvent; children: Array<[number, number]> }> = [];
  for (const event of sorted) {
    while (stack.length > 0 && event.ts >= end(stack.at(-1)?.event as CompleteEvent)) {
      finish(stack.pop() as { event: CompleteEvent; children: Array<[number, number]> });
    }
    while (stack.length > 0 && end(event) > end(stack.at(-1)?.event as CompleteEvent)) {
      finish(stack.pop() as { event: CompleteEvent; children: Array<[number, number]> });
    }
    const parent = stack.at(-1);
    if (parent && end(event) <= end(parent.event)) parent.children.push([event.ts, end(event)]);
    stack.push({ event, children: [] });
  }
  while (stack.length > 0)
    finish(stack.pop() as { event: CompleteEvent; children: Array<[number, number]> });
}

function finish(entry: { event: CompleteEvent; children: Array<[number, number]> }): void {
  entry.event.selfUs = Math.max(0, entry.event.dur - unionDuration(entry.children));
}

function end(event: CompleteEvent): number {
  return event.ts + event.dur;
}

function unionDuration(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((left, right) => left[0] - right[0]);
  let total = 0;
  let [start, finish] = sorted[0];
  for (const [nextStart, nextFinish] of sorted.slice(1)) {
    if (nextStart <= finish) finish = Math.max(finish, nextFinish);
    else {
      total += finish - start;
      [start, finish] = [nextStart, nextFinish];
    }
  }
  return total + finish - start;
}

function classify(event: CompleteEvent): TraceCategory {
  const name = event.name.toLowerCase();
  if (/idle/.test(name)) return 'idle';
  if (/garbage|\bgc\b|minor|majorgc/.test(name)) return 'gc';
  if (/layout|style|render|updatelayouttree/.test(name)) return 'rendering';
  if (/paint|composit|raster/.test(name)) return 'painting';
  if (/load|parse|resource|html|xml|network/.test(name)) return 'loading';
  if (/script|function|timer|eventdispatch|v8|microtask|callback/.test(name)) return 'scripting';
  return 'other';
}

function isTask(name: string): boolean {
  return name === 'RunTask' || name === 'ThreadControllerImpl::RunTask';
}

function data(event: TraceEvent): Record<string, unknown> {
  const value = event.args?.data ?? event.args;
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function eventDisplayName(event: CompleteEvent): string {
  const functionName = data(event).functionName;
  return typeof functionName === 'string' && functionName
    ? `${event.name}: ${functionName}`
    : event.name;
}

function eventLocation(event: CompleteEvent): string | undefined {
  const value = data(event);
  const url = value.url ?? value.scriptName;
  if (typeof url !== 'string' || !url) return undefined;
  const line = typeof value.lineNumber === 'number' ? value.lineNumber + 1 : undefined;
  return `${truncate(url, 200)}${line === undefined ? '' : `:${line}`}`;
}

function metric(
  events: CompleteEvent[],
  predicate: (name: string, event: CompleteEvent) => boolean,
): { count: number; totalMs: number } {
  const selected = events.filter((event) => predicate(event.name, event));
  return {
    count: selected.length,
    totalMs: round(selected.reduce((sum, { dur }) => sum + dur, 0) / 1_000),
  };
}

function numberValue(...values: unknown[]): number {
  return values.find((value): value is number => typeof value === 'number') ?? 0;
}

function mapRounded<T extends string>(record: Record<T, number>): Record<T, number> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, round(value as number)]),
  ) as Record<T, number>;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundScore(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
