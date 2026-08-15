import { expect } from '@std/expect';
import { afterAll, test } from '@std/testing/bdd';
import { session } from '../src/browser.ts';

afterAll(async () => {
  await session.close();
});

test('launches and tracks a tab, then closes cleanly', async () => {
  const page = await session.getCurrentPage();
  await page.goto('about:blank');
  const tabs = session.listTabs();
  expect(tabs.length).toBeGreaterThanOrEqual(1);
  const current = tabs.find((t) => t.isCurrent);
  expect(current).toBeDefined();
  expect(typeof current?.id).toBe('number');
});

test('newTab opens and switches', async () => {
  const newTab = await session.newTab();
  expect(newTab.isCurrent).toBe(true);
  const tabs = session.listTabs();
  expect(tabs.length).toBeGreaterThanOrEqual(2);
});

test('close brings everything down', async () => {
  await session.close();
  expect(session.listTabs().length).toBe(0);
});
