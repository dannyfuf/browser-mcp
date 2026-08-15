import { z } from 'zod';
import { session } from '../browser.ts';
import { jsonOk, type ToolDef, textOk, tool } from './registry.ts';

const waitForSelector = tool({
  name: 'browser_wait_for_selector',
  description:
    'Wait until a selector reaches the requested state. state ∈ {attached, detached, visible, hidden} (default attached).',
  inputShape: {
    selector: z.string().min(1),
    state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  },
  handler: async ({ selector, state, timeoutMs }) => {
    const page = await session.getCurrentPage();
    const s = state ?? 'attached';
    await page.waitForSelector(selector, {
      timeout: timeoutMs ?? 5_000,
      hidden: s === 'detached' || s === 'hidden',
      visible: s === 'visible',
    });
    return textOk(`selector ${selector} reached state ${s}`);
  },
});

const setViewport = tool({
  name: 'browser_set_viewport',
  description:
    "Set the current tab's viewport. Common widths: 375 (mobile), 768 (tablet), 1280 (desktop). Set isMobile=true to mimic a phone.",
  inputShape: {
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
    deviceScaleFactor: z.number().positive().max(4).optional(),
    isMobile: z.boolean().optional(),
  },
  handler: async ({ width, height, deviceScaleFactor, isMobile }) => {
    const page = await session.getCurrentPage();
    await page.setViewport({
      width,
      height,
      deviceScaleFactor: deviceScaleFactor ?? 1,
      isMobile: isMobile ?? false,
    });
    return jsonOk({
      width,
      height,
      deviceScaleFactor: deviceScaleFactor ?? 1,
      isMobile: isMobile ?? false,
    });
  },
});

const close = tool({
  name: 'browser_close',
  description:
    'Close the current tab. If it was the last tab, also shuts down the browser. Returns whether the browser was fully closed.',
  inputShape: {},
  handler: async () => {
    const result = await session.closeTab();
    return jsonOk(result);
  },
});

export const stateTools: ToolDef<any>[] = [waitForSelector, setViewport, close];
