/**
 * Tencent Docs Markdown Skill - Main Entry
 *
 * This is the main entry point that provides natural language command processing
 * for Tencent Docs Markdown operations.
 */

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const ora = require('ora');
const { ensureLogin, forceReLogin } = require('./auth');
const {
  createDocument,
  deleteDocument,
  readDocument,
  writeDocument,
  getDocumentInfo,
  renameDocument,
  parsePadIdFromUrl,
  resolveRealPadId,
  DEFAULT_DOMAIN_ID,
} = require('./api');

/**
 * Create a new Markdown document
 *
 * @param {string} title - Document title
 * @param {string} [content] - Optional initial content
 */
async function handleCreate(title, content) {
  const spinner = ora('Creating Markdown document...').start();
  try {
    const cookies = await ensureLogin();
    const result = await createDocument(cookies, title);
    spinner.succeed(chalk.green(`Document created: ${result.title}`));
    console.log(chalk.cyan(`  📄 URL: ${result.docUrl}`));
    console.log(chalk.gray(`  🆔 Pad ID: ${result.padId}`));

    // If content is provided, write it to the document
    if (content) {
      spinner.start('Writing content...');
      await writeDocument(cookies, result.globalPadId, content);
      spinner.succeed(chalk.green('Content written successfully.'));
    }

    return result;
  } catch (err) {
    spinner.fail(chalk.red(`Create failed: ${err.message}`));
    throw err;
  }
}

/**
 * Create a new Tencent Docs Markdown document and write content to it
 *
 * @param {string} title - Document title
 * @param {string} content - Markdown content to write
 * @returns {Promise<{docUrl: string, padId: string, globalPadId: string, title: string}>}
 */
async function handleCreateAndWrite(title, content) {
  const spinner = ora('Creating Markdown document on Tencent Docs...').start();
  try {
    if (!title) {
      throw new Error('Document title is required');
    }
    if (!content) {
      throw new Error('Markdown content is required');
    }

    const cookies = await ensureLogin();

    // Step 1: Create a new Markdown document
    spinner.text = 'Creating document...';
    const result = await createDocument(cookies, title);

    // Step 2: Write Markdown content to the document
    spinner.text = 'Writing Markdown content...';
    await writeDocument(cookies, result.globalPadId, content);

    spinner.succeed(chalk.green(`Document created and content written: ${title}`));
    console.log(chalk.cyan(`  📄 URL: ${result.docUrl}`));
    console.log(chalk.gray(`  🆔 Pad ID: ${result.padId}`));

    return result;
  } catch (err) {
    spinner.fail(chalk.red(`Create and write failed: ${err.message}`));
    throw err;
  }
}

/**
 * Download a Tencent Docs Markdown document to local file
 *
 * @param {string} docUrl - Tencent Docs URL
 * @param {string} [outputPath] - Optional output file path
 */
async function handleDownload(docUrl, outputPath) {
  const spinner = ora('Downloading Markdown document...').start();
  try {
    const cookies = await ensureLogin();

    // Resolve the real padId from the document page
    // (URL hash identifier differs from the actual padId used by APIs)
    spinner.text = 'Resolving document ID...';
    const docMeta = await resolveRealPadId(cookies, docUrl);
    const { globalPadId, title: docTitle, padId } = docMeta;

    // Read content
    spinner.text = 'Reading document content...';
    const content = await readDocument(cookies, globalPadId);

    // Determine output path
    let savePath = outputPath;
    if (!savePath) {
      const title = docTitle || padId;
      savePath = `${title.replace(/[/\\?%*:|"<>]/g, '_')}.md`;
    }

    // Ensure .md extension
    if (!savePath.endsWith('.md')) {
      savePath += '.md';
    }

    const resolvedPath = path.resolve(savePath);
    fs.writeFileSync(resolvedPath, content, 'utf-8');

    spinner.succeed(chalk.green(`Downloaded to: ${resolvedPath}`));
    console.log(chalk.gray(`  📦 Size: ${Buffer.byteLength(content, 'utf-8')} bytes`));

    return { path: resolvedPath, content };
  } catch (err) {
    spinner.fail(chalk.red(`Download failed: ${err.message}`));
    throw err;
  }
}

/**
 * Delete a Tencent Docs Markdown document
 *
 * @param {string} docUrl - Tencent Docs URL
 */
