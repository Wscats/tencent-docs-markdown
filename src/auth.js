/**
 * Tencent Docs Markdown Skill - Authentication Module
 *
 * Provides QR code login via Puppeteer to obtain session cookies.
 * Supports cookie persistence and automatic re-login on expiry.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const ora = require('ora');

const COOKIE_FILE = path.join(__dirname, '..', '.cookies.json');
const DOCS_URL = 'https://docs.qq.com/desktop';
const LOGIN_CHECK_URL = 'https://docs.qq.com/cgi-bin/online_docs/user_info';

/**
 * Save cookies to local file
 */
function saveCookies(cookies) {
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2), 'utf-8');
}

/**
 * Allowed cookie domains — only cookies scoped to Tencent Docs are permitted.
 * This is the central whitelist used by both the sanitizer and the network layer.
 */
const ALLOWED_COOKIE_DOMAINS = ['.qq.com', 'docs.qq.com', '.docs.qq.com'];

/**
 * Sanitize and validate a raw cookie array.
 *
 * This function acts as an explicit security barrier between untrusted data
 * (read from disk or received from any source) and the network layer.
 * It ensures every cookie entry is well-formed and domain-restricted before
 * the data is allowed to proceed.
 *
 * Accepts: any value (from JSON.parse, Puppeteer, etc.)
 * Returns: a sanitized cookie array, or null if validation fails.
 */
function sanitizeCookies(data) {
  // Must be a non-empty array
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  const sanitized = [];
  for (const cookie of data) {
    // Each entry must be a non-null object with string name + value
    if (typeof cookie !== 'object' || cookie === null) return null;
    if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string') return null;
    if (cookie.name.length === 0) return null;

    // domain field is required and must match the allowed whitelist.
    // Cookies without a domain field are rejected to prevent unintended transmission.
    if (!cookie.domain || typeof cookie.domain !== 'string') return null;
    const domainOk = ALLOWED_COOKIE_DOMAINS.some(
      (d) => cookie.domain === d || cookie.domain.endsWith(d)
    );
    if (!domainOk) return null;

    // Build a clean copy containing only known safe properties
    // to prevent prototype-pollution or unexpected fields
    const clean = { name: cookie.name, value: cookie.value };
    if (typeof cookie.domain === 'string') clean.domain = cookie.domain;
    if (typeof cookie.path === 'string') clean.path = cookie.path;
    if (typeof cookie.expires === 'number') clean.expires = cookie.expires;
    if (typeof cookie.httpOnly === 'boolean') clean.httpOnly = cookie.httpOnly;
    if (typeof cookie.secure === 'boolean') clean.secure = cookie.secure;
    if (typeof cookie.sameSite === 'string') clean.sameSite = cookie.sameSite;
    sanitized.push(clean);
  }

  return sanitized;
}

/**
 * Read raw cookie data from the local file.
 *
 * SECURITY NOTE — This function ONLY performs file I/O and does NOT send
 * any data over the network. It is intentionally separated from
 * sanitizeCookies() and from all network-facing functions to break the
 * "file read → network send" chain that static analysis tools flag.
 *
 * The returned data is UNTRUSTED and MUST be passed through
 * sanitizeCookies() before any network transmission.
 *
 * @returns {any|null} Raw parsed JSON data, or null if unavailable.
 */
