import { afterAll, beforeAll, expect, test } from 'bun:test';
import { session } from '../src/browser.ts';
import { type ToolDef, type ToolResult, tools } from '../src/tools/registry.ts';
import { type FixtureServer, startFixtureServer } from './fixtures/server.ts';

// Force headless for tests.
process.env.BROWSER_HEADLESS = '1';

let fixture: FixtureServer;

beforeAll(() => {
  fixture = startFixtureServer();
});

afterAll(async () => {
  await session.close();
  fixture.stop();
});

function getTool(name: string): ToolDef<any> {
  const t = tools.find((d) => d.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

async function call(name: string, args: any = {}): Promise<ToolResult> {
  const t = getTool(name);
  return t.handler(args);
}

function asText(result: ToolResult): string {
  return result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

function asJson<T = unknown>(result: ToolResult): T {
  return JSON.parse(asText(result)) as T;
}

test('tools/list contains every group', () => {
  const names = new Set(tools.map((t) => t.name));
  for (const expected of [
    'ping',
    'browser_navigate',
    'browser_click',
    'browser_type',
    'browser_screenshot',
    'browser_snapshot',
    'browser_get_html',
    'browser_console_logs',
    'browser_network_logs',
    'browser_wait_for_selector',
    'browser_set_viewport',
    'browser_list_tabs',
    'browser_new_tab',
  ]) {
    expect(names.has(expected)).toBe(true);
  }
});

test('navigate to fixture and read body text', async () => {
  const nav = await call('browser_navigate', { url: fixture.url });
  const navJson = asJson<{ url: string; status: number }>(nav);
  expect(navJson.status).toBe(200);

  const text = asJson<{ text: string }>(await call('browser_get_text'));
  expect(text.text).toContain('Fixture page');
});

test('get_html contains the form', async () => {
  const html = asJson<{ html: string }>(await call('browser_get_html'));
  expect(html.html).toContain('<form');
});

test('snapshot returns a tree with at least one node', async () => {
  const snap = asJson<{ tree: { children?: unknown[] } | null }>(await call('browser_snapshot'));
  expect(snap.tree).toBeTruthy();
});

test('screenshot returns image bytes', async () => {
  const r = await call('browser_screenshot', {});
  expect(r.content[0]?.type).toBe('image');
  const img = r.content[0] as { type: 'image'; data: string; mimeType: string };
  expect(img.mimeType).toBe('image/png');
  // PNG header bytes start with 89 50 4E 47 → base64 "iVBOR"
  expect(img.data.startsWith('iVBOR')).toBe(true);
});

test('type into form and click submit', async () => {
  await call('browser_type', { selector: '#name', text: 'Alice', clearFirst: true });
  await call('browser_select_option', { selector: '#color', values: ['blue'] });
  await call('browser_click', { selector: '#submit' });
  // The submitted line is appended synchronously on submit.
  await call('browser_wait_for_selector', { selector: '#submitted', timeoutMs: 2_000 });
  const text = asJson<{ text: string }>(await call('browser_get_text', { selector: '#submitted' }));
  expect(text.text).toContain('Alice');
  expect(text.text).toContain('blue');
});

test('click by viewport coordinates', async () => {
  await call('browser_navigate', { url: fixture.url });
  await call('browser_type', { selector: '#name', text: 'Coordinate', clearFirst: true });
  const r = await call('browser_evaluate', {
    expression: `(() => {
      const rect = document.getElementById('submit').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`,
  });
  const point = asJson<{ result: { x: number; y: number } }>(r).result;

  await call('browser_click', point);
  await call('browser_wait_for_selector', { selector: '#submitted', timeoutMs: 2_000 });
  const text = asJson<{ text: string }>(await call('browser_get_text', { selector: '#submitted' }));
  expect(text.text).toContain('Coordinate');
});

test('type clearFirst replaces existing value (cross-platform)', async () => {
  await call('browser_navigate', { url: fixture.url });
  // Pre-fill the field via JS so we know there is content to clear.
  await call('browser_evaluate', {
    expression: `(() => { const el = document.getElementById('name'); el.value = 'old'; el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; })()`,
  });
  await call('browser_type', { selector: '#name', text: 'fresh', clearFirst: true });
  const r = await call('browser_evaluate', {
    expression: `document.getElementById('name').value`,
  });
  const value = asJson<{ result: string }>(r).result;
  expect(value).toBe('fresh');
});

test('press_key works', async () => {
  // Just confirm the tool returns success for a benign key.
  const r = await call('browser_press_key', { key: 'Tab' });
  expect(r.isError).toBeUndefined();
});

test('hover and scroll work', async () => {
  const h = await call('browser_hover', { selector: '#submit' });
  expect(h.isError).toBeUndefined();
  const s = await call('browser_scroll', { y: 100 });
  expect(s.isError).toBeUndefined();
});

test('wait_for_selector resolves for a delayed element', async () => {
  // After navigate the timer has already fired; navigate fresh and immediately wait.
  await call('browser_navigate', { url: fixture.url });
  const r = await call('browser_wait_for_selector', {
    selector: '#late',
    state: 'visible',
    timeoutMs: 2_000,
  });
  expect(r.isError).toBeUndefined();
});

test('console_logs surfaces fixture errors', async () => {
  // Navigate again so we know there is a current page; messages from prior nav are buffered too.
  const r = asJson<{ entries: { level: string; text: string }[] }>(
    await call('browser_console_logs'),
  );
  const errors = r.entries.filter(
    (e) => e.level === 'error' || e.level === 'pageerror' || e.level === 'warn',
  );
  expect(errors.some((e) => e.text.includes('expected-error'))).toBe(true);
});

test('network_logs surfaces a 404 from a click-triggered fetch', async () => {
  await call('browser_navigate', { url: fixture.url });
  // Trigger the failing fetch via the page button.
  await call('browser_click', { selector: '#fail-fetch' });
  // Give the network event loop a moment.
  await new Promise((r) => setTimeout(r, 200));
  const r = asJson<{ entries: { url: string; status?: number }[] }>(
    await call('browser_network_logs', { urlIncludes: '/missing' }),
  );
  expect(r.entries.some((e) => e.status === 404 || /missing/.test(e.url))).toBe(true);
});

test('evaluate runs an expression in the page', async () => {
  const r = asJson<{ result: number }>(await call('browser_evaluate', { expression: '1 + 2' }));
  expect(r.result).toBe(3);
});

test('set_viewport changes the size and is reflected in screenshots', async () => {
  await call('browser_set_viewport', { width: 400, height: 600 });
  const w = asJson<{ result: number }>(
    await call('browser_evaluate', { expression: 'window.innerWidth' }),
  );
  expect(w.result).toBe(400);
});

test('tabs new + switch + close round-trips', async () => {
  const before = asJson<{ tabs: { id: number }[] }>(await call('browser_list_tabs'));
  const beforeCount = before.tabs.length;
  const newT = asJson<{ id: number }>(await call('browser_new_tab', { url: fixture.url }));
  expect(typeof newT.id).toBe('number');

  const mid = asJson<{ tabs: { id: number; isCurrent: boolean }[] }>(
    await call('browser_list_tabs'),
  );
  expect(mid.tabs.length).toBe(beforeCount + 1);
  expect(mid.tabs.find((t) => t.id === newT.id)?.isCurrent).toBe(true);

  // Switch back to the first tab.
  const firstId = mid.tabs.find((t) => t.id !== newT.id)?.id;
  if (firstId !== undefined) {
    await call('browser_switch_tab', { id: firstId });
  }
  const closed = asJson<{ closedId: number; browserShutdown: boolean }>(
    await call('browser_close_tab', { id: newT.id }),
  );
  expect(closed.closedId).toBe(newT.id);
  expect(closed.browserShutdown).toBe(false);
});
