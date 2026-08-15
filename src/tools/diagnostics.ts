import { z } from 'zod';
import { session } from '../browser.ts';
import { jsonOk, type ToolDef, tool } from './registry.ts';

const consoleLogs = tool({
  name: 'browser_console_logs',
  description:
    'Return buffered console entries from the current tab (most recent 200). Optional filters: level, sinceMs (only entries newer than now-N), clear (drop the buffer after returning).',
  inputShape: {
    level: z.enum(['log', 'info', 'warn', 'warning', 'error', 'debug', 'pageerror']).optional(),
    sinceMs: z.number().int().positive().optional(),
    clear: z.boolean().optional(),
  },
  handler: async ({ level, sinceMs, clear }) => {
    // Make sure the session has a current page so the buffers are reachable;
    // we don't need to navigate.
    await session.getCurrentPage();
    const all = session.getConsoleBuffer();
    const cutoff = sinceMs ? Date.now() - sinceMs : 0;
    const wantWarning = level === 'warning' || level === 'warn';
    const filtered = all.filter((e) => {
      if (level) {
        if (wantWarning) {
          if (e.level !== 'warn' && e.level !== 'warning') return false;
        } else if (e.level !== level) {
          return false;
        }
      }
      if (cutoff && e.ts < cutoff) return false;
      return true;
    });
    if (clear) session.clearConsoleBuffer();
    return jsonOk({ count: filtered.length, entries: filtered });
  },
});

const networkLogs = tool({
  name: 'browser_network_logs',
  description:
    'Return buffered network events from the current tab (most recent 200). Optional filters: statusFilter (e.g. 404), urlIncludes, sinceMs, clear.',
  inputShape: {
    statusFilter: z.number().int().min(100).max(599).optional(),
    urlIncludes: z.string().optional(),
    sinceMs: z.number().int().positive().optional(),
    clear: z.boolean().optional(),
  },
  handler: async ({ statusFilter, urlIncludes, sinceMs, clear }) => {
    await session.getCurrentPage();
    const all = session.getNetworkBuffer();
    const cutoff = sinceMs ? Date.now() - sinceMs : 0;
    const filtered = all.filter((e) => {
      if (statusFilter !== undefined && e.status !== statusFilter) return false;
      if (urlIncludes && !e.url.includes(urlIncludes)) return false;
      if (cutoff && e.ts < cutoff) return false;
      return true;
    });
    if (clear) session.clearNetworkBuffer();
    return jsonOk({ count: filtered.length, entries: filtered });
  },
});

export const diagnosticsTools: ToolDef<any>[] = [consoleLogs, networkLogs];
