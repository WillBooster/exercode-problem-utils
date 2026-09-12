import { randomUUID } from 'node:crypto';
import type { TestCaseResult } from '@exercode/problem-utils';
import {
  launch,
  PuppeteerError,
  TimeoutError,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type HTTPRequest,
  type LaunchOptions,
  type Page,
} from 'puppeteer';

const submitEventsKey = '@exercode/problem-utils-browser/submit-events';
const pendingSubmitChecks = new WeakMap<Page, Promise<void>>();

/** Launches the Chrome headless shell installed for this Puppeteer version. */
export async function launchBrowser(options: LaunchOptions = {}): Promise<Browser> {
  return launch({
    browser: 'chrome',
    headless: 'shell',
    defaultViewport: { width: 1280, height: 720 },
    ...options,
    args: [
      ...(process.env.CI || process.env.WB_DOCKER === '1' ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
      ...(options.args ?? []),
    ],
  });
}

/** Encodes a page screenshot as a judge output file. */
export async function captureScreenshot(
  page: Page,
  filename = 'screenshot_received.png'
): Promise<NonNullable<TestCaseResult['outputFiles']>[number]> {
  const screenshot = await capturePngScreenshot(page);
  return { path: filename, data: screenshot.toString('base64'), encoding: 'base64' };
}

/** Captures a full-page PNG within the page's configured default timeout. */
export async function capturePngScreenshot(page: Page): Promise<Buffer> {
  const timeout = page.getDefaultTimeout();
  // A native screenshot holds a context-wide mutex even after a timeout, blocking other pages.
  const session = await page.createCDPSession();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const screenshot = captureFullPagePng(page, session);
    const result = await (timeout === 0
      ? screenshot
      : Promise.race([
          screenshot,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new TimeoutError(`Screenshot capture timed out after ${timeout} ms`)),
              timeout
            );
          }),
        ]));
    return Buffer.from(result.data, 'base64');
  } finally {
    clearTimeout(timer);
    await session.detach().catch(() => {
      // Closing the page also detaches this session; preserve the capture outcome.
    });
  }
}

async function captureFullPagePng(page: Page, session: CDPSession) {
  const [{ cssContentSize, contentSize }, { screenInfos }] = await Promise.all([
    session.send('Page.getLayoutMetrics'),
    session.send('Emulation.getScreenInfos'),
  ]);
  // A fresh session uses the physical display scale; Puppeteer's viewport emulation belongs to its own session.
  // Device-pixel content sizes are rounded, so use their ratio only to identify the display's exact scale.
  const approximateScale = contentSize.width / cssContentSize.width;
  const screen = screenInfos.toSorted(
    (a, b) => Math.abs(a.devicePixelRatio - approximateScale) - Math.abs(b.devicePixelRatio - approximateScale)
  )[0]!;
  const viewport = page.viewport();
  const scale =
    viewport && viewport.deviceScaleFactor !== 0 ? (viewport.deviceScaleFactor ?? 1) / screen.devicePixelRatio : 1;
  return session.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: true,
    clip: { ...cssContentSize, scale },
  });
}

/** Finds a required course control immediately and reports its selector when absent. */
export async function requirePageElement(page: Page, selector: string) {
  const element = await page.$(selector);
  if (!element) throw new Error(`要素が見つかりません: ${selector}`);
  return element;
}

/** Evaluates a program with shared window state and evaluation-local lexical declarations. */
export async function evaluateBrowserProgram(page: Page, source: string): Promise<unknown> {
  try {
    // oxlint-disable-next-line no-eval -- Separate lexical scopes prevent setup declarations from colliding with learner declarations.
    return await page.evaluate((program) => globalThis.eval(program), source);
  } catch (error) {
    if (error instanceof PuppeteerError) throw error;
    // Presets expose the message as feedback; include the browser exception type there.
    throw error instanceof Error ? new Error(String(error), { cause: error }) : error;
  }
}

/** Creates a native page that dismisses dialogs unless the grader handles them. */
export async function createBrowserPage(browser: Browser | BrowserContext): Promise<Page> {
  const page = await browser.newPage();
  page.on('dialog', (dialog) => {
    if (page.listenerCount('dialog') === 1 && !dialog.handled) {
      void dialog.dismiss().catch(() => {
        // The page may close while Chrome is processing dismissal.
      });
    }
  });
  // Observe before learner listeners, which may stop immediate propagation on window.
  await page.evaluateOnNewDocument((key) => {
    const events = new WeakMap<EventTarget, Event>();
    Object.defineProperty(globalThis, key, { value: events, configurable: true });
    globalThis.addEventListener(
      'submit',
      (event) => {
        if (event.target) events.set(event.target, event);
      },
      true
    );
  }, submitEventsKey);
  return page;
}

