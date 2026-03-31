'use strict';

/**
 * Tencent Docs Markdown Skill - Authentication Module
 *
 * Handles QR code login via Puppeteer with 10-second polling.
 * Supports cookie persistence and automatic re-login on expiry.
 */

import puppeteer, { Browser, Page } from 'puppeteer';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import ora from 'ora';

export const COOKIE_FILE = path.join(__dirname, '..', '.cookies.json');
const DOCS_URL = 'https://docs.qq.com/desktop';
const LOGIN_CHECK_URL = 'https://docs.qq.com/cgi-bin/online_docs/user_info';

/** Shape of a browser cookie entry. */
export interface CookieEntry {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

/**
 * Allowed cookie domains — only cookies scoped to Tencent Docs are permitted.
 */
export const ALLOWED_COOKIE_DOMAINS: readonly string[] = ['.qq.com', 'docs.qq.com', '.docs.qq.com'];

/** Save cookies to local file. */
export function saveCookies(cookies: CookieEntry[]): void {
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2), 'utf-8');
}

/**
 * Sanitize and validate a raw cookie array.
 * Ensures every cookie entry is well-formed and domain-restricted.
 */
export function sanitizeCookies(data: unknown): CookieEntry[] | null {
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  const sanitized: CookieEntry[] = [];
  for (const cookie of data) {
    if (typeof cookie !== 'object' || cookie === null) return null;
    const c = cookie as Record<string, unknown>;
    if (typeof c.name !== 'string' || typeof c.value !== 'string') return null;
    if (c.name.length === 0) return null;

    if (!c.domain || typeof c.domain !== 'string') return null;
    const domainOk = ALLOWED_COOKIE_DOMAINS.some(
      (d) => c.domain === d || (c.domain as string).endsWith(d),
    );
    if (!domainOk) return null;

    const clean: CookieEntry = { name: c.name, value: c.value };
    if (typeof c.domain === 'string') clean.domain = c.domain;
    if (typeof c.path === 'string') clean.path = c.path;
    if (typeof c.expires === 'number') clean.expires = c.expires;
    if (typeof c.httpOnly === 'boolean') clean.httpOnly = c.httpOnly;
    if (typeof c.secure === 'boolean') clean.secure = c.secure;
    if (typeof c.sameSite === 'string') clean.sameSite = c.sameSite;
    sanitized.push(clean);
  }

  return sanitized;
}

/**
 * Read raw cookie data from the local file.
 * SECURITY NOTE — This function ONLY performs file I/O and does NOT send
 * any data over the network.
 */
