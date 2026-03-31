'use strict';

/**
 * Login with Polling Script
 *
 * Launches QR code login and polls every 10 seconds to check
 * whether cookies have been obtained and are valid.
 *
 * Usage: node src/login-with-polling.ts
 */

import * as fs from 'fs';
import { loadCookies, isCookieValid, loginWithQRCode, COOKIE_FILE } from './auth';

const POLL_INTERVAL = 10000; // 10 seconds
const MAX_POLLS = 18; // 18 * 10s = 180s max wait time

let pollCount = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let loginSucceeded = false;

/**
 * Start the auth login process by directly calling the exported function.
 */
function startLoginProcess(): void {
  console.log('🚀 Starting QR code login process...');
  console.log('   A browser window will open shortly. Please scan the QR code.\n');

  loginWithQRCode()
    .then(() => {
      loginSucceeded = true;
      console.log('\n✅ Login process completed successfully.');
    })
    .catch((err: Error) => {
      if (!loginSucceeded) {
        console.error(`❌ Login process failed: ${err.message}`);
      }
    });
}

/**
 * Poll to check if cookies have been obtained and are valid.
 */
async function pollCookieStatus(): Promise<void> {
  pollCount++;
  const elapsed = pollCount * (POLL_INTERVAL / 1000);

  console.log(`\n🔍 [Poll #${pollCount}] Checking cookie status... (${elapsed}s elapsed)`);

  // Step 1: Check if .cookies.json file exists
  if (!fs.existsSync(COOKIE_FILE)) {
    console.log('   📂 Cookie file not found yet. Waiting for QR scan...');
    if (pollCount >= MAX_POLLS) {
      console.log('\n⏰ Timeout: Maximum polling time (180s) reached.');
      console.log('   Please restart the login process and try again.');
      cleanup(1);
      return;
    }
    return;
  }

  // Step 2: Cookie file exists - try to load it
  const cookies = loadCookies();
  if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
    console.log('   📂 Cookie file exists but is empty or invalid. Waiting...');
    if (pollCount >= MAX_POLLS) {
      console.log('\n⏰ Timeout reached. Cookie file is not valid.');
      cleanup(1);
      return;
    }
    return;
  }

  console.log(`   📂 Cookie file found! Contains ${cookies.length} cookies.`);

  // Step 3: Validate cookies by calling the user_info API
  console.log('   🔐 Validating cookies against Tencent Docs API...');
  try {
    const valid = await isCookieValid(cookies);

    if (valid) {
      loginSucceeded = true;
      console.log('\n' + '='.repeat(60));
      console.log('🎉 LOGIN SUCCESSFUL!');
      console.log('='.repeat(60));
      console.log(`   ✅ Cookies are valid (${cookies.length} cookies loaded)`);
      console.log(`   📁 Cookie file: ${COOKIE_FILE}`);
      console.log('='.repeat(60));
      console.log('\n✅ You are now logged in and ready to use Tencent Docs Markdown!\n');
      cleanup(0);
      return;
    } else {
      console.log('   ⚠️  Cookies exist but validation failed. May still be logging in...');
      if (pollCount >= MAX_POLLS) {
        console.log('\n⏰ Timeout reached. Cookies could not be validated.');
        console.log('   Try running: node src/auth.ts --force');
        cleanup(1);
        return;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`   ❌ Validation error: ${message}`);
    if (pollCount >= MAX_POLLS) {
      cleanup(1);
      return;
    }
  }
}

/**
 * Cleanup and exit.
 */
function cleanup(exitCode: number = 0): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  process.exit(exitCode);
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('  Tencent Docs Markdown - Login with Polling');
  console.log('  Poll interval: 10s | Max wait: 180s');
  console.log('='.repeat(60));
  console.log('');

  // Check if already logged in
  const existingCookies = loadCookies();
  if (existingCookies) {
    console.log('🔍 Found existing cookies, validating...');
    const valid = await isCookieValid(existingCookies);
    if (valid) {
      console.log('✅ Already logged in! Cookies are valid.');
      console.log(`   ${existingCookies.length} cookies loaded from ${COOKIE_FILE}`);
      process.exit(0);
      return;
    }
    console.log('⚠️  Existing cookies are expired. Starting fresh login...\n');
  }

  // Start the login process
  startLoginProcess();

  // Start polling every 10 seconds
  console.log(`\n⏱️  Starting cookie polling (every ${POLL_INTERVAL / 1000}s)...\n`);

  pollTimer = setInterval(async () => {
    try {
      await pollCookieStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`   Polling error: ${message}`);
    }
  }, POLL_INTERVAL);

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\n🛑 Login cancelled by user.');
    cleanup(0);
  });

  process.on('SIGTERM', () => {
    cleanup(0);
  });
}

main().catch((err: Error) => {
  console.error(`Fatal error: ${err.message}`);
  cleanup(1);
});
