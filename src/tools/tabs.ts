import { z } from 'zod';
import { session } from '../browser.ts';
import { jsonOk, type ToolDef, tool } from './registry.ts';

const listTabs = tool({
  name: 'browser_list_tabs',
  description:
    'List all open tabs as { id, url, title, isCurrent }. Use the id with browser_switch_tab / browser_close_tab.',
  inputShape: {},
  handler: async () => {
    // Ensure browser is up so the registry has at least the current page.
    await session.getCurrentPage();
    return jsonOk({ tabs: session.listTabs() });
  },
});

const newTab = tool({
  name: 'browser_new_tab',
  description: 'Open a new tab and switch to it. If url is given, navigates the new tab there.',
  inputShape: {
    url: z.string().url().optional(),
  },
  handler: async ({ url }) => {
    const tab = await session.newTab(url);
    return jsonOk(tab);
  },
});

const switchTab = tool({
  name: 'browser_switch_tab',
  description: 'Make the tab with the given id the current tab.',
  inputShape: {
    id: z.number().int().positive(),
  },
  handler: async ({ id }) => {
    const tab = await session.switchTab(id);
    return jsonOk(tab);
  },
});

const closeTab = tool({
  name: 'browser_close_tab',
  description:
    'Close the tab with the given id (default: current). If the last tab is closed, the browser shuts down.',
  inputShape: {
    id: z.number().int().positive().optional(),
  },
  handler: async ({ id }) => {
    const result = await session.closeTab(id);
    return jsonOk(result);
  },
});

export const tabsTools: ToolDef<any>[] = [listTabs, newTab, switchTab, closeTab];
