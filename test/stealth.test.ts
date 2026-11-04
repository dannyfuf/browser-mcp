import { expect } from '@std/expect';
import { afterAll, test } from '@std/testing/bdd';
import { session } from '../src/browser.ts';

process.env.BROWSER_HEADLESS = '1';
delete process.env.BROWSER_STEALTH;

afterAll(async () => {
  await session.close();
});

test('headless session hides webdriver and HeadlessChrome user agent signals', async () => {
  const page = await session.getCurrentPage();
  await page.goto('data:text/html,<title>stealth</title>');
  const signals = await page.evaluate(() => ({
    webdriver: navigator.webdriver,
    userAgent: navigator.userAgent,
  }));

  expect(signals.webdriver).toBe(false);
  expect(signals.userAgent).not.toContain('HeadlessChrome');
  expect(signals.userAgent).toContain('Chrome');
});
