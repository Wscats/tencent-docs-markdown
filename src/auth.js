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
 * Load cookies from local file
 */
function loadCookies() {
  if (fs.existsSync(COOKIE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
    } catch {
      return null;
    }
  }
  return null;
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
 * Check if the current cookies are still valid
 */
async function isCookieValid(cookies) {
  if (!cookies || !Array.isArray(cookies) || cookies.length === 0) return false;

  const axios = require('axios');
  const xsrf = getXsrfToken(cookies);
  if (!xsrf) return false;

  try {
    const resp = await axios.post(
      `${LOGIN_CHECK_URL}?xsrf=${xsrf}`,
      {},
      {
        headers: {
          Cookie: getCookieString(cookies),
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
    spinner.text = 'Waiting for QR code to appear...';
    try {
      await page.waitForSelector('iframe[src*="xlogin"], iframe[src*="weixin"]', { timeout: 15000 });
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } catch {
      // QR code may appear without iframe
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    spinner.stop();
    console.log(chalk.yellow('\n📱 Please scan the QR code in the browser window to log in.'));
    console.log(chalk.gray('   Polling every 10s to detect login status...\n'));

    // ──────────────────────────────────────────────────
    //  10-second Polling: detect page change → check login → get cookies
    // ──────────────────────────────────────────────────

    /**
     * Capture a snapshot of the current page state for comparison
     */
    async function capturePageSnapshot() {
      try {
        return await page.evaluate(() => {
          const bodyText = (document.body.innerText || '').substring(0, 2000);
          const iframeCount = document.querySelectorAll('iframe').length;
          const hasQrIframe = !!document.querySelector('iframe[src*="xlogin"], iframe[src*="weixin"]');
          const hasAvatar = !!document.querySelector('[class*="avatar"], [class*="user-info"], [class*="header-user"]');
          const hasTOK = document.cookie.includes('TOK=');
          const modalVisible = !!document.querySelector(
            '[class*="login-modal"], [class*="login-dialog"], [class*="login-panel"], [class*="compliance"]'
          );
          return {
            url: window.location.href,
            title: document.title,
            bodyTextHash: bodyText.length + ':' + bodyText.substring(0, 200),
            iframeCount,
            hasQrIframe,
            hasAvatar,
            hasTOK,
            modalVisible,
          };
        });
      } catch {
        // Page may be navigating
        return { url: '', title: '', bodyTextHash: '', iframeCount: 0, hasQrIframe: false, hasAvatar: false, hasTOK: false, modalVisible: false };
      }
    }

    /**
     * Determine if the page has significantly changed compared to the baseline
     */
    function hasPageChanged(baseline, current) {
      // URL changed (e.g., redirected after login)
      if (baseline.url !== current.url) return true;
      // Title changed significantly
      if (baseline.title !== current.title) return true;
      // QR code iframe disappeared (login completed)
      if (baseline.hasQrIframe && !current.hasQrIframe) return true;
      // Avatar appeared (user logged in)
      if (!baseline.hasAvatar && current.hasAvatar) return true;
      // TOK cookie appeared
      if (!baseline.hasTOK && current.hasTOK) return true;
      // Login modal disappeared
      if (baseline.modalVisible && !current.modalVisible) return true;
      // Body text changed significantly (page content fully changed)
      if (baseline.bodyTextHash !== current.bodyTextHash) return true;
      return false;
    }

    /**
     * Check if the current page state indicates a successful login
     */
    function isLoginDetected(snapshot) {
      // TOK cookie is present — strong signal
      if (snapshot.hasTOK) return true;
      // Avatar visible and QR iframe gone — user is logged in
      if (snapshot.hasAvatar && !snapshot.hasQrIframe) return true;
      // Redirected to desktop without login elements
      if (snapshot.url.includes('/desktop') && !snapshot.hasQrIframe && !snapshot.modalVisible) return true;
      return false;
    }

    // Capture baseline snapshot (the QR code page before scanning)
    const baselineSnapshot = await capturePageSnapshot();
    console.log(chalk.gray(`   [Baseline] URL: ${baselineSnapshot.url}`));
    console.log(chalk.gray(`   [Baseline] QR iframe: ${baselineSnapshot.hasQrIframe}, Modal: ${baselineSnapshot.modalVisible}\n`));

    const pollSpinner = ora('Polling login status every 10 seconds...').start();
    let loginDetected = false;
    let finalCookies = null;

    for (let poll = 1; poll <= MAX_POLLS; poll++) {
      // Wait 10 seconds
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));

      const elapsed = poll * (POLL_INTERVAL / 1000);
      pollSpinner.text = `[Poll #${poll}] Checking page status... (${elapsed}s elapsed)`;

      // Capture current page snapshot
      const currentSnapshot = await capturePageSnapshot();

      // Check if page has changed
      const changed = hasPageChanged(baselineSnapshot, currentSnapshot);

      if (changed) {
        pollSpinner.info(
          chalk.blue(`[Poll #${poll} - ${elapsed}s] Page change detected!`)
        );

        // Log what changed
        if (baselineSnapshot.url !== currentSnapshot.url) {
          console.log(chalk.gray(`   URL: ${baselineSnapshot.url} → ${currentSnapshot.url}`));
        }
        if (baselineSnapshot.hasQrIframe && !currentSnapshot.hasQrIframe) {
          console.log(chalk.gray('   QR code iframe disappeared'));
        }
        if (!baselineSnapshot.hasAvatar && currentSnapshot.hasAvatar) {
          console.log(chalk.gray('   User avatar appeared'));
        }
        if (!baselineSnapshot.hasTOK && currentSnapshot.hasTOK) {
          console.log(chalk.gray('   TOK cookie detected'));
        }
        if (baselineSnapshot.bodyTextHash !== currentSnapshot.bodyTextHash) {
          console.log(chalk.gray('   Page content changed'));
        }

        // Check if the change indicates login success
        if (isLoginDetected(currentSnapshot)) {
          console.log(chalk.green('\n   ✅ Login detected! Attempting to retrieve cookies...\n'));

          // Give a little extra time for all cookies to settle
          await new Promise((resolve) => setTimeout(resolve, 3000));

          // Retrieve cookies from the browser page
          const cookies = await page.cookies();

          if (cookies.length === 0) {
            console.log(chalk.yellow('   ⚠️  No cookies retrieved yet, waiting a bit longer...'));
            await new Promise((resolve) => setTimeout(resolve, 5000));
            const retryCookies = await page.cookies();
            if (retryCookies.length > 0) {
              finalCookies = retryCookies;
            }
          } else {
            finalCookies = cookies;
          }

          if (finalCookies && finalCookies.length > 0) {
            console.log(chalk.gray(`   Retrieved ${finalCookies.length} cookies from browser`));

            // Validate cookies by calling the API
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
              pollSpinner.start(`[Poll #${poll}] Continuing to poll...`);
            }
          } else {
            console.log(chalk.yellow('   ⚠️  Could not retrieve cookies. Continuing to poll...\n'));
            pollSpinner.start(`[Poll #${poll}] Continuing to poll...`);
          }
        } else {
          // Page changed but not a full login yet (e.g. scan success, intermediate state)
          console.log(chalk.gray('   Page changed but login not yet complete. Continuing to poll...\n'));
          pollSpinner.start(`[Poll #${poll}] Continuing to poll...`);
        }
      } else {
        // No change detected, just update spinner
        pollSpinner.text = `[Poll #${poll}] No page change detected. Waiting... (${elapsed}s elapsed)`;
      }
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
  getCookieString,
  getXsrfToken,
  isCookieValid,
  loginWithQRCode,
  ensureLogin,
  forceReLogin,
  COOKIE_FILE,
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