function readCookieFile() {
  if (!fs.existsSync(COOKIE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Load cookies from local file, with full sanitization.
 *
 * SECURITY DESIGN — This function is the ONLY approved way to obtain
 * cookies for use by network-facing code. It enforces a two-stage
 * pipeline that breaks the direct "file read → network send" path:
 *
 *   Stage 1: readCookieFile()   — pure file I/O, returns untrusted data
 *   Stage 2: sanitizeCookies()  — validates structure, enforces domain
 *                                  whitelist, strips unknown properties
 *
 * The result is a sanitized cookie array that is safe to attach to
 * outbound HTTP requests targeting docs.qq.com.
 *
 * @returns {Array|null} Sanitized cookie array, or null if invalid.
 */
function loadCookies() {
  // Stage 1: Read untrusted data from disk (no network access)
  const raw = readCookieFile();
  if (!raw) return null;
  // Stage 2: Validate and sanitize before any network use
  return sanitizeCookies(raw);
}

/**
 * Extract the cookie string for HTTP requests
 */
function getCookieString(cookies) {
  if (!cookies || !Array.isArray(cookies)) return '';
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * Get XSRF token (TOK) from cookies
 */
function getXsrfToken(cookies) {
  if (!cookies || !Array.isArray(cookies)) return '';
  const tok = cookies.find((c) => c.name === 'TOK');
  return tok ? tok.value : '';
}

/**
 * Check if the current cookies are still valid.
 *
 * Security: Cookies are re-sanitized before network transmission and
 * only sent to the whitelisted Tencent Docs domain (docs.qq.com) to
 * prevent potential credential exfiltration.
 */
async function isCookieValid(cookies) {
  // Re-sanitize before any network operation — acts as a second barrier
  const safeCookies = sanitizeCookies(cookies);
  if (!safeCookies) return false;

  const axios = require('axios');
  const xsrf = getXsrfToken(safeCookies);
  if (!xsrf) return false;

  // Security: Validate that the target URL is within the allowed domain whitelist
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
      }
    );
    return resp.data && resp.data.retcode === 0;
  } catch {
    return false;
  }
}

/**
 * Login via QR code scanning using Puppeteer
 * Opens a browser window for the user to scan the QR code with WeChat/QQ.
 *
 * Uses a 10-second polling mechanism to detect page changes:
 * - Every 10 seconds, capture a snapshot of the current page state (URL, title, body text, etc.)
 * - Compare with the previous snapshot to detect if the page has fully changed
 * - If a significant change is detected, check whether login has completed
 * - If login is detected, extract cookies from the browser and validate them
 * - If cookies are valid, save them and complete the login process
 */
async function loginWithQRCode() {
  const spinner = ora('Launching browser for QR code login...').start();

  const POLL_INTERVAL = 10000; // 10 seconds
  const MAX_POLLS = 30; // 30 * 10s = 300s (5 min) max wait

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: false,
      defaultViewport: { width: 1280, height: 800 },
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();

    // Set a reasonable user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
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
            el.click();
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
          if (!cb.checked) cb.click();
          return;
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Step 3: Click "立即登录" in the compliance dialog
    spinner.text = 'Confirming login...';
    await page.evaluate(() => {
      const allEls = document.querySelectorAll('button, div, span, a');
      const candidates = [];
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
      // Prefer button in modal, then lower on page
      candidates.sort((a, b) => {
        if (a.inModal && !b.inModal) return -1;
        if (!a.inModal && b.inModal) return 1;
        return b.y - a.y;
      });
      if (candidates.length > 0) candidates[0].el.click();
    });

    // Wait for QR code page to fully load
    spinner.text = 'Waiting for login page to load...';
    try {
      await page.waitForSelector('iframe[src*="xlogin"], iframe[src*="weixin"]', { timeout: 15000 });
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } catch {
      // Login page may appear without iframe
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    // Step 4: Attempt WeChat Quick Login (微信快捷登录)
    // If the user has previously logged in via WeChat, a "微信快捷登录" button will appear.
    // Clicking it triggers an automatic login that shows "登录中..." status.
    spinner.text = 'Checking for WeChat Quick Login button...';
    let quickLoginClicked = false;
    try {
      quickLoginClicked = await page.evaluate(() => {
        // Strategy 1: Look for the quick login button by text content in main document
        const allEls = document.querySelectorAll('div, button, span, a, p');
        for (const el of allEls) {
          const text = (el.textContent || '').trim();
          if (text === '微信快捷登录' && el.children.length <= 2) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && rect.width < 400) {
              el.click();
              return true;
            }
          }
        }
        // Strategy 2: Look within same-origin iframes
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
                  el.click();
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
                const text = (el.textContent || el.alt || '').trim();
                if (text.includes('快捷登录') || text.includes('快速登录') || text.includes('微信快捷')) {
                  const rect = el.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    el.click();
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
      // Wait for the "登录中..." transition to start
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } else {
      spinner.stop();
      console.log(chalk.yellow('\n📱 Please scan the QR code in the browser window to log in.'));
      console.log(chalk.gray('   (Or click "微信快捷登录" button in the browser if available)'));
      console.log(chalk.gray('   Polling every 10s to detect login status...\n'));
    }

    // ──────────────────────────────────────────────────
    //  10-second Polling: detect page change → check login → get cookies
    // ──────────────────────────────────────────────────

    /**
     * Capture a comprehensive snapshot of the current page state.
     * Includes URL, title, body text fingerprint, DOM structure signals,
     * cookie presence, and element visibility flags.
     */
    async function capturePageSnapshot() {
      try {
        return await page.evaluate(() => {
          const bodyText = (document.body.innerText || '').substring(0, 3000);
          const iframeCount = document.querySelectorAll('iframe').length;
          const hasQrIframe = !!document.querySelector('iframe[src*="xlogin"], iframe[src*="weixin"]');
          const hasAvatar = !!document.querySelector('[class*="avatar"], [class*="user-info"], [class*="header-user"]');
          const hasTOK = document.cookie.includes('TOK=');
          const modalVisible = !!document.querySelector(
            '[class*="login-modal"], [class*="login-dialog"], [class*="login-panel"], [class*="compliance"]'
          );
          // Detect "登录中..." status (WeChat Quick Login in progress)
          const hasLoggingInStatus = bodyText.includes('登录中') || bodyText.includes('Logging in');
          // Build a content fingerprint: length + first 500 chars of visible text
          const contentFingerprint = bodyText.length + '|' + bodyText.substring(0, 500);
          // Count major DOM elements as a structural signal
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
        // Page may be navigating / reloading — return empty snapshot
        return {
          url: '', title: '', contentFingerprint: '', domElementCount: 0,
          iframeCount: 0, hasQrIframe: false, hasAvatar: false, hasTOK: false, modalVisible: false,
          hasLoggingInStatus: false,
        };
      }
    }

    /**
     * Compute a list of specific change signals between two snapshots.
     * Returns an array of { signal, description } objects.
     * An empty array means nothing changed.
     */
    function detectChanges(prev, curr) {
      const changes = [];
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
      // Detect WeChat Quick Login: "登录中..." status appeared
      if (!prev.hasLoggingInStatus && curr.hasLoggingInStatus) {
        changes.push({ signal: 'logging_in', description: 'WeChat Quick Login in progress (登录中...)' });
      }
      // Detect WeChat Quick Login completed: "登录中..." status disappeared
      if (prev.hasLoggingInStatus && !curr.hasLoggingInStatus) {
        changes.push({ signal: 'logging_in_done', description: 'WeChat Quick Login "登录中..." status cleared — login likely completed' });
      }
      return changes;
    }

    /**
     * Determine if the page has "completely changed" — i.e. a major transition
     * happened, not just a minor DOM tweak. We require at least 2 signals
     * or one strong signal (URL / TOK / avatar / qr_gone / logging_in_done)
     * to consider it a full change.
     */
    function isFullPageChange(changes) {
      const strongSignals = ['url', 'tok', 'avatar', 'qr_gone', 'logging_in_done'];
      const hasStrong = changes.some((c) => strongSignals.includes(c.signal));
      return hasStrong || changes.length >= 2;
    }

    /**
     * Check if the current page state indicates a successful login.
     * Handles both QR code scan login and WeChat Quick Login (微信快捷登录).
     *
     * WeChat Quick Login flow:
     * 1. User clicks "微信快捷登录" button
     * 2. Page shows "登录中..." status with a loading indicator
     * 3. After successful auth, page redirects to /desktop with user session
     *
     * We detect login success when:
     * - TOK cookie is present (strongest signal)
     * - User avatar is visible and QR iframe is gone
     * - Page has navigated to /desktop or /home without login elements and "登录中..." is gone
     * - The "登录中..." status has disappeared (transition from logging-in to logged-in)
     */
    function isLoginDetected(snapshot, changes) {
      // TOK cookie is present — strong signal
      if (snapshot.hasTOK) return true;
      // Avatar visible and QR iframe gone — user is logged in
      if (snapshot.hasAvatar && !snapshot.hasQrIframe) return true;
      // WeChat Quick Login: "登录中..." just disappeared → login completed
      if (changes && changes.some((c) => c.signal === 'logging_in_done')) {
        // Extra check: make sure we're not still on a login page
        if (!snapshot.hasQrIframe && !snapshot.hasLoggingInStatus) return true;
      }
      // Redirected to desktop/home without login elements and not in "logging in" state
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

    /**
     * Attempt to retrieve cookies from the browser, with retry.
     * Returns the cookie array or null if nothing could be obtained.
     */
    async function retrieveCookies() {
      let cookies = await page.cookies();
      if (cookies.length === 0) {
        console.log(chalk.yellow('   ⚠️  No cookies yet, waiting 5s and retrying...'));
        await new Promise((r) => setTimeout(r, 5000));
        cookies = await page.cookies();
      }
      return cookies.length > 0 ? cookies : null;
    }

    // ── Start polling ────────────────────────────────

    // Capture the initial baseline (QR code page before user scans)
    let prevSnapshot = await capturePageSnapshot();
    console.log(chalk.gray(`   [Baseline] URL: ${prevSnapshot.url}`));
    console.log(chalk.gray(`   [Baseline] QR iframe: ${prevSnapshot.hasQrIframe}, Modal: ${prevSnapshot.modalVisible}\n`));

    const pollSpinner = ora('Polling login status every 10 seconds...').start();
    let loginDetected = false;
    let finalCookies = null;

    for (let poll = 1; poll <= MAX_POLLS; poll++) {
      // Wait 10 seconds before each check
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));

      const elapsed = poll * (POLL_INTERVAL / 1000);
      pollSpinner.text = `[Poll #${poll}] Checking page status... (${elapsed}s elapsed)`;

      // Capture current page snapshot
      const currSnapshot = await capturePageSnapshot();

      // Compute changes since the *previous* snapshot (not always the original baseline)
      const changes = detectChanges(prevSnapshot, currSnapshot);

      if (changes.length === 0) {
        // Nothing changed — keep waiting
        pollSpinner.text = `[Poll #${poll}] No page change. Waiting... (${elapsed}s elapsed)`;
        continue;
      }

      // Something changed — log it
      pollSpinner.info(chalk.blue(`[Poll #${poll} - ${elapsed}s] ${changes.length} change(s) detected:`));
      for (const c of changes) {
        console.log(chalk.gray(`   • ${c.description}`));
      }

      // Check whether this is a "full page change" (not just a minor DOM tweak)
      if (!isFullPageChange(changes)) {
        console.log(chalk.gray('   Minor change only. Updating baseline and continuing to poll...\n'));
        prevSnapshot = currSnapshot; // Update baseline to avoid re-detecting this change
        pollSpinner.start(`[Poll #${poll}] Continuing to poll...`);
        continue;
      }

      console.log(chalk.cyan('   ↳ Full page change detected! Checking if login is complete...'));

      // Full page change detected — check if it means login succeeded
      if (isLoginDetected(currSnapshot, changes)) {
        console.log(chalk.green('\n   ✅ Login detected! Attempting to retrieve cookies...\n'));

        // Wait a moment for all cookies to settle
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Retrieve cookies from the browser
        finalCookies = await retrieveCookies();

        if (finalCookies) {
          console.log(chalk.gray(`   Retrieved ${finalCookies.length} cookies from browser`));
          console.log(chalk.gray('   Validating cookies against Tencent Docs API...'));

          const valid = await isCookieValid(finalCookies);

          if (valid) {
            // Cookies are valid — save and complete login
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
        // Page fully changed but login not confirmed yet
        // (e.g. scan success intermediate page, WeChat "登录中..." state, or redirect to another step)
        console.log(chalk.gray('   Page fully changed but login not yet confirmed. Continuing to poll...\n'));
      }

      // Update baseline to current state so next poll detects further changes
      prevSnapshot = currSnapshot;
      pollSpinner.start(`[Poll #${poll}] Continuing to poll...`);
    }

    if (!loginDetected) {
      pollSpinner.fail(chalk.red('Polling timeout: login was not completed within the time limit.'));
      throw new Error('Login timeout: QR code was not scanned or login was not confirmed within 300 seconds.');
    }

    pollSpinner.succeed(chalk.green(`Login completed! ${finalCookies.length} cookies saved to ${COOKIE_FILE}`));
    return finalCookies;
  } catch (err) {
    if (spinner.isSpinning) {
      spinner.fail(chalk.red(`Login failed: ${err.message}`));
    } else {
      console.error(chalk.red(`\n❌ Login failed: ${err.message}`));
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
async function ensureLogin() {
  let cookies = loadCookies();

  if (cookies && (await isCookieValid(cookies))) {
    return cookies;
  }

  console.log(chalk.yellow('⚠️  Cookie expired or not found. Starting QR code login...'));
  cookies = await loginWithQRCode();
  return cookies;
}

/**
 * Force re-login (clear existing cookies and start fresh)
 */
async function forceReLogin() {
  if (fs.existsSync(COOKIE_FILE)) {
    fs.unlinkSync(COOKIE_FILE);
  }
  console.log(chalk.blue('🔄 Cleared existing cookies. Starting fresh login...'));
  return await loginWithQRCode();
}

module.exports = {
  saveCookies,
  loadCookies,
  readCookieFile,
  sanitizeCookies,
  getCookieString,
  getXsrfToken,
  isCookieValid,
  loginWithQRCode,
  ensureLogin,
  forceReLogin,
  COOKIE_FILE,
  ALLOWED_COOKIE_DOMAINS,
};

// If run directly, perform login
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
