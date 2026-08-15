import { z } from 'zod';
import { session } from '../browser.ts';
import { jsonOk, type ToolDef, textOk, tool } from './registry.ts';

const DEFAULT_TIMEOUT = 5_000;

const click = tool({
  name: 'browser_click',
  description:
    'Click an element by CSS selector, or click viewport coordinates with x/y. Selector clicks wait for the selector to attach (default 5s).',
  inputShape: {
    selector: z.string().min(1).optional(),
    x: z.number().finite().min(0).optional(),
    y: z.number().finite().min(0).optional(),
    button: z.enum(['left', 'right', 'middle']).optional(),
    clickCount: z.number().int().min(1).max(3).optional(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
  },
  handler: async ({ selector, x, y, button, clickCount, timeoutMs }) => {
    const page = await session.getCurrentPage();

    if (selector && (x !== undefined || y !== undefined)) {
      throw new Error('browser_click accepts either selector or x/y coordinates, not both');
    }

    if (selector) {
      const handle = await page.waitForSelector(selector, {
        timeout: timeoutMs ?? DEFAULT_TIMEOUT,
      });
      if (!handle) throw new Error(`selector not found: ${selector}`);
      const box = await handle.boundingBox();
      await handle.click({ button, clickCount });
      return jsonOk({ selector, box });
    }

    if (x === undefined || y === undefined) {
      throw new Error('browser_click requires either selector or both x and y');
    }

    await page.mouse.click(x, y, { button, clickCount });
    return jsonOk({ x, y });
  },
});

const type_ = tool({
  name: 'browser_type',
  description:
    'Focus a selector and type text into it. clearFirst=true selects-all and deletes existing content first.',
  inputShape: {
    selector: z.string().min(1),
    text: z.string(),
    delayMs: z.number().int().min(0).max(200).optional(),
    clearFirst: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
  },
  handler: async ({ selector, text, delayMs, clearFirst, timeoutMs }) => {
    const page = await session.getCurrentPage();
    const handle = await page.waitForSelector(selector, {
      timeout: timeoutMs ?? DEFAULT_TIMEOUT,
    });
    if (!handle) throw new Error(`selector not found: ${selector}`);
    await handle.focus();
    if (clearFirst) {
      // Cross-platform: clear the value via DOM rather than Ctrl/Cmd+A which
      // differs between macOS and Linux. Dispatch input/change so frameworks see it.
      await handle.evaluate((el) => {
        const target = el as HTMLInputElement | HTMLTextAreaElement;
        if ('value' in target) {
          target.value = '';
          target.dispatchEvent(new Event('input', { bubbles: true }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    }
    await page.keyboard.type(text, { delay: delayMs });
    return textOk(`typed ${text.length} chars into ${selector}`);
  },
});

const pressKey = tool({
  name: 'browser_press_key',
  description:
    'Press a single key, optionally with modifiers. Examples: key="Enter", key="Tab", key="ArrowDown", or key="a" with modifiers=["Meta"] for Cmd+A.',
  inputShape: {
    key: z
      .string()
      .min(1)
      .describe('Puppeteer KeyInput, e.g. "Enter", "Escape", "ArrowLeft", "a".'),
    modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional(),
  },
  handler: async ({ key, modifiers }) => {
    const page = await session.getCurrentPage();
    const mods = modifiers ?? [];
    for (const m of mods) await page.keyboard.down(m);
    await page.keyboard.press(key as Parameters<typeof page.keyboard.press>[0]);
    for (const m of [...mods].reverse()) await page.keyboard.up(m);
    return textOk(`pressed ${[...mods, key].join('+')}`);
  },
});

const hover = tool({
  name: 'browser_hover',
  description: 'Hover the mouse over the element matched by selector.',
  inputShape: {
    selector: z.string().min(1),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
  },
  handler: async ({ selector, timeoutMs }) => {
    const page = await session.getCurrentPage();
    const handle = await page.waitForSelector(selector, {
      timeout: timeoutMs ?? DEFAULT_TIMEOUT,
    });
    if (!handle) throw new Error(`selector not found: ${selector}`);
    await handle.hover();
    return textOk(`hovered ${selector}`);
  },
});

const selectOption = tool({
  name: 'browser_select_option',
  description: 'Select one or more <option> values in a <select> element by selector.',
  inputShape: {
    selector: z.string().min(1),
    values: z.array(z.string()).min(1),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
  },
  handler: async ({ selector, values, timeoutMs }) => {
    const page = await session.getCurrentPage();
    await page.waitForSelector(selector, { timeout: timeoutMs ?? DEFAULT_TIMEOUT });
    const result = await page.select(selector, ...values);
    return jsonOk({ selected: result });
  },
});

const scroll = tool({
  name: 'browser_scroll',
  description:
    'Scroll the page. With selector, scrolls that element into view. Without selector, scrolls window to (x, y).',
  inputShape: {
    selector: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    behavior: z.enum(['auto', 'smooth']).optional(),
  },
  handler: async ({ selector, x, y, behavior }) => {
    const page = await session.getCurrentPage();
    if (selector) {
      const handle = await page.waitForSelector(selector, { timeout: DEFAULT_TIMEOUT });
      if (!handle) throw new Error(`selector not found: ${selector}`);
      await handle.scrollIntoView();
      return textOk(`scrolled ${selector} into view`);
    }
    const tx = x ?? 0;
    const ty = y ?? 0;
    const opts = { left: tx, top: ty, behavior: behavior ?? 'auto' };
    await page.evaluate((o) => {
      window.scrollTo(o as ScrollToOptions);
    }, opts);
    return textOk(`scrolled to (${tx}, ${ty})`);
  },
});

export const interactionTools: ToolDef<any>[] = [
  click,
  type_,
  pressKey,
  hover,
  selectOption,
  scroll,
];
