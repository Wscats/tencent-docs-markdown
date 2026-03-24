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
 * Opens a browser window for the user to scan the QR code with WeChat/QQ
 */
async function loginWithQRCode() {
  const spinner = ora('Launching browser for QR code login...').start();

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

    // Wait for QR code iframe to load
    spinner.text = 'Waiting for QR code to appear...';
    let qrIframe = null;
    try {
      await page.waitForSelector('iframe[src*="xlogin"], iframe[src*="weixin"]', { timeout: 15000 });
      await new Promise((resolve) => setTimeout(resolve, 3000));
      qrIframe = await page.$('iframe[src*="xlogin"], iframe[src*="weixin"]');
    } catch {
      // QR code may not need iframe detection
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    spinner.stop();
    console.log(chalk.yellow('\n📱 Please scan the QR code in the browser window to log in.'));
    console.log(chalk.gray('   Waiting for QR code to be scanned...\n'));

    // Phase 1: Wait for "扫描成功" (scan success) message to appear
    // This indicates the user has scanned the QR code but hasn't confirmed yet
    const scanSpinner = ora('Waiting for QR code scan...').start();
    let scanSuccessDetected = false;

    try {
      await page.waitForFunction(
        () => {
          // Check in the main page
          const bodyText = document.body.innerText || '';
          if (bodyText.includes('扫描成功') || bodyText.includes('扫码成功')) {
            return true;
          }
          // Check inside iframes (WeChat login iframe)
          const iframes = document.querySelectorAll('iframe');
          for (const iframe of iframes) {
            try {
              const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
              if (iframeDoc) {
                const iframeText = iframeDoc.body?.innerText || '';
                if (iframeText.includes('扫描成功') || iframeText.includes('扫码成功')) {
                  return true;
                }
              }
            } catch {
              // Cross-origin iframe, skip
            }
          }
          return false;
        },
        { timeout: 300000, polling: 1000 }
      );
      scanSuccessDetected = true;
      scanSpinner.succeed(chalk.green('QR code scanned! Waiting for WeChat confirmation...'));
    } catch {
      // If we can't detect scan success text, it might be a cross-origin iframe
      // Try to detect it via iframe content changes instead
      scanSpinner.text = 'Detecting scan status via QR code area...';

      if (qrIframe) {
        try {
          // Monitor the QR code iframe area for visual changes
          // When scanned, the QR code area content changes (shows success message)
          await page.waitForFunction(
            (iframeSelector) => {
              const iframe = document.querySelector(iframeSelector);
              if (!iframe) return false;
              const rect = iframe.getBoundingClientRect();
              // If iframe is hidden or removed, login may have completed
              if (rect.width === 0 || rect.height === 0) return true;
              // Check if the iframe src changed (indicates state change)
              const src = iframe.getAttribute('src') || '';
              if (src.includes('scanning') || src.includes('confirm')) return true;
              return false;
            },
            { timeout: 300000, polling: 1000 },
            'iframe[src*="xlogin"], iframe[src*="weixin"]'
          );
          scanSuccessDetected = true;
          scanSpinner.succeed(chalk.green('Scan detected! Waiting for WeChat confirmation...'));
        } catch {
          scanSpinner.info(chalk.yellow('Could not detect scan status, continuing to wait for login...'));
        }
      } else {
        scanSpinner.info(chalk.yellow('Could not detect scan status, continuing to wait for login...'));
      }
    }

    // Phase 2: Wait for user to confirm on WeChat (QR area turns white / login completes)
    // After scanning, the user needs to tap "允许" in WeChat
    const confirmSpinner = ora('Waiting for WeChat authorization (tap "允许" in WeChat)...').start();

    try {
      await page.waitForFunction(
        () => {
          // Check 1: TOK cookie present means login is complete
          if (document.cookie.includes('TOK=')) return true;

          // Check 2: URL changed to desktop (redirected after login)
          if (window.location.href.includes('/desktop') && !window.location.href.includes('login')) {
            const avatarEl = document.querySelector('[class*="avatar"], [class*="user-info"], [class*="header-user"]');
            if (avatarEl) return true;
          }

          // Check 3: QR code iframe disappeared or became hidden (login completed)
          const iframe = document.querySelector('iframe[src*="xlogin"], iframe[src*="weixin"]');
          if (!iframe) {
            // iframe removed means login flow completed
            const notLogged = document.querySelector('[class*="not-logged"], [class*="login-btn"]');
            if (!notLogged) return true;
          } else {
            const rect = iframe.getBoundingClientRect();
            // iframe became invisible (QR area turned white/empty)
            if (rect.width === 0 || rect.height === 0) return true;
          }

          // Check 4: Login dialog/modal disappeared
          const loginModal = document.querySelector('[class*="login-modal"], [class*="login-dialog"], [class*="login-panel"]');
          if (!loginModal) {
            // No login modal visible and we had one before
            const body = document.body.innerText || '';
            if (!body.includes('扫描') && !body.includes('登录') && document.querySelector('[class*="avatar"]')) {
              return true;
            }
          }

          return false;
        },
        { timeout: 300000, polling: 2000 }
      );
      confirmSpinner.succeed(chalk.green('WeChat authorization confirmed! Login completing...'));
    } catch (waitErr) {
      confirmSpinner.fail(chalk.red('Timeout waiting for WeChat authorization.'));
      throw new Error('Login timeout: WeChat authorization was not confirmed within the time limit.');
    }

    // Give extra time for all cookies to be set after login completes
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Collect all cookies
    const cookies = await page.cookies();

    if (cookies.length === 0) {
      throw new Error('No cookies obtained after login');
    }

    // Save cookies
    saveCookies(cookies);

    spinner.start('Verifying login status...');
    const valid = await isCookieValid(cookies);

    if (valid) {
      spinner.succeed(chalk.green('Login successful! Cookies saved.'));
    } else {
      spinner.warn(chalk.yellow('Cookies saved but validation uncertain. You may need to retry.'));
    }

    return cookies;
  } catch (err) {
    spinner.fail(chalk.red(`Login failed: ${err.message}`));
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
