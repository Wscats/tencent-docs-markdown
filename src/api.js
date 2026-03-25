/**
 * Tencent Docs Markdown Skill - API Module
 *
 * Provides all API operations for Tencent Docs Markdown:
 * - Create document
 * - Delete document
 * - Read document content
 * - Write/update document content
 * - Get document info
 */

const axios = require('axios');
const qs = require('querystring');
const { getCookieString, getXsrfToken } = require('./auth');

const BASE_URL = 'https://docs.qq.com';
const DEFAULT_DOMAIN_ID = '300000000';
const DOC_TYPE_MARKDOWN = 14;

/**
 * Create common HTTP headers for API requests
 */
function getHeaders(cookies) {
  return {
    Cookie: getCookieString(cookies),
    Referer: `${BASE_URL}/`,
    Origin: BASE_URL,
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
}

/**
 * Create a new Markdown document on Tencent Docs
 *
 * The real API uses query string parameters (not POST body).
 * Key params: create_type=1, doc_type=14, folder_id=/, hum=1
 *
 * @param {Array} cookies - Session cookies
 * @param {string} title - Document title
 * @param {string} [folderId='/'] - Target folder ID ('/' for root)
 * @returns {object} - { docUrl, padId, globalPadId }
 */
async function createDocument(cookies, title, folderId = '/') {
  const xsrf = getXsrfToken(cookies);
  const params = qs.stringify({
    create_type: 1,
    doc_type: DOC_TYPE_MARKDOWN,
    folder_id: folderId,
    title: title || 'Untitled',
    hum: 1,
    dont_add_recent: 0,
    xsrf,
  });

  const url = `${BASE_URL}/cgi-bin/online_docs/createdoc_new?${params}`;

  const resp = await axios.get(url, {
    headers: {
      ...getHeaders(cookies),
      Accept: 'application/json, text/plain, */*',
    },
    timeout: 30000,
  });

  const result = resp.data;
  if (result.retcode !== 0) {
    throw new Error(`Failed to create document: ${result.msg || `retcode=${result.retcode}`}`);
  }

  const padId = result.doc_id?.pad_id || result.docId?.pad_id || '';
  const docUrl = result.doc_url || result.docUrl || '';
  const globalPadId = result.global_pad_id || `${DEFAULT_DOMAIN_ID}${padId}`;

  return {
    docUrl: docUrl.startsWith('//') ? `https:${docUrl}` : docUrl,
    padId,
    globalPadId,
    title,
    raw: result,
  };
}

/**
 * Delete a Markdown document (move to trash)
 *
 * @param {Array} cookies - Session cookies
 * @param {string} padId - Document pad ID
 * @returns {object} - API response
 */
async function deleteDocument(cookies, padId) {
  const xsrf = getXsrfToken(cookies);
  const data = qs.stringify({
    domain_id: DEFAULT_DOMAIN_ID,
    pad_id: padId,
    list_type: 1,
    folder_id: '',
    xsrf,
  });

  const resp = await axios.post(`${BASE_URL}/cgi-bin/online_docs/doc_delete`, data, {
    headers: {
      ...getHeaders(cookies),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    timeout: 30000,
  });

  const result = resp.data;
  if (result.retcode !== 0) {
    throw new Error(`Failed to delete document: ${result.msg || `retcode=${result.retcode}`}`);
  }

  return result;
}

/**
 * Read Markdown document content
 *
 * @param {Array} cookies - Session cookies
 * @param {string} fileId - Global pad ID (e.g. "300000000$xxxxx")
 * @returns {string} - Markdown text content
 */
async function readDocument(cookies, fileId) {
  const xsrf = getXsrfToken(cookies);
  const url = `${BASE_URL}/api/markdown/read/data?xsrf=${xsrf}`;

  const resp = await axios.post(
    url,
    { file_id: fileId },
    {
      headers: {
        ...getHeaders(cookies),
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  const result = resp.data;
  if (result.retcode !== 0) {
    throw new Error(
      `Failed to read document: ${result.msg || result.error_msg || `retcode=${result.retcode}`}`
    );
  }

  return result.result?.mark_down || '';
}

/**
 * Write/update Markdown document content
 *
 * @param {Array} cookies - Session cookies
 * @param {string} fileId - Global pad ID (e.g. "300000000$xxxxx")
 * @param {string} markdownText - Markdown content to write
 * @returns {object} - API response
 */
async function writeDocument(cookies, fileId, markdownText) {
  const xsrf = getXsrfToken(cookies);
  const url = `${BASE_URL}/api/markdown/write/data?xsrf=${xsrf}`;

  const resp = await axios.post(
    url,
    {
      file_id: fileId,
      mark_down: markdownText,
    },
    {
      headers: {
        ...getHeaders(cookies),
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  const result = resp.data;
  if (result.retcode !== 0) {
    throw new Error(
      `Failed to write document: ${result.msg || result.error_msg || `retcode=${result.retcode}`}`
    );
  }

  return result;
}

/**
 * Get document metadata/info
 *
 * @param {Array} cookies - Session cookies
 * @param {string} docId - Document hash ID (from URL)
 * @returns {object} - Document info
 */
async function getDocumentInfo(cookies, docId) {
  const xsrf = getXsrfToken(cookies);
  const url = `${BASE_URL}/cgi-bin/online_docs/doc_info?xsrf=${xsrf}`;

  const resp = await axios.post(
    url,
    { file_id: docId },
    {
      headers: {
        ...getHeaders(cookies),
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  return resp.data;
}

/**
 * Rename a document
 *
 * @param {Array} cookies - Session cookies
 * @param {string} padId - Document pad ID
 * @param {string} newTitle - New document title
 * @returns {object} - API response
 */
async function renameDocument(cookies, padId, newTitle) {
  const xsrf = getXsrfToken(cookies);

  // The real API passes all parameters via URL query string
  const params = qs.stringify({
    pad_id: padId,
    domain_id: DEFAULT_DOMAIN_ID,
    xsrf,
    version: 2,
    auto_change: 0,
    title: newTitle,
  });

  const url = `${BASE_URL}/cgi-bin/online_docs/doc_changetitle?${params}`;

  // Body is an empty multipart/form-data (matching the real browser request)
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const body = `--${boundary}--\r\n`;

  const resp = await axios.post(url, body, {
    headers: {
      ...getHeaders(cookies),
      Accept: 'application/json, text/plain, */*',
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    timeout: 30000,
  });

  const result = resp.data;
  if (result.retcode !== 0 && result.ret !== 0) {
    throw new Error(`Failed to rename document: ${result.msg || `retcode=${result.retcode}`}`);
  }

  return result;
}

/**
 * Parse document URL to extract the URL hash identifier
 *
 * Note: The URL hash (e.g. "DSFdDdHBqa2ZESUNw") is NOT the real padId.
 * Use resolveRealPadId() to get the actual padId from the document page.
 *
 * @param {string} url - Tencent Docs Markdown URL (e.g. "https://docs.qq.com/markdown/xxxxx")
 * @returns {string} - Extracted URL hash identifier
 */
function parsePadIdFromUrl(url) {
  // Handle URLs like:
  // https://docs.qq.com/markdown/DQxxxxx
  // //docs.qq.com/markdown/DQxxxxx
  const match = url.match(/\/markdown\/([A-Za-z0-9]+)/);
  if (match) return match[1];

  // Handle other URL patterns
  const parts = url.split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

/**
 * Resolve the real padId by fetching the document page and parsing basicClientVars.
 *
 * The URL hash identifier (from parsePadIdFromUrl) differs from the actual padId
 * used by the read/write APIs. This function fetches the document HTML page and
 * extracts the real padId from the embedded basicClientVars JSON.
 *
 * @param {Array} cookies - Session cookies
 * @param {string} docUrl - Full Tencent Docs Markdown URL
 * @returns {object} - { padId, globalPadId, title }
 */
async function resolveRealPadId(cookies, docUrl) {
  // Security: Validate that docUrl targets an allowed hostname before attaching cookies
  const ALLOWED_DOC_HOSTNAMES = ['docs.qq.com'];
  try {
    const parsedDocUrl = new URL(docUrl);
    if (!ALLOWED_DOC_HOSTNAMES.includes(parsedDocUrl.hostname)) {
      throw new Error(
        `Security: Blocked cookie transmission to unauthorized hostname: ${parsedDocUrl.hostname}. Only docs.qq.com is allowed.`
      );
    }
  } catch (err) {
    if (err.message.startsWith('Security:')) throw err;
    throw new Error(`Invalid docUrl: ${docUrl}`);
  }

  const resp = await axios.get(docUrl, {
    headers: {
      ...getHeaders(cookies),
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    timeout: 30000,
    maxRedirects: 5,
  });

  const html = resp.data;

  // Extract base64-encoded basicClientVars from the page
  const match = html.match(/atob\('([^']+)'\)/);
  if (!match) {
    throw new Error('Cannot extract basicClientVars from document page');
  }

  const decoded = Buffer.from(match[1], 'base64').toString('utf-8');
  const clientVars = JSON.parse(decoded);

  const padInfo = clientVars?.docInfo?.padInfo;
  if (!padInfo || !padInfo.padId) {
    throw new Error('Cannot find padId in basicClientVars');
  }

  const padId = padInfo.padId;
  const domainId = padInfo.domainId || DEFAULT_DOMAIN_ID;
  const separator = '$';
  const globalPadId = domainId + separator + padId;
  const title = padInfo.padTitle || '';

  return { padId, globalPadId, title };
}

module.exports = {
  createDocument,
  deleteDocument,
  readDocument,
  writeDocument,
  getDocumentInfo,
  renameDocument,
  parsePadIdFromUrl,
  resolveRealPadId,
  BASE_URL,
  DEFAULT_DOMAIN_ID,
  DOC_TYPE_MARKDOWN,
};
