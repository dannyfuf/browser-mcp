import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { artifactPath } from '../artifacts.ts';
import { session } from '../browser.ts';
import { jsonOk, type ToolDef, type ToolResult, tool } from './registry.ts';

const DEFAULT_TIMEOUT = 5_000;
const DEFAULT_MAX_LEN = 100_000;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n[truncated ${s.length - max} chars]`;
}

const screenshot = tool({
  name: 'browser_screenshot',
  description:
    'Capture a PNG screenshot. With selector, screenshots that element. Without selector, viewport (or fullPage when true). Output defaults to inline MCP image content; file writes to the artifact directory and returns its path; both returns both forms.',
  inputShape: {
    selector: z.string().optional(),
    fullPage: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
    output: z.enum(['inline', 'file', 'both']).optional(),
  },
  handler: async ({ selector, fullPage, timeoutMs, output }): Promise<ToolResult> => {
    const page = await session.getCurrentPage();
    let buf: Uint8Array;
    if (selector) {
      const handle = await page.waitForSelector(selector, {
        timeout: timeoutMs ?? DEFAULT_TIMEOUT,
      });
      if (!handle) throw new Error(`selector not found: ${selector}`);
      buf = (await handle.screenshot({ type: 'png' })) as Uint8Array;
    } else {
      buf = (await page.screenshot({ type: 'png', fullPage: fullPage ?? false })) as Uint8Array;
    }

    const content: ToolResult['content'] = [];
    if (output !== 'file') {
      const data = Buffer.from(buf).toString('base64');
      content.push({ type: 'image', data, mimeType: 'image/png' });
    }
    if (output === 'file' || output === 'both') {
      const path = artifactPath('screenshot', 'png');
      await writeFile(path, buf);
      content.push({ type: 'text', text: path });
    }
    return { content };
  },
});

// Walk an accessibility tree and assign stable refs to interactive nodes.
type AxNode = {
  role?: string;
  name?: string;
  value?: string | number;
  description?: string;
  children?: AxNode[];
  // refs added by us:
  ref?: string;
};

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'menuitem',
  'tab',
  'textbox',
  'combobox',
  'listbox',
  'option',
  'switch',
  'slider',
  'searchbox',
  'spinbutton',
  'menuitemcheckbox',
  'menuitemradio',
]);

function decorateRefs(node: AxNode | null, counter: { n: number }): AxNode | null {
  if (!node) return null;
  if (node.role && INTERACTIVE_ROLES.has(node.role)) {
    counter.n += 1;
    node.ref = `r${counter.n}`;
  }
  if (node.children) {
    node.children = node.children
      .map((c) => decorateRefs(c, counter))
      .filter((c): c is AxNode => c !== null);
  }
  return node;
}

const snapshot = tool({
  name: 'browser_snapshot',
  description:
    'Return an accessibility snapshot of the current page (interesting nodes only). Each interactive node gets a stable `ref` id you can use to identify it across calls. Far cheaper to reason about than raw HTML.',
  inputShape: {},
  handler: async () => {
    const page = await session.getCurrentPage();
    const tree = (await page.accessibility.snapshot({ interestingOnly: true })) as AxNode | null;
    const decorated = decorateRefs(tree, { n: 0 });
    return jsonOk({ url: page.url(), tree: decorated });
  },
});

const getHtml = tool({
  name: 'browser_get_html',
  description:
    'Return outerHTML of the matched selector (default: <html>). Truncated to maxLength chars (default 100000). Pass a tighter selector if you need more.',
  inputShape: {
    selector: z.string().optional(),
    maxLength: z.number().int().positive().max(1_000_000).optional(),
  },
  handler: async ({ selector, maxLength }) => {
    const page = await session.getCurrentPage();
    const html = selector
      ? await page.$eval(selector, (el) => (el as Element).outerHTML)
      : await page.content();
    return jsonOk({ html: truncate(html, maxLength ?? DEFAULT_MAX_LEN) });
  },
});

const getText = tool({
  name: 'browser_get_text',
  description:
    'Return innerText of the matched selector (default: <body>). Truncated to maxLength chars (default 100000).',
  inputShape: {
    selector: z.string().optional(),
    maxLength: z.number().int().positive().max(1_000_000).optional(),
  },
  handler: async ({ selector, maxLength }) => {
    const page = await session.getCurrentPage();
    const text = selector
      ? await page.$eval(selector, (el) => (el as HTMLElement).innerText ?? el.textContent ?? '')
      : await page.evaluate(() => document.body?.innerText ?? '');
    return jsonOk({ text: truncate(text, maxLength ?? DEFAULT_MAX_LEN) });
  },
});

const evaluate = tool({
  name: 'browser_evaluate',
  description:
    'Evaluate a JS expression in the page context and return the JSON-stringified result. The expression is wrapped in an async IIFE so `await ...` works. SECURITY: the expression runs in the page; do not pass untrusted input.',
  inputShape: {
    expression: z.string().min(1),
  },
  handler: async ({ expression }) => {
    const page = await session.getCurrentPage();
    const result = await page.evaluate((expr: string) => {
      const fn = new Function(`return (async () => (${expr}))();`);
      return fn();
    }, expression);
    return jsonOk({ result });
  },
});

export const inspectionTools: ToolDef<any>[] = [screenshot, snapshot, getHtml, getText, evaluate];
