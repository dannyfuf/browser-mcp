import puppeteer, { type Browser, type HTTPRequest, type HTTPResponse, type Page } from 'puppeteer';
import { computeLaunchOptions } from './launch-args.ts';
import { logger } from './logger.ts';
import { finalizeAllRecordings, finalizeRecording } from './recording.ts';

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
  targetId: string;
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
  // Stable CDP target ids are required here because Phase 2 attaches recording state to records.
  private tabs = new Map<string, TabRecord>();
  private currentTargetId: string | null = null;
  private nextId = 1;
  private closing: Promise<void> | null = null;

  async ensureBrowser(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    if (this.launching) return this.launching;
    const launchOptions = computeLaunchOptions(process.env);
    const { headless, userDataDir } = launchOptions;
    logger.info('launching browser', { headless, userDataDir: userDataDir ?? null });
    this.launching = puppeteer
      .launch(launchOptions)
      .then((b) => {
        this.browser = b;
        b.on('disconnected', () => {
          logger.warn('browser disconnected');
          this.browser = null;
          this.tabs.clear();
          this.currentTargetId = null;
        });
        b.on('targetdestroyed', () => {
          // Prune by stable target id; Page wrapper identity is not a lifecycle boundary.
          this.pruneTabsAgainst(b);
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
    if (this.currentTargetId !== null) {
      const rec = this.tabs.get(this.currentTargetId);
      if (rec && !rec.page.isClosed()) return rec.page;
      this.removeTab(this.currentTargetId);
    }
    // Adopt the first existing page or open a new one.
    const pages = await browser.pages();
    const page = pages[0] ?? (await browser.newPage());
    const rec = this.registerPage(page);
    this.currentTargetId = rec.targetId;
    return page;
  }

  async newTab(url?: string): Promise<TabInfo> {
    const browser = await this.ensureBrowser();
    const page = await browser.newPage();
    const rec = this.registerPage(page);
    this.currentTargetId = rec.targetId;
    if (url) {
      await page.goto(url, { waitUntil: 'load' });
    }
    return this.toTabInfo(rec);
  }

  async switchTab(id: number): Promise<TabInfo> {
    const rec = this.requireTab(id);
    await rec.page.bringToFront().catch(() => undefined);
    this.currentTargetId = rec.targetId;
    return this.toTabInfo(rec);
  }

  async closeTab(id?: number): Promise<{ closedId: number; browserShutdown: boolean }> {
    const tabId = id ?? this.currentRecord()?.id;
    if (tabId === undefined) {
      throw new Error('no current tab to close');
    }
    const rec = this.requireTab(tabId);
    await finalizeRecording(rec.targetId);
    await rec.page.close().catch(() => undefined);
    this.removeTab(rec.targetId);
    if (this.tabs.size === 0) {
      await this.close();
      return { closedId: tabId, browserShutdown: true };
    }
    return { closedId: tabId, browserShutdown: false };
  }

  async pruneTabs(): Promise<void> {
    const browser = await this.ensureBrowser();
    this.pruneTabsAgainst(browser);
  }

  listTabs(): TabInfo[] {
    return [...this.tabs.values()].map((rec) => this.toTabInfo(rec));
  }

  getConsoleBuffer(): ConsoleEntry[] {
    const rec = this.currentRecord();
    return rec ? [...rec.console] : [];
  }

  clearConsoleBuffer(): void {
    const rec = this.currentRecord();
    if (rec) rec.console.length = 0;
  }

  getNetworkBuffer(): NetworkEntry[] {
    const rec = this.currentRecord();
    return rec ? [...rec.network] : [];
  }

  clearNetworkBuffer(): void {
    const rec = this.currentRecord();
    if (rec) rec.network.length = 0;
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.performClose().finally(() => {
      this.closing = null;
    });
    return this.closing;
  }

  private async performClose(): Promise<void> {
    let recordingError: unknown;
    try {
      await finalizeAllRecordings();
    } catch (err) {
      recordingError = err;
      logger.error('recording finalization error', String(err));
    }
    const browser = this.browser;
    this.browser = null;
    this.tabs.clear();
    this.currentTargetId = null;
    if (browser) {
      logger.info('closing browser');
      await browser.close().catch((err) => logger.warn('browser close error', String(err)));
    }
    if (recordingError) throw recordingError;
  }

  // ---------- internals ----------

  private requireTab(id: number): TabRecord {
    const rec = [...this.tabs.values()].find((candidate) => candidate.id === id);
    if (!rec) throw new Error(`tab ${id} not found`);
    if (rec.page.isClosed()) {
      this.removeTab(rec.targetId);
      throw new Error(`tab ${id} is already closed`);
    }
    return rec;
  }

  private registerPage(page: Page): TabRecord {
    const targetId = pageTargetId(page);
    const existing = this.tabs.get(targetId);
    if (existing) return existing;
    const rec: TabRecord = {
      id: this.nextId++,
      targetId,
      page,
      console: [],
      network: [],
      pendingRequests: new Map(),
    };
    this.tabs.set(rec.targetId, rec);
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
      isCurrent: rec.targetId === this.currentTargetId,
    };
  }

  private currentRecord(): TabRecord | undefined {
    return this.currentTargetId === null ? undefined : this.tabs.get(this.currentTargetId);
  }

  private pruneTabsAgainst(browser: Browser): void {
    const liveTargetIds = new Set(browser.targets().map(browserTargetId));
    for (const targetId of this.tabs.keys()) {
      if (!liveTargetIds.has(targetId)) this.removeTab(targetId);
    }
  }

  private removeTab(targetId: string): void {
    this.tabs.delete(targetId);
    if (this.currentTargetId === targetId) {
      const next = this.tabs.keys().next().value;
      this.currentTargetId = next ?? null;
    }
  }
}

function pageTargetId(page: Page): string {
  return browserTargetId(page.target());
}

function browserTargetId(target: unknown): string {
  return (target as { _targetId: string })._targetId;
}

export const session = new BrowserSession();

let signalsAttached = false;
let shutdownStarted = false;
export function attachShutdownHandlers(): void {
  if (signalsAttached) return;
  signalsAttached = true;
  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    logger.info(`shutdown signal: ${signal}`);
    try {
      await finalizeAllRecordings({ assemble: false });
    } catch (err) {
      logger.error('shutdown error', String(err));
    }
    try {
      await session.close();
    } catch (err) {
      logger.error('browser shutdown error', String(err));
    } finally {
      process.exit(0);
    }
  };
  Deno.addSignalListener('SIGINT', () => void shutdown('SIGINT'));
  Deno.addSignalListener('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('beforeExit', () => {
    session.close().catch((err: unknown) => logger.error('beforeExit close error', String(err)));
  });
}