export function readCookieFile(): unknown | null {
  if (!fs.existsSync(COOKIE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Load cookies from local file, with full sanitization.
 * This is the ONLY approved way to obtain cookies for network-facing code.
 */
export function loadCookies(): CookieEntry[] | null {
  const raw = readCookieFile();
  if (!raw) return null;
  return sanitizeCookies(raw);
}

/** Extract the cookie string for HTTP requests. */
export function getCookieString(cookies: CookieEntry[] | null): string {
  if (!cookies || !Array.isArray(cookies)) return '';
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** Get XSRF token (TOK) from cookies. */
export function getXsrfToken(cookies: CookieEntry[] | null): string {
  if (!cookies || !Array.isArray(cookies)) return '';
  const tok = cookies.find((c) => c.name === 'TOK');
  return tok ? tok.value : '';
}

/**
 * Check if the current cookies are still valid.
 * Cookies are re-sanitized before network transmission.
 */
export async function isCookieValid(cookies: CookieEntry[]): Promise<boolean> {
  const safeCookies = sanitizeCookies(cookies);
  if (!safeCookies) return false;

  const axios = (await import('axios')).default;
  const xsrf = getXsrfToken(safeCookies);
  if (!xsrf) return false;

  const targetUrl = `${LOGIN_CHECK_URL}?xsrf=${xsrf}`;
  const allowedHostnames = ['docs.qq.com'];
  const parsedUrl = new URL(targetUrl);
  if (!allowedHostnames.includes(parsedUrl.hostname)) {
    console.error(`Security: Blocked cookie transmission to unauthorized domain: ${parsedUrl.hostname}`);
    return false;
  }

  try {
    const resp = await axios.post(
      targetUrl,
      {},
      {
        headers: {
          Cookie: getCookieString(safeCookies),
          'Content-Type': 'application/json',
          Referer: 'https://docs.qq.com/',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        timeout: 10000,
      },
    );
    return resp.data && resp.data.retcode === 0;
  } catch {
    return false;
  }
}

/** Page snapshot for polling-based login detection. */
interface PageSnapshot {
  url: string;
  title: string;
  contentFingerprint: string;
  domElementCount: number;
  iframeCount: number;
  hasQrIframe: boolean;
  hasAvatar: boolean;
  hasTOK: boolean;
  modalVisible: boolean;
  hasLoggingInStatus: boolean;
}

/** A detected change between two snapshots. */
interface ChangeSignal {
  signal: string;
  description: string;
}

/**
 * Login via QR code scanning using Puppeteer.
 * Uses a 10-second polling mechanism to detect page changes.
 */
export async function loginWithQRCode(): Promise<CookieEntry[]> {
  const spinner = ora('Launching browser for QR code login...').start();

  const POLL_INTERVAL = 10000;
  const MAX_POLLS = 30;

  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch({
      headless: false,
      defaultViewport: { width: 1280, height: 800 },
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page: Page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    );

    spinner.text = 'Navigating to Tencent Docs login page...';
    await page.goto(DOCS_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Step 1: Click "立即登录" on the homepage
    spinner.text = 'Clicking login button...';
    await page.evaluate(() => {
      const allEls = document.querySelectorAll('span, a, button, div');
      for (const el of allEls) {
        const text = (el.textContent || '').trim();
        if (text === '立即登录' && el.children.length <= 1) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && rect.width < 300) {
            (el as HTMLElement).click();
            return;
          }
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Step 2: Check the "我已阅读并接受" checkbox
    spinner.text = 'Accepting service agreement...';
    await page.evaluate(() => {
      const checkboxes = document.querySelectorAll('input[type="checkbox"]');
      for (const cb of checkboxes) {
        const rect = cb.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          if (!(cb as HTMLInputElement).checked) (cb as HTMLElement).click();
          return;
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Step 3: Click "立即登录" in the compliance dialog
    spinner.text = 'Confirming login...';
    await page.evaluate(() => {
      const allEls = document.querySelectorAll('button, div, span, a');
      const candidates: Array<{ el: Element; inModal: boolean; y: number }> = [];
      for (const el of allEls) {
        const text = (el.textContent || '').trim();
        if (text === '立即登录' && el.children.length <= 1) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 20 && rect.height > 20 && rect.width < 300) {
            const inModal = el.closest('[class*="modal"], [class*="compliance"], [class*="dialog"], [class*="popup"]');
            candidates.push({ el, inModal: !!inModal, y: rect.y });
          }
        }
      }
      candidates.sort((a, b) => {
        if (a.inModal && !b.inModal) return -1;
        if (!a.inModal && b.inModal) return 1;
        return b.y - a.y;
      });
      if (candidates.length > 0) (candidates[0]!.el as HTMLElement).click();
    });

    // Wait for QR code page to fully load
    spinner.text = 'Waiting for login page to load...';
    try {
      await page.waitForSelector('iframe[src*="xlogin"], iframe[src*="weixin"]', { timeout: 15000 });
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    // Step 4: Attempt WeChat Quick Login (微信快捷登录)
    spinner.text = 'Checking for WeChat Quick Login button...';
    let quickLoginClicked = false;
    try {
      quickLoginClicked = await page.evaluate(() => {
        const allEls = document.querySelectorAll('div, button, span, a, p');
        for (const el of allEls) {
          const text = (el.textContent || '').trim();
          if (text === '微信快捷登录' && el.children.length <= 2) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && rect.width < 400) {
              (el as HTMLElement).click();
              return true;
            }
          }
        }
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
          try {
            const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
            if (!iframeDoc) continue;
            const iframeEls = iframeDoc.querySelectorAll('div, button, span, a, p');
            for (const el of iframeEls) {
              const text = (el.textContent || '').trim();
              if (text === '微信快捷登录' && el.children.length <= 2) {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  (el as HTMLElement).click();
                  return true;
                }
              }
            }
          } catch {
            // Cross-origin iframe — skip
          }
        }
        return false;
      });
    } catch {
      quickLoginClicked = false;
    }

    // If quick login button not found via page.evaluate, try inside iframe contentFrame
    if (!quickLoginClicked) {
      try {
        const loginFrame = await page.$('iframe[src*="xlogin"]');
        if (loginFrame) {
          const frame = await loginFrame.contentFrame();
          if (frame) {
            const quickBtn = await frame.evaluate(() => {
              const els = document.querySelectorAll('div, a, span, button, p, img');
              for (const el of els) {
                const text = ((el as HTMLElement).textContent || (el as HTMLImageElement).alt || '').trim();
                if (text.includes('快捷登录') || text.includes('快速登录') || text.includes('微信快捷')) {
                  const rect = el.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    (el as HTMLElement).click();
                    return true;
                  }
                }
              }
              return false;
            });
            if (quickBtn) quickLoginClicked = true;
          }
        }
      } catch {
        // iframe access failed — fall back to QR code scan
      }
    }

    if (quickLoginClicked) {
      spinner.stop();
      console.log(chalk.cyan('\n🚀 WeChat Quick Login button clicked!'));
      console.log(chalk.gray('   Detected "登录中..." status. Waiting for login to complete...'));
      console.log(chalk.gray('   Polling every 10s to detect login status...\n'));
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } else {
      spinner.stop();
      console.log(chalk.yellow('\n📱 Please scan the QR code in the browser window to log in.'));
      console.log(chalk.gray('   (Or click "微信快捷登录" button in the browser if available)'));
      console.log(chalk.gray('   Polling every 10s to detect login status...\n'));
    }

    // ── Polling helpers ──

    /** Capture a comprehensive snapshot of the current page state. */
    async function capturePageSnapshot(): Promise<PageSnapshot> {
      try {
        return await page.evaluate(() => {
          const bodyText = (document.body.innerText || '').substring(0, 3000);
          const iframeCount = document.querySelectorAll('iframe').length;
          const hasQrIframe = !!document.querySelector('iframe[src*="xlogin"], iframe[src*="weixin"]');
          const hasAvatar = !!document.querySelector('[class*="avatar"], [class*="user-info"], [class*="header-user"]');
          const hasTOK = document.cookie.includes('TOK=');
          const modalVisible = !!document.querySelector(
            '[class*="login-modal"], [class*="login-dialog"], [class*="login-panel"], [class*="compliance"]',
          );
          const hasLoggingInStatus = bodyText.includes('登录中') || bodyText.includes('Logging in');
          const contentFingerprint = bodyText.length + '|' + bodyText.substring(0, 500);
          const domElementCount = document.querySelectorAll('div, section, main, article, header, nav').length;
          return {
            url: window.location.href,
            title: document.title,
            contentFingerprint,
            domElementCount,
            iframeCount,
            hasQrIframe,
            hasAvatar,
            hasTOK,
            modalVisible,
            hasLoggingInStatus,
          };
        });
      } catch {
        return {
          url: '', title: '', contentFingerprint: '', domElementCount: 0,
          iframeCount: 0, hasQrIframe: false, hasAvatar: false, hasTOK: false,
          modalVisible: false, hasLoggingInStatus: false,
        };
      }
    }

    /** Compute change signals between two snapshots. */
    function detectChanges(prev: PageSnapshot, curr: PageSnapshot): ChangeSignal[] {
      const changes: ChangeSignal[] = [];
      if (prev.url !== curr.url) {
        changes.push({ signal: 'url', description: `URL: ${prev.url} → ${curr.url}` });
      }
      if (prev.title !== curr.title) {
        changes.push({ signal: 'title', description: `Title: "${prev.title}" → "${curr.title}"` });
      }
      if (prev.hasQrIframe && !curr.hasQrIframe) {
        changes.push({ signal: 'qr_gone', description: 'QR code iframe disappeared' });
      }
      if (!prev.hasAvatar && curr.hasAvatar) {
        changes.push({ signal: 'avatar', description: 'User avatar appeared' });
      }
      if (!prev.hasTOK && curr.hasTOK) {
        changes.push({ signal: 'tok', description: 'TOK cookie detected in page' });
      }
      if (prev.modalVisible && !curr.modalVisible) {
        changes.push({ signal: 'modal_gone', description: 'Login modal disappeared' });
      }
      if (prev.contentFingerprint !== curr.contentFingerprint) {
        changes.push({ signal: 'content', description: 'Page content changed' });
      }
      if (Math.abs(prev.domElementCount - curr.domElementCount) > 10) {
        changes.push({ signal: 'dom_structure', description: `DOM structure changed (${prev.domElementCount} → ${curr.domElementCount} elements)` });
      }
      if (!prev.hasLoggingInStatus && curr.hasLoggingInStatus) {
        changes.push({ signal: 'logging_in', description: 'WeChat Quick Login in progress (登录中...)' });
      }
      if (prev.hasLoggingInStatus && !curr.hasLoggingInStatus) {
        changes.push({ signal: 'logging_in_done', description: 'WeChat Quick Login "登录中..." status cleared — login likely completed' });
      }
      return changes;
    }

    /** Determine if the page has "completely changed". */
    function isFullPageChange(changes: ChangeSignal[]): boolean {
      const strongSignals = ['url', 'tok', 'avatar', 'qr_gone', 'logging_in_done'];
      const hasStrong = changes.some((c) => strongSignals.includes(c.signal));
      return hasStrong || changes.length >= 2;
    }

    /** Check if the current page state indicates a successful login. */
    function isLoginDetected(snapshot: PageSnapshot, changes: ChangeSignal[] | null): boolean {
      if (snapshot.hasTOK) return true;
      if (snapshot.hasAvatar && !snapshot.hasQrIframe) return true;
      if (changes && changes.some((c) => c.signal === 'logging_in_done')) {
        if (!snapshot.hasQrIframe && !snapshot.hasLoggingInStatus) return true;
      }
      if (
        (snapshot.url.includes('/desktop') || snapshot.url.includes('/home')) &&
        !snapshot.hasQrIframe &&
        !snapshot.modalVisible &&
        !snapshot.hasLoggingInStatus
      ) {
        return true;
      }
      return false;
    }

    /** Attempt to retrieve cookies from the browser, with retry. */
    async function retrieveCookies(): Promise<CookieEntry[] | null> {
      let cookies = await page.cookies();
      if (cookies.length === 0) {
        console.log(chalk.yellow('   ⚠️  No cookies yet, waiting 5s and retrying...'));
        await new Promise((r) => setTimeout(r, 5000));
        cookies = await page.cookies();
      }
      return cookies.length > 0 ? (cookies as unknown as CookieEntry[]) : null;
    }

    // ── Start polling ──

    let prevSnapshot = await capturePageSnapshot();
    console.log(chalk.gray(`   [Baseline] URL: ${prevSnapshot.url}`));
    console.log(chalk.gray(`   [Baseline] QR iframe: ${prevSnapshot.hasQrIframe}, Modal: ${prevSnapshot.modalVisible}\n`));

    const pollSpinner = ora('Polling login status every 10 seconds...').start();
    let loginDetected = false;
    let finalCookies: CookieEntry[] | null = null;

    for (let poll = 1; poll <= MAX_POLLS; poll++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));

      const elapsed = poll * (POLL_INTERVAL / 1000);
      pollSpinner.text = `[Poll #${poll}] Checking page status... (${elapsed}s elapsed)`;

      const currSnapshot = await capturePageSnapshot();
      const changes = detectChanges(prevSnapshot, currSnapshot);

      if (changes.length === 0) {
        pollSpinner.text = `[Poll #${poll}] No page change. Waiting... (${elapsed}s elapsed)`;
        continue;
      }

      pollSpinner.info(chalk.blue(`[Poll #${poll} - ${elapsed}s] ${changes.length} change(s) detected:`));
      for (const c of changes) {
        console.log(chalk.gray(`   • ${c.description}`));
      }

      if (!isFullPageChange(changes)) {
        console.log(chalk.gray('   Minor change only. Updating baseline and continuing to poll...\n'));
        prevSnapshot = currSnapshot;
        pollSpinner.start(`[Poll #${poll}] Continuing to poll...`);
        continue;
      }

      console.log(chalk.cyan('   ↳ Full page change detected! Checking if login is complete...'));

      if (isLoginDetected(currSnapshot, changes)) {
        console.log(chalk.green('\n   ✅ Login detected! Attempting to retrieve cookies...\n'));
        await new Promise((resolve) => setTimeout(resolve, 3000));

        finalCookies = await retrieveCookies();

        if (finalCookies) {
          console.log(chalk.gray(`   Retrieved ${finalCookies.length} cookies from browser`));
          console.log(chalk.gray('   Validating cookies against Tencent Docs API...'));

          const valid = await isCookieValid(finalCookies);

          if (valid) {
            saveCookies(finalCookies);
            loginDetected = true;
            console.log(chalk.green.bold('\n🎉 Login successful! Cookies saved and validated.\n'));
            break;
          } else {
            console.log(chalk.yellow('   ⚠️  Cookies retrieved but API validation failed.'));
            console.log(chalk.yellow('   Will continue polling in case login is still in progress...\n'));
          }
        } else {
          console.log(chalk.yellow('   ⚠️  Could not retrieve cookies. Continuing to poll...\n'));
        }
      } else {
        console.log(chalk.gray('   Page fully changed but login not yet confirmed. Continuing to poll...\n'));
      }

      prevSnapshot = currSnapshot;
      pollSpinner.start(`[Poll #${poll}] Continuing to poll...`);
    }

    if (!loginDetected) {
      pollSpinner.fail(chalk.red('Polling timeout: login was not completed within the time limit.'));
      throw new Error('Login timeout: QR code was not scanned or login was not confirmed within 300 seconds.');
    }

    pollSpinner.succeed(chalk.green(`Login completed! ${finalCookies!.length} cookies saved to ${COOKIE_FILE}`));
    return finalCookies!;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (spinner.isSpinning) {
      spinner.fail(chalk.red(`Login failed: ${message}`));
    } else {
      console.error(chalk.red(`\n❌ Login failed: ${message}`));
    }
    throw err;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/**
 * Ensure we have valid cookies. If not, trigger QR code login.
 */
export async function ensureLogin(): Promise<CookieEntry[]> {
  let cookies = loadCookies();

  if (cookies && (await isCookieValid(cookies))) {
    return cookies;
  }

  console.log(chalk.yellow('⚠️  Cookie expired or not found. Starting QR code login...'));
  cookies = await loginWithQRCode();
  return cookies;
}

/**
 * Force re-login (clear existing cookies and start fresh).
 */
export async function forceReLogin(): Promise<CookieEntry[]> {
  if (fs.existsSync(COOKIE_FILE)) {
    fs.unlinkSync(COOKIE_FILE);
  }
  console.log(chalk.blue('🔄 Cleared existing cookies. Starting fresh login...'));
  return await loginWithQRCode();
}

// CLI entry
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--force')) {
    forceReLogin().catch(console.error);
  } else {
    ensureLogin()
      .then((cookies) => {
        console.log(chalk.green(`\n✅ Ready! ${cookies.length} cookies loaded.`));
      })
      .catch(console.error);
  }
}