/** Activates a form control and reports whether the submitted event was canceled by the page. */
export async function clickAndDetectCanceledSubmit(page: Page, buttonSelector: string): Promise<boolean> {
  const previous = pendingSubmitChecks.get(page);
  const { promise, resolve } = Promise.withResolvers<void>();
  pendingSubmitChecks.set(page, promise);
  try {
    await previous;
    return await checkCanceledSubmit(page, buttonSelector);
  } finally {
    resolve();
    if (pendingSubmitChecks.get(page) === promise) pendingSubmitChecks.delete(page);
  }
}

async function checkCanceledSubmit(page: Page, buttonSelector: string): Promise<boolean> {
  await using button = await requirePageElement(page, buttonSelector);
  if (!(await button.isVisible())) return false;
  const session = await page.createCDPSession();
  const bindingName = `__exercode_submit_${randomUUID().replaceAll('-', '')}`;
  let canceledBeforeNavigation = false;
  session.on('Runtime.bindingCalled', (event) => {
    if (event.name === bindingName) canceledBeforeNavigation = event.payload === 'true';
  });
  try {
    await session.send('Runtime.addBinding', { name: bindingName });
    await using observer = await button.evaluateHandle(
      (button, { key, bindingName }) => {
        const form = (button as HTMLButtonElement).form;
        if (!form) return;
        const earlyEvents = (globalThis as unknown as Record<string, WeakMap<EventTarget, Event> | undefined>)[key];
        earlyEvents?.delete(form);
        const submission: { event?: Event } = {};
        const onSubmit = (event: Event): void => {
          if (event.target === form) submission.event = event;
        };
        const read = (): boolean => (submission.event ?? earlyEvents?.get(form))?.defaultPrevented ?? false;
        const beforeUnload = (): void => {
          (globalThis as unknown as Record<string, (payload: string) => void>)[bindingName]!(read() ? 'true' : 'false');
        };
        globalThis.addEventListener('submit', onSubmit, true);
        // Keep the verdict when an explicit redirect replaces the document before the result read.
        globalThis.addEventListener('beforeunload', beforeUnload, true);
        return {
          read,
          cleanup: () => {
            globalThis.removeEventListener('submit', onSubmit, true);
            globalThis.removeEventListener('beforeunload', beforeUnload, true);
            earlyEvents?.delete(form);
          },
        };
      },
      { key: submitEventsKey, bindingName }
    );
    try {
      if (!(await page.evaluate((state) => state !== undefined, observer))) return false;
      await button.click();
      return await page.evaluate((state) => state?.read() ?? false, observer);
    } catch (error) {
      if (error instanceof Error) {
        if (
          error.message === 'Node is either not clickable or not an Element' ||
          error.message === 'Node is detached from document'
        )
          return false;
        if (
          error.message === 'Execution context was destroyed, most likely because of a navigation.' ||
          error.message === 'Protocol error (Runtime.callFunctionOn): Could not find object with given id'
        ) {
          return canceledBeforeNavigation;
        }
      }
      throw error;
    } finally {
      await page
        .evaluate((state) => state?.cleanup(), observer)
        .catch(() => {
          // Navigation or page closure discards the document's temporary listeners.
        });
    }
  } finally {
    await session.send('Runtime.removeBinding', { name: bindingName }).catch(() => {
      // A closed target already discards the binding.
    });
    await page
      .evaluate((name) => {
        delete (globalThis as unknown as Record<string, unknown>)[name];
      }, bindingName)
      .catch(() => {
        // A closed page has no surviving global binding to remove.
      });
    await session.detach().catch(() => {
      // The target may have closed during navigation.
    });
  }
}

export interface CapturedFormRequest {
  method: string;
  path: string;
  params: URLSearchParams;
}

/** Captures a URL-encoded form navigation without sending it to the server. Requires exclusive request interception. */
export async function submitFormAndCaptureRequest(
  page: Page,
  buttonSelector: string,
  timeoutMs = 2000
): Promise<CapturedFormRequest | undefined> {
  const { promise, resolve, reject } = Promise.withResolvers<CapturedFormRequest | undefined>();
  const captureRequest = (request: HTTPRequest): void => {
    void handleRequest(request).catch(reject);
  };
  async function handleRequest(request: HTTPRequest): Promise<void> {
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) {
      await request.continue();
      return;
    }
    clearTimeout(timer);
    const url = new URL(request.url());
    const result = {
      method: request.method(),
      path: url.pathname,
      params: new URLSearchParams(request.method() === 'GET' ? url.search : (request.postData() ?? '')),
    };
    await request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: '' });
    resolve(result);
  }
  await page.setRequestInterception(true);
  page.on('request', captureRequest);
  const timer = setTimeout(() => resolve(undefined), timeoutMs);
  try {
    const [, result] = await Promise.all([page.click(buttonSelector), promise]);
    return result;
  } finally {
    clearTimeout(timer);
    page.off('request', captureRequest);
    await page.setRequestInterception(false);
  }
}
