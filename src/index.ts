'use strict';

/**
 * Tencent Docs Markdown Skill - Main Entry
 *
 * This is the main entry point that provides natural language command processing
 * for Tencent Docs Markdown operations.
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { ensureLogin, forceReLogin } from './auth';
import type { CookieEntry } from './auth';
import {
  createDocument,
  deleteDocument,
  readDocument,
  writeDocument,
  getDocumentInfo,
  renameDocument,
  parsePadIdFromUrl,
  resolveRealPadId,
} from './api';
import type { CreateDocumentResult, ResolvedPadInfo } from './api';

/**
 * Create a new Markdown document.
 *
 * @param title - Document title
 * @param content - Optional initial content
 */
async function handleCreate(title: string, content?: string): Promise<CreateDocumentResult> {
  const spinner = ora('Creating Markdown document...').start();
  try {
    const cookies = await ensureLogin();
    const result = await createDocument(cookies, title);
    spinner.succeed(chalk.green(`Document created: ${result.title}`));
    console.log(chalk.cyan(`  📄 URL: ${result.docUrl}`));
    console.log(chalk.gray(`  🆔 Pad ID: ${result.padId}`));

    if (content) {
      spinner.start('Writing content...');
      await writeDocument(cookies, result.globalPadId, content);
      spinner.succeed(chalk.green('Content written successfully.'));
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    spinner.fail(chalk.red(`Create failed: ${message}`));
    throw err;
  }
}

/**
 * Create a new Tencent Docs Markdown document and write content to it.
 *
 * @param title - Document title
 * @param content - Markdown content to write
 */
async function handleCreateAndWrite(title: string, content: string): Promise<CreateDocumentResult> {
  const spinner = ora('Creating Markdown document on Tencent Docs...').start();
  try {
    if (!title) {
      throw new Error('Document title is required');
    }
    if (!content) {
      throw new Error('Markdown content is required');
    }

    const cookies = await ensureLogin();

    spinner.text = 'Creating document...';
    const result = await createDocument(cookies, title);

    spinner.text = 'Writing Markdown content...';
    await writeDocument(cookies, result.globalPadId, content);

    spinner.succeed(chalk.green(`Document created and content written: ${title}`));
    console.log(chalk.cyan(`  📄 URL: ${result.docUrl}`));
    console.log(chalk.gray(`  🆔 Pad ID: ${result.padId}`));

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    spinner.fail(chalk.red(`Create and write failed: ${message}`));
    throw err;
  }
}

/** Result of a download operation. */
interface DownloadResult {
  path: string;
  content: string;
}

/**
 * Download a Tencent Docs Markdown document to local file.
 *
 * @param docUrl - Tencent Docs URL
 * @param outputPath - Optional output file path
 */
async function handleDownload(docUrl: string, outputPath?: string): Promise<DownloadResult> {
  const spinner = ora('Downloading Markdown document...').start();
  try {
    const cookies = await ensureLogin();

    spinner.text = 'Resolving document ID...';
    const docMeta = await resolveRealPadId(cookies, docUrl);
    const { globalPadId, title: docTitle, padId } = docMeta;

    spinner.text = 'Reading document content...';
    const content = await readDocument(cookies, globalPadId);

    let savePath = outputPath;
    if (!savePath) {
      const title = docTitle || padId;
      savePath = `${title.replace(/[/\\?%*:|"<>]/g, '_')}.md`;
    }

    if (!savePath.endsWith('.md')) {
      savePath += '.md';
    }

    const resolvedPath = path.resolve(savePath);
    fs.writeFileSync(resolvedPath, content, 'utf-8');

    spinner.succeed(chalk.green(`Downloaded to: ${resolvedPath}`));
    console.log(chalk.gray(`  📦 Size: ${Buffer.byteLength(content, 'utf-8')} bytes`));

    return { path: resolvedPath, content };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    spinner.fail(chalk.red(`Download failed: ${message}`));
    throw err;
  }
}

/** Result of a delete operation. */
interface DeleteResult {
  padId: string;
  deleted: boolean;
}

/**
 * Delete a Tencent Docs Markdown document.
 *
 * @param docUrl - Tencent Docs URL
 */
async function handleDelete(docUrl: string): Promise<DeleteResult> {
  const spinner = ora('Deleting Markdown document...').start();
  try {
    const cookies = await ensureLogin();

    spinner.text = 'Resolving document ID...';
    const docMeta = await resolveRealPadId(cookies, docUrl);
    const { padId } = docMeta;

    if (!padId) {
      throw new Error(`Cannot resolve real pad ID from URL: ${docUrl}`);
    }

    await deleteDocument(cookies, padId);

    spinner.succeed(chalk.green(`Document deleted (moved to trash): ${padId}`));
    return { padId, deleted: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    spinner.fail(chalk.red(`Delete failed: ${message}`));
    throw err;
  }
}

/**
 * Read and display document content.
 *
 * @param docUrl - Tencent Docs URL
 */
async function handleRead(docUrl: string): Promise<string> {
  const spinner = ora('Reading Markdown document...').start();
  try {
    const cookies = await ensureLogin();

    spinner.text = 'Resolving document ID...';
    const docMeta = await resolveRealPadId(cookies, docUrl);
    const { globalPadId } = docMeta;

    const content = await readDocument(cookies, globalPadId);

    spinner.succeed(chalk.green('Document content retrieved.'));
    console.log(chalk.gray('─'.repeat(60)));
    console.log(content);
    console.log(chalk.gray('─'.repeat(60)));

    return content;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    spinner.fail(chalk.red(`Read failed: ${message}`));
    throw err;
  }
}

/** Result of an update operation. */
interface UpdateResult {
  padId: string;
  updated: boolean;
}

/**
 * Update document content from a local file or text.
 *
 * @param docUrl - Tencent Docs URL
 * @param contentOrPath - Markdown content or path to .md file
 */
async function handleUpdate(docUrl: string, contentOrPath: string): Promise<UpdateResult> {
  const spinner = ora('Updating Markdown document...').start();
  try {
    const cookies = await ensureLogin();

    spinner.text = 'Resolving document ID...';
    const docMeta = await resolveRealPadId(cookies, docUrl);
    const { globalPadId, padId } = docMeta;

    let content = contentOrPath;
    const resolvedPath = path.resolve(contentOrPath);
    if (fs.existsSync(resolvedPath) && resolvedPath.endsWith('.md')) {
      content = fs.readFileSync(resolvedPath, 'utf-8');
      spinner.text = `Updating from file: ${resolvedPath}`;
    }

    await writeDocument(cookies, globalPadId, content);

    spinner.succeed(chalk.green('Document updated successfully.'));
    return { padId, updated: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    spinner.fail(chalk.red(`Update failed: ${message}`));
    throw err;
  }
}

/** Result of a rename operation. */
interface RenameResult {
  padId: string;
  newTitle: string;
  raw: Record<string, unknown>;
}

/**
 * Rename a document.
 *
 * @param docUrl - Tencent Docs URL
 * @param newTitle - New title
 */
async function handleRename(docUrl: string, newTitle: string): Promise<RenameResult> {
  const spinner = ora('Renaming document...').start();
  try {
    const cookies = await ensureLogin();

    spinner.text = 'Resolving document ID...';
    const docMeta = await resolveRealPadId(cookies, docUrl);
    const { padId } = docMeta;

    if (!padId) {
      throw new Error(`Cannot resolve real pad ID from URL: ${docUrl}`);
    }

    const result = await renameDocument(cookies, padId, newTitle);

    spinner.succeed(chalk.green(`Document renamed to: ${newTitle}`));
    return { padId, newTitle, raw: result as unknown as Record<string, unknown> };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    spinner.fail(chalk.red(`Rename failed: ${message}`));
    throw err;
  }
}

/**
 * Get document information.
 *
 * @param docUrl - Tencent Docs URL
 */
async function handleInfo(docUrl: string): Promise<Record<string, unknown>> {
  const spinner = ora('Getting document info...').start();
  try {
    const cookies = await ensureLogin();
    const padId = parsePadIdFromUrl(docUrl);

    if (!padId) {
      throw new Error(`Cannot parse document ID from URL: ${docUrl}`);
    }

    const info = await getDocumentInfo(cookies, padId);
    spinner.succeed(chalk.green('Document info retrieved.'));
    console.log(JSON.stringify(info, null, 2));
    return info;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    spinner.fail(chalk.red(`Info failed: ${message}`));
    throw err;
  }
}

/**
 * Login / re-login.
 */
async function handleLogin(force: boolean = false): Promise<void> {
  if (force) {
    await forceReLogin();
  } else {
    await ensureLogin();
  }
}

// Export all handlers
export {
  handleCreate,
  handleCreateAndWrite,
  handleDownload,
  handleDelete,
  handleRead,
  handleUpdate,
  handleRename,
  handleInfo,
  handleLogin,
};

// CLI entry
if (require.main === module) {
  const { program } = require('commander') as typeof import('commander');

  program
    .name('tencent-docs-markdown')
    .description('Tencent Docs Markdown CLI Tool')
    .version('1.0.0');

  program
    .command('login')
    .description('Login via QR code scanning')
    .option('--force', 'Force re-login (clear existing cookies)')
    .action((opts: { force?: boolean }) => handleLogin(opts.force).catch(console.error));

  program
    .command('create <title>')
    .description('Create a new Markdown document')
    .option('-c, --content <text>', 'Initial Markdown content')
    .action((title: string, opts: { content?: string }) => handleCreate(title, opts.content).catch(console.error));

  program
    .command('write <title> <content>')
    .description('Create a new Tencent Docs Markdown and write content to it')
    .action((title: string, content: string) => handleCreateAndWrite(title, content).catch(console.error));

  program
    .command('download <url>')
    .description('Download a Tencent Docs Markdown document to local')
    .option('-o, --output <path>', 'Output file path')
    .action((url: string, opts: { output?: string }) => handleDownload(url, opts.output).catch(console.error));

  program
    .command('delete <url>')
    .description('Delete a Tencent Docs Markdown document')
    .action((url: string) => handleDelete(url).catch(console.error));

  program
    .command('read <url>')
    .description('Read and display document content')
    .action((url: string) => handleRead(url).catch(console.error));

  program
    .command('update <url> <content>')
    .description('Update document content (text or .md file path)')
    .action((url: string, content: string) => handleUpdate(url, content).catch(console.error));

  program
    .command('rename <url> <title>')
    .description('Rename a document')
    .action((url: string, title: string) => handleRename(url, title).catch(console.error));

  program
    .command('info <url>')
    .description('Get document information')
    .action((url: string) => handleInfo(url).catch(console.error));

  program.parse();
}