async function handleDelete(docUrl) {
  const spinner = ora('Deleting Markdown document...').start();
  try {
    const cookies = await ensureLogin();

    // Resolve the real padId from the document page
    // (URL hash like "DSFdDdHBqa2ZESUNw" differs from the actual padId)
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
    spinner.fail(chalk.red(`Delete failed: ${err.message}`));
    throw err;
  }
}

/**
 * Read and display document content
 *
 * @param {string} docUrl - Tencent Docs URL
 */
async function handleRead(docUrl) {
  const spinner = ora('Reading Markdown document...').start();
  try {
    const cookies = await ensureLogin();

    // Resolve the real padId from the document page
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
    spinner.fail(chalk.red(`Read failed: ${err.message}`));
    throw err;
  }
}

/**
 * Update document content from a local file or text
 *
 * @param {string} docUrl - Tencent Docs URL
 * @param {string} contentOrPath - Markdown content or path to .md file
 */
async function handleUpdate(docUrl, contentOrPath) {
  const spinner = ora('Updating Markdown document...').start();
  try {
    const cookies = await ensureLogin();

    // Resolve the real padId from the document page
    spinner.text = 'Resolving document ID...';
    const docMeta = await resolveRealPadId(cookies, docUrl);
    const { globalPadId, padId } = docMeta;

    // Determine if contentOrPath is a file path or direct content
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
    spinner.fail(chalk.red(`Update failed: ${err.message}`));
    throw err;
  }
}

/**
 * Rename a document
 *
 * @param {string} docUrl - Tencent Docs URL
 * @param {string} newTitle - New title
 */
async function handleRename(docUrl, newTitle) {
  const spinner = ora('Renaming document...').start();
  try {
    const cookies = await ensureLogin();

    // Resolve the real padId from the document page
    // (URL hash like "DSFdDdHBqa2ZESUNw" differs from the actual padId)
    spinner.text = 'Resolving document ID...';
    const docMeta = await resolveRealPadId(cookies, docUrl);
    const { padId } = docMeta;

    if (!padId) {
      throw new Error(`Cannot resolve real pad ID from URL: ${docUrl}`);
    }

    const result = await renameDocument(cookies, padId, newTitle);

    spinner.succeed(chalk.green(`Document renamed to: ${newTitle}`));
    return { padId, newTitle, raw: result };
  } catch (err) {
    spinner.fail(chalk.red(`Rename failed: ${err.message}`));
    throw err;
  }
}

/**
 * Get document information
 *
 * @param {string} docUrl - Tencent Docs URL
 */
async function handleInfo(docUrl) {
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
    spinner.fail(chalk.red(`Info failed: ${err.message}`));
    throw err;
  }
}

/**
 * Login / re-login
 */
async function handleLogin(force = false) {
  if (force) {
    await forceReLogin();
  } else {
    await ensureLogin();
  }
}

// Export all handlers
module.exports = {
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
  const { program } = require('commander');

  program
    .name('tencent-docs-markdown')
    .description('Tencent Docs Markdown CLI Tool')
    .version('1.0.0');

  program
    .command('login')
    .description('Login via QR code scanning')
    .option('--force', 'Force re-login (clear existing cookies)')
    .action((opts) => handleLogin(opts.force).catch(console.error));

  program
    .command('create <title>')
    .description('Create a new Markdown document')
    .option('-c, --content <text>', 'Initial Markdown content')
    .action((title, opts) => handleCreate(title, opts.content).catch(console.error));

  program
    .command('write <title> <content>')
    .description('Create a new Tencent Docs Markdown and write content to it')
    .action((title, content) => handleCreateAndWrite(title, content).catch(console.error));

  program
    .command('download <url>')
    .description('Download a Tencent Docs Markdown document to local')
    .option('-o, --output <path>', 'Output file path')
    .action((url, opts) => handleDownload(url, opts.output).catch(console.error));

  program
    .command('delete <url>')
    .description('Delete a Tencent Docs Markdown document')
    .action((url) => handleDelete(url).catch(console.error));

  program
    .command('read <url>')
    .description('Read and display document content')
    .action((url) => handleRead(url).catch(console.error));

  program
    .command('update <url> <content>')
    .description('Update document content (text or .md file path)')
    .action((url, content) => handleUpdate(url, content).catch(console.error));

  program
    .command('rename <url> <title>')
    .description('Rename a document')
    .action((url, title) => handleRename(url, title).catch(console.error));

  program
    .command('info <url>')
    .description('Get document information')
    .action((url) => handleInfo(url).catch(console.error));

  program.parse();
}
