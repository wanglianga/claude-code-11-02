import { chromium, type Browser } from 'playwright';

let browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browser;
}

export async function closeBrowser() {
  if (browser) {
    await browser.close().catch(() => undefined);
    browser = null;
  }
}
