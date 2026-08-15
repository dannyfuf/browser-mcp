import { z } from 'zod';
import { session } from '../browser.ts';
import { jsonOk, type ToolDef, tool } from './registry.ts';

const waitUntilSchema = z
  .enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2'])
  .describe('When the navigation is considered complete. Default "load".');

const navigate = tool({
  name: 'browser_navigate',
  description:
    'Navigate the current tab to `url`. Returns the final URL and HTTP status. Use waitUntil to choose when to consider the navigation complete (default "load").',
  inputShape: {
    url: z.string().url().describe('Absolute URL to navigate to.'),
    waitUntil: waitUntilSchema.optional(),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(120_000)
      .optional()
      .describe('Navigation timeout in ms (default 30000).'),
  },
  handler: async ({ url, waitUntil, timeoutMs }) => {
    const page = await session.getCurrentPage();
    const response = await page.goto(url, {
      waitUntil: waitUntil ?? 'load',
      timeout: timeoutMs ?? 30_000,
    });
    return jsonOk({
      url: page.url(),
      status: response?.status() ?? null,
      ok: response?.ok() ?? null,
    });
  },
});

const back = tool({
  name: 'browser_back',
  description:
    "Navigate back in the current tab's history. No-op if there is nothing to go back to.",
  inputShape: {},
  handler: async () => {
    const page = await session.getCurrentPage();
    const response = await page.goBack({ waitUntil: 'load' });
    if (!response) return jsonOk({ noop: true, url: page.url() });
    return jsonOk({ url: page.url(), status: response.status() });
  },
});

const forward = tool({
  name: 'browser_forward',
  description:
    "Navigate forward in the current tab's history. No-op if there is nothing to go forward to.",
  inputShape: {},
  handler: async () => {
    const page = await session.getCurrentPage();
    const response = await page.goForward({ waitUntil: 'load' });
    if (!response) return jsonOk({ noop: true, url: page.url() });
    return jsonOk({ url: page.url(), status: response.status() });
  },
});

const reload = tool({
  name: 'browser_reload',
  description: 'Reload the current tab.',
  inputShape: {
    waitUntil: waitUntilSchema.optional(),
  },
  handler: async ({ waitUntil }) => {
    const page = await session.getCurrentPage();
    const response = await page.reload({ waitUntil: waitUntil ?? 'load' });
    return jsonOk({ url: page.url(), status: response?.status() ?? null });
  },
});

export const navigationTools: ToolDef<any>[] = [navigate, back, forward, reload];
