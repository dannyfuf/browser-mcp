import puppeteer, { type Browser, type HTTPRequest, type HTTPResponse, type Page } from 'puppeteer';
import { logger } from './logger.ts';

export interface ConsoleEntry {
  ts: number;
  level: string;
  text: string;
  source?: string;
}

export interface NetworkEntry {
  ts: number;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  durationMs?: number;
  failure?: string;
  resourceType: string;
}

export interface TabInfo {
  id: number;
  url: string;
  title: string;
  isCurrent: boolean;
}

interface TabRecord {
  id: number;
  page: Page;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  pendingRequests: Map<string, { method: string; url: string; resourceType: string; ts: number }>;
}

const RING_CAP = 200;

function pushRing<T>(buf: T[], item: T, cap: number = RING_CAP): void {
  buf.push(item);
  if (buf.length > cap) buf.splice(0, buf.length - cap);
}

class BrowserSession {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private tabs = new Map<number, TabRecord>();
  private currentId: number | null = null;
  private nextId = 1;
  private shuttingDown = false;

  async ensureBrowser(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    if (this.launching) return this.launching;
    const headless = process.env.BROWSER_HEADLESS === '1';
    const userDataDir = process.env.BROWSER_USER_DATA_DIR || undefined;
    logger.info('launching browser', { headless, userDataDir: userDataDir ?? null });
    this.launching = puppeteer
      .launch({
        headless,
        defaultViewport: { width: 1280, height: 800 },
        userDataDir,
        args: ['--no-first-run', '--no-default-browser-check'],
      })
      .then((b) => {
        this.browser = b;
        b.on('disconnected', () => {
          logger.warn('browser disconnected');
          this.browser = null;
          this.tabs.clear();
          this.currentId = null;
        });
        b.on('targetdestroyed', (target) => {
          // prune the registry when a tab closes externally (e.g. window.close())
          const closed = target.type() === 'page';
          if (!closed) return;
          target.page().then((page) => {
            if (!page) return;
            for (const [id, rec] of this.tabs) {
              if (rec.page === page) {
                this.tabs.delete(id);
                if (this.currentId === id) {
                  const next = this.tabs.keys().next().value;
                  this.currentId = next ?? null;
                }
                break;
              }
            }
          });
        });
        return b;
      })
      .finally(() => {
        this.launching = null;
      });
    return this.launching;
  }

  async getCurrentPage(): Promise<Page> {
    const browser = await this.ensureBrowser();
    if (this.currentId !== null) {
      const rec = this.tabs.get(this.currentId);
      if (rec && !rec.page.isClosed()) return rec.page;
      this.tabs.delete(this.currentId);
      this.currentId = null;
    }
    // Adopt the first existing page or open a new one.
    const pages = await browser.pages();
    const page = pages[0] ?? (await browser.newPage());
    const rec = this.registerPage(page);
    this.currentId = rec.id;
    return page;
  }

  async newTab(url?: string): Promise<TabInfo> {
    const browser = await this.ensureBrowser();
    const page = await browser.newPage();
    const rec = this.registerPage(page);
    this.currentId = rec.id;
    if (url) {
      await page.goto(url, { waitUntil: 'load' });
    }
    return this.toTabInfo(rec);
  }

  async switchTab(id: number): Promise<TabInfo> {
    const rec = this.requireTab(id);
    await rec.page.bringToFront().catch(() => undefined);
    this.currentId = id;
    return this.toTabInfo(rec);
  }

  async closeTab(id?: number): Promise<{ closedId: number; browserShutdown: boolean }> {
    const targetId = id ?? this.currentId;
    if (targetId === null || targetId === undefined) {
      throw new Error('no current tab to close');
    }
    const rec = this.requireTab(targetId);
    await rec.page.close().catch(() => undefined);
    this.tabs.delete(targetId);
    if (this.currentId === targetId) {
      const next = this.tabs.keys().next().value;
      this.currentId = next ?? null;
    }
    if (this.tabs.size === 0) {
      await this.close();
      return { closedId: targetId, browserShutdown: true };
    }
    return { closedId: targetId, browserShutdown: false };
  }

  listTabs(): TabInfo[] {
    return [...this.tabs.values()].map((rec) => this.toTabInfo(rec));
  }

