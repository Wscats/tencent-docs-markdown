'use strict';

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

import axios from 'axios';
import * as qs from 'querystring';
import { getCookieString, getXsrfToken } from './auth';
import type { CookieEntry } from './auth';

export const BASE_URL = 'https://docs.qq.com';
export const DEFAULT_DOMAIN_ID = '300000000';
export const DOC_TYPE_MARKDOWN = 14;

/** Result returned by createDocument. */
export interface CreateDocumentResult {
  docUrl: string;
  padId: string;
  globalPadId: string;
  title: string;
  raw: Record<string, unknown>;
}

/** Result returned by resolveRealPadId. */
export interface ResolvedPadInfo {
  padId: string;
  globalPadId: string;
  title: string;
}

/** Common API response shape. */
interface ApiResponse {
  retcode: number;
  ret?: number;
  msg?: string;
  error_msg?: string;
  doc_id?: { pad_id?: string };
  docId?: { pad_id?: string };
  doc_url?: string;
  docUrl?: string;
  global_pad_id?: string;
  result?: { mark_down?: string };
}

/**
 * Create common HTTP headers for API requests.
 */
function getHeaders(cookies: CookieEntry[]): Record<string, string> {
  return {
    Cookie: getCookieString(cookies),
    Referer: `${BASE_URL}/`,
    Origin: BASE_URL,
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
}

/**
 * Create a new Markdown document on Tencent Docs.
 *
 * @param cookies - Session cookies
 * @param title - Document title
 * @param folderId - Target folder ID ('/' for root)
 */
export async function createDocument(
  cookies: CookieEntry[],
  title: string,
  folderId: string = '/',
): Promise<CreateDocumentResult> {
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

  const resp = await axios.get<ApiResponse>(url, {
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
    raw: result as unknown as Record<string, unknown>,
  };
}

/**
 * Delete a Markdown document (move to trash).
 *
 * @param cookies - Session cookies
 * @param padId - Document pad ID
 */
export async function deleteDocument(cookies: CookieEntry[], padId: string): Promise<ApiResponse> {
  const xsrf = getXsrfToken(cookies);
  const data = qs.stringify({
    domain_id: DEFAULT_DOMAIN_ID,
    pad_id: padId,
    list_type: 1,
    folder_id: '',
    xsrf,
  });

  const resp = await axios.post<ApiResponse>(`${BASE_URL}/cgi-bin/online_docs/doc_delete`, data, {
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
 * Read Markdown document content.
 *
 * @param cookies - Session cookies
 * @param fileId - Global pad ID (e.g. "300000000$xxxxx")
 */
export async function readDocument(cookies: CookieEntry[], fileId: string): Promise<string> {
  const xsrf = getXsrfToken(cookies);
  const url = `${BASE_URL}/api/markdown/read/data?xsrf=${xsrf}`;

  const resp = await axios.post<ApiResponse>(
    url,
    { file_id: fileId },
    {
      headers: {
        ...getHeaders(cookies),
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    },
  );

  const result = resp.data;
  if (result.retcode !== 0) {
    throw new Error(
      `Failed to read document: ${result.msg || result.error_msg || `retcode=${result.retcode}`}`,
    );
  }

  return result.result?.mark_down || '';
}

/**
 * Write/update Markdown document content.
 *
 * @param cookies - Session cookies
 * @param fileId - Global pad ID (e.g. "300000000$xxxxx")
 * @param markdownText - Markdown content to write
 */
export async function writeDocument(
  cookies: CookieEntry[],
  fileId: string,
  markdownText: string,
): Promise<ApiResponse> {
  const xsrf = getXsrfToken(cookies);
  const url = `${BASE_URL}/api/markdown/write/data?xsrf=${xsrf}`;

  const resp = await axios.post<ApiResponse>(
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
    },
  );

  const result = resp.data;
  if (result.retcode !== 0) {
    throw new Error(
      `Failed to write document: ${result.msg || result.error_msg || `retcode=${result.retcode}`}`,
    );
  }

  return result;
}

/**
 * Get document metadata/info.
 *
 * @param cookies - Session cookies
 * @param docId - Document hash ID (from URL)
 */
export async function getDocumentInfo(
  cookies: CookieEntry[],
  docId: string,
): Promise<Record<string, unknown>> {
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
    },
  );

  return resp.data as Record<string, unknown>;
}

/**
 * Rename a document.
 *
 * @param cookies - Session cookies
 * @param padId - Document pad ID
 * @param newTitle - New document title
 */
export async function renameDocument(
  cookies: CookieEntry[],
  padId: string,
  newTitle: string,
): Promise<ApiResponse> {
  const xsrf = getXsrfToken(cookies);

  const params = qs.stringify({
    pad_id: padId,
    domain_id: DEFAULT_DOMAIN_ID,
    xsrf,
    version: 2,
    auto_change: 0,
    title: newTitle,
  });

  const url = `${BASE_URL}/cgi-bin/online_docs/doc_changetitle?${params}`;

  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const body = `--${boundary}--\r\n`;

  const resp = await axios.post<ApiResponse>(url, body, {
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
 * Parse document URL to extract the URL hash identifier.
 *
 * Note: The URL hash (e.g. "DSFdDdHBqa2ZESUNw") is NOT the real padId.
 * Use resolveRealPadId() to get the actual padId from the document page.
 *
 * @param url - Tencent Docs Markdown URL
 */
export function parsePadIdFromUrl(url: string): string {
  const match = url.match(/\/markdown\/([A-Za-z0-9]+)/);
  if (match) return match[1]!;

  const parts = url.split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

/**
 * Resolve the real padId by fetching the document page and parsing basicClientVars.
 *
 * @param cookies - Session cookies
 * @param docUrl - Full Tencent Docs Markdown URL
 */
export async function resolveRealPadId(
  cookies: CookieEntry[],
  docUrl: string,
): Promise<ResolvedPadInfo> {
  // Security: Validate that docUrl targets an allowed hostname
  const ALLOWED_DOC_HOSTNAMES = ['docs.qq.com'];
  try {
    const parsedDocUrl = new URL(docUrl);
    if (!ALLOWED_DOC_HOSTNAMES.includes(parsedDocUrl.hostname)) {
      throw new Error(
        `Security: Blocked cookie transmission to unauthorized hostname: ${parsedDocUrl.hostname}. Only docs.qq.com is allowed.`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Security:')) throw err;
    throw new Error(`Invalid docUrl: ${docUrl}`);
  }

  const resp = await axios.get<string>(docUrl, {
    headers: {
      ...getHeaders(cookies),
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    timeout: 30000,
    maxRedirects: 5,
  });

  const html = resp.data;

  const match = html.match(/atob\('([^']+)'\)/);
  if (!match) {
    throw new Error('Cannot extract basicClientVars from document page');
  }

  const decoded = Buffer.from(match[1]!, 'base64').toString('utf-8');
  const clientVars = JSON.parse(decoded) as Record<string, any>;

  const padInfo = clientVars?.docInfo?.padInfo;
  if (!padInfo || !padInfo.padId) {
    throw new Error('Cannot find padId in basicClientVars');
  }

  const padId: string = padInfo.padId;
  const domainId: string = padInfo.domainId || DEFAULT_DOMAIN_ID;
  const separator = '$';
  const globalPadId = domainId + separator + padId;
  const title: string = padInfo.padTitle || '';

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
