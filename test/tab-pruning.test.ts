import { expect } from '@std/expect';
import { afterEach, test } from '@std/testing/bdd';
import { session } from '../src/browser.ts';

process.env.BROWSER_HEADLESS = '1';

afterEach(async () => {
  await session.close();
});

test('pruning preserves both live tab records', async () => {
  const firstPage = await session.getCurrentPage();
  await firstPage.goto('about:blank#first');
  const secondTab = await session.newTab('about:blank#second');

  const before = session.listTabs();
  expect(before).toHaveLength(2);

  await session.pruneTabs();

  const after = session.listTabs();
  expect(after).toHaveLength(2);
  expect(after.map(({ id }) => id)).toEqual(before.map(({ id }) => id));
  expect(after.find(({ id }) => id === secondTab.id)).toEqual(secondTab);
});