  getConsoleBuffer(): ConsoleEntry[] {
    const rec = this.currentId !== null ? this.tabs.get(this.currentId) : undefined;
    return rec ? [...rec.console] : [];
  }

  clearConsoleBuffer(): void {
    const rec = this.currentId !== null ? this.tabs.get(this.currentId) : undefined;
    if (rec) rec.console.length = 0;
  }

  getNetworkBuffer(): NetworkEntry[] {
    const rec = this.currentId !== null ? this.tabs.get(this.currentId) : undefined;
    return rec ? [...rec.network] : [];
  }

  clearNetworkBuffer(): void {
    const rec = this.currentId !== null ? this.tabs.get(this.currentId) : undefined;
    if (rec) rec.network.length = 0;
  }

  async close(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const browser = this.browser;
    this.browser = null;
    this.tabs.clear();
    this.currentId = null;
    if (browser) {
      logger.info('closing browser');
      await browser.close().catch((err) => logger.warn('browser close error', String(err)));
    }
    this.shuttingDown = false;
  }

  // ---------- internals ----------

  private requireTab(id: number): TabRecord {
    const rec = this.tabs.get(id);
    if (!rec) throw new Error(`tab ${id} not found`);
    if (rec.page.isClosed()) {
      this.tabs.delete(id);
      throw new Error(`tab ${id} is already closed`);
    }
    return rec;
  }

  private registerPage(page: Page): TabRecord {
    for (const existing of this.tabs.values()) {
      if (existing.page === page) return existing;
    }
    const rec: TabRecord = {
      id: this.nextId++,
      page,
      console: [],
      network: [],
      pendingRequests: new Map(),
    };
    this.tabs.set(rec.id, rec);
    this.attachPageDiagnostics(rec);
    return rec;
  }

  private attachPageDiagnostics(rec: TabRecord): void {
    const { page } = rec;

    page.on('console', (msg) => {
      const loc = msg.location();
      const source = loc.url ? `${loc.url}:${loc.lineNumber ?? 0}` : undefined;
      pushRing(rec.console, {
        ts: Date.now(),
        level: msg.type(),
        text: msg.text(),
        source,
      });
    });

    page.on('pageerror', (event: unknown) => {
      const text = event instanceof Error ? event.message : String(event);
      pushRing(rec.console, {
        ts: Date.now(),
        level: 'pageerror',
        text,
      });
    });

    page.on('request', (req: HTTPRequest) => {
      rec.pendingRequests.set(`${req.url()}:${req.method()}`, {
        method: req.method(),
        url: req.url(),
        resourceType: req.resourceType(),
        ts: Date.now(),
      });
    });

    page.on('response', (res: HTTPResponse) => {
      const req = res.request();
      const key = `${req.url()}:${req.method()}`;
      const pending = rec.pendingRequests.get(key);
      const ts = pending?.ts ?? Date.now();
      rec.pendingRequests.delete(key);
      pushRing(rec.network, {
        ts,
        method: req.method(),
        url: req.url(),
        status: res.status(),
        statusText: res.statusText(),
        durationMs: Date.now() - ts,
        resourceType: req.resourceType(),
      });
    });

    page.on('requestfailed', (req: HTTPRequest) => {
      const key = `${req.url()}:${req.method()}`;
      const pending = rec.pendingRequests.get(key);
      const ts = pending?.ts ?? Date.now();
      rec.pendingRequests.delete(key);
      pushRing(rec.network, {
        ts,
        method: req.method(),
        url: req.url(),
        failure: req.failure()?.errorText ?? 'unknown',
        durationMs: Date.now() - ts,
        resourceType: req.resourceType(),
      });
    });

    page.once('close', () => {
      // leave buffers in place until tab record is removed
    });
  }

  private toTabInfo(rec: TabRecord): TabInfo {
    return {
      id: rec.id,
      url: rec.page.url(),
      title: '',
      isCurrent: rec.id === this.currentId,
    };
  }
}

export const session = new BrowserSession();

let signalsAttached = false;
export function attachShutdownHandlers(): void {
  if (signalsAttached) return;
  signalsAttached = true;
  const shutdown = (signal: string) => {
    logger.info(`shutdown signal: ${signal}`);
    session
      .close()
      .catch((err) => logger.error('shutdown error', String(err)))
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('beforeExit', () => {
    session.close().catch((err: unknown) => logger.error('beforeExit close error', String(err)));
  });
}
