import { exec, execFile } from 'child_process';
import { type Request, type Response, Router } from 'express';
import { createReadStream } from 'fs';
import * as fs from 'fs/promises';
import mime from 'mime-types';
import * as path from 'path';
import { promisify } from 'util';
import { SEARCH_MAX_RESULTS, searchFiles } from '../services/file-search.js';
import { FolderAccessError, FolderAccessGuard } from '../services/folder-access.js';
import { colors } from '../utils/colors.js';
import { createLogger } from '../utils/logger.js';
import { expandTildePath } from '../utils/path-utils.js';
import { endOnReadError } from '../utils/stream-response.js';

const logger = createLogger('filesystem');

const execAsync = promisify(exec);
// File paths go to git as arguments, never through a shell: a file named `a$(cmd).txt` in
// the repo ran `cmd` when its diff was opened (2026-10-02).
const execFileAsync = promisify(execFile);
/** git must not hang a listing forever either (a folder held by macOS privacy, a dead mount). */
const GIT_TIMEOUT_MS = 15_000;

interface FileInfo {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modified: string;
  permissions?: string;
  isGitTracked?: boolean;
  gitStatus?: 'modified' | 'added' | 'deleted' | 'untracked' | 'unchanged';
  isSymlink?: boolean;
}

interface GitStatus {
  isGitRepo: boolean;
  branch?: string;
  modified: string[];
  added: string[];
  deleted: string[];
  untracked: string[];
}

/**
 * True when a file is not readable text: a PDF, an archive, an Office file and the like.
 *
 * User report (2026-10-14): opening a PDF found with the new search showed its raw bytes in
 * the text viewer, because every file under 1 MB was sent as text. Small files are still
 * shown as text unless their first bytes contain a NUL or are not valid UTF-8 (extensions
 * alone can't tell: `.ts` is "video/mp2t" to the mime table).
 */
async function looksBinary(fullPath: string, mimeType: string): Promise<boolean> {
  if (mimeType === 'application/pdf') return true;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(fullPath, 'r');
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead);
    if (head.includes(0)) return true;
    // A multi-byte character may be cut at the end of the sample: ignore up to 3 trailing bytes.
    for (let cut = 0; cut <= Math.min(3, head.length); cut++) {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, head.length - cut));
        return false;
      } catch {
        // try a shorter sample
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

/**
 * Answers a request whose folder macOS privacy is holding (user report 2026-10-14: listing
 * Downloads hung forever after a fresh app install). 503 while a prompt is pending (retry
 * later), 403 when denied. Returns false for any other error.
 */
function sendFolderAccessError(res: Response, error: unknown): boolean {
  if (!(error instanceof FolderAccessError)) return false;
  if (!res.headersSent) {
    res.status(error.kind === 'permission-denied' ? 403 : 503).json(error.toJSON());
  }
  return true;
}

export interface FilesystemRoutesOptions {
  /** Deadline + macOS privacy guard for fs calls; tests pass one with a fake probe. */
  access?: FolderAccessGuard;
}

export function createFilesystemRoutes(options: FilesystemRoutesOptions = {}): Router {
  const router = Router();
  const access = options.access ?? new FolderAccessGuard({ log: (line) => logger.warn(line) });

  // Helper to check if path is safe (no directory traversal) - DISABLED for full filesystem access
  function isPathSafe(_requestedPath: string, _basePath: string): boolean {
    // Security check disabled - allow access to all directories
    return true;
  }

  // Helper to get Git status for a directory
  async function getGitStatus(
    dirPath: string
  ): Promise<{ status: GitStatus; repoRoot: string } | null> {
    try {
      // Check if directory is a git repository and get repo root
      const { stdout: repoRoot } = await execAsync('git rev-parse --show-toplevel', {
        cwd: dirPath,
        timeout: GIT_TIMEOUT_MS,
      });
      const gitRepoRoot = repoRoot.trim();

      // Get current branch
      const { stdout: branch } = await execAsync('git branch --show-current', {
        cwd: dirPath,
        timeout: GIT_TIMEOUT_MS,
      });

      // Get status relative to repository root
      const { stdout: statusOutput } = await execAsync('git status --porcelain', {
        cwd: gitRepoRoot,
        timeout: GIT_TIMEOUT_MS,
      });

      const status: GitStatus = {
        isGitRepo: true,
        branch: branch.trim(),
        modified: [],
        added: [],
        deleted: [],
        untracked: [],
      };

      // Parse git status output
      statusOutput.split('\n').forEach((line) => {
        if (!line) return;

        const statusCode = line.substring(0, 2);
        const filename = line.substring(3);

        if (statusCode === ' M' || statusCode === 'M ' || statusCode === 'MM') {
          status.modified.push(filename);
        } else if (statusCode === 'A ' || statusCode === 'AM') {
          status.added.push(filename);
        } else if (statusCode === ' D' || statusCode === 'D ') {
          status.deleted.push(filename);
        } else if (statusCode === '??') {
          status.untracked.push(filename);
        }
      });

      return { status, repoRoot: gitRepoRoot };
    } catch {
      return null;
    }
  }

  // Helper to get file Git status
  function getFileGitStatus(
    filePath: string,
    gitStatus: GitStatus | null,
    gitRepoPath: string
  ): FileInfo['gitStatus'] {
    if (!gitStatus) return undefined;

    // Get path relative to git repository root
    const relativePath = path.relative(gitRepoPath, filePath);

    if (gitStatus.modified.includes(relativePath)) return 'modified';
    if (gitStatus.added.includes(relativePath)) return 'added';
    if (gitStatus.deleted.includes(relativePath)) return 'deleted';
    if (gitStatus.untracked.includes(relativePath)) return 'untracked';

    return 'unchanged';
  }

  // Browse directory endpoint
  router.get('/fs/browse', async (req: Request, res: Response) => {
    try {
      let requestedPath = (req.query.path as string) || '.';
      const showHidden = req.query.showHidden === 'true';
      const gitFilter = req.query.gitFilter as string; // 'all' | 'changed' | 'none'

      // Handle tilde expansion for home directory
      requestedPath = expandTildePath(requestedPath);

      logger.debug(
        `browsing directory: ${requestedPath}, showHidden: ${showHidden}, gitFilter: ${gitFilter}`
      );

      // Security check
      if (!isPathSafe(requestedPath, process.cwd())) {
        logger.warn(`access denied for path: ${requestedPath}`);
        return res.status(403).json({ error: 'Access denied' });
      }

      const fullPath = path.resolve(requestedPath);

      // Check if path exists and is a directory
      let stats: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stats = await access.run(fullPath, () => fs.stat(fullPath));
      } catch (error) {
        if (sendFolderAccessError(res, error)) return;
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          logger.warn(`directory not found: ${requestedPath}`);
          return res.status(404).json({ error: 'Directory not found' });
        }
        // Re-throw other errors to be handled by outer catch
        throw error;
      }

      if (!stats.isDirectory()) {
        logger.warn(`path is not a directory: ${requestedPath}`);
        return res.status(400).json({ error: 'Path is not a directory' });
      }

      // Get Git status if requested
      const gitStatusStart = Date.now();
      const gitInfo = gitFilter !== 'none' ? await getGitStatus(fullPath) : null;
      const gitStatus = gitInfo?.status || null;
      const gitRepoRoot = gitInfo?.repoRoot || '';
      if (gitFilter !== 'none') {
        logger.debug(`git status check took ${Date.now() - gitStatusStart}ms for ${requestedPath}`);
      }

      let files: FileInfo[] = [];

      // If filtering by git changes, show all changed files recursively
      if (gitFilter === 'changed' && gitStatus) {
        // Get all changed files from git status
        const allChangedFiles = [
          ...gitStatus.modified.map((f) => ({ path: f, status: 'modified' as const })),
          ...gitStatus.added.map((f) => ({ path: f, status: 'added' as const })),
          ...gitStatus.deleted.map((f) => ({ path: f, status: 'deleted' as const })),
          ...gitStatus.untracked.map((f) => ({ path: f, status: 'untracked' as const })),
        ];

        // Filter to only files under the current directory
        const currentDirRelativeToRepo = path.relative(gitRepoRoot, fullPath);
        const relevantFiles = allChangedFiles.filter((f) => {
          // If we're at repo root, show all files
          if (fullPath === gitRepoRoot) return true;
          // Otherwise, only show files under current directory
          return f.path.startsWith(`${currentDirRelativeToRepo}/`);
        });

        // Convert to FileInfo objects
        files = await Promise.all(
          relevantFiles.map(async (changedFile) => {
            const absolutePath = path.join(gitRepoRoot, changedFile.path);

            // Check if file exists (it might be deleted)
            let fileStats: Awaited<ReturnType<typeof fs.stat>> | null = null;
            let fileType: 'file' | 'directory' = 'file';
            try {
              fileStats = await fs.stat(absolutePath);
              fileType = fileStats.isDirectory() ? 'directory' : 'file';
            } catch {
              // File might be deleted
              fileStats = null;
            }

            // Get relative display name (relative to current directory)
            const relativeToCurrentDir = path.relative(fullPath, absolutePath);

            const fileInfo: FileInfo = {
              name: relativeToCurrentDir,
              path: path.relative(process.cwd(), absolutePath),
              type: fileType,
              size: fileStats?.size || 0,
              modified: fileStats?.mtime.toISOString() || new Date().toISOString(),
              permissions: fileStats?.mode?.toString(8).slice(-3) || '000',
              isGitTracked: true,
              gitStatus: changedFile.status,
            };

            return fileInfo;
          })
        );
      } else {
        // Normal directory listing
        const entries = await access.run(fullPath, () =>
          fs.readdir(fullPath, { withFileTypes: true })
        );

        files = await Promise.all(
          entries
            .filter((entry) => showHidden || !entry.name.startsWith('.'))
            .map(async (entry) => {
              const entryPath = path.join(fullPath, entry.name);

              try {
                // Use fs.stat() which follows symlinks, instead of entry.isDirectory()
                const stats = await access.withDeadline(entryPath, () => fs.stat(entryPath));
                const relativePath = path.relative(process.cwd(), entryPath);

                // Check if this is a symlink
                const isSymlink = entry.isSymbolicLink();

                const fileInfo: FileInfo = {
                  name: entry.name,
                  path: relativePath,
                  type: stats.isDirectory() ? 'directory' : 'file',
                  size: stats.size,
                  modified: stats.mtime.toISOString(),
                  permissions: stats.mode.toString(8).slice(-3),
                  isGitTracked: gitStatus?.isGitRepo || false,
                  gitStatus: getFileGitStatus(entryPath, gitStatus, gitRepoRoot),
                  isSymlink,
                };

                return fileInfo;
              } catch (error) {
                // Handle broken symlinks or permission errors
                logger.warn(`failed to stat ${entryPath}:`, error);

                // For broken symlinks, we'll still show them but as files
                const fileInfo: FileInfo = {
                  name: entry.name,
                  path: path.relative(process.cwd(), entryPath),
                  type: 'file',
                  size: 0,
                  modified: new Date().toISOString(),
                  permissions: '000',
                  isGitTracked: false,
                  gitStatus: undefined,
                };

                return fileInfo;
              }
            })
        );
      }

      // No additional filtering needed if we already filtered by git status above
      const filteredFiles = files;

      // Sort: directories first, then by name
      filteredFiles.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      logger.debug(
        `directory browsed successfully: ${requestedPath} (${filteredFiles.length} items)`
      );

      res.json({
        path: requestedPath,
        fullPath,
        gitStatus,
        files: filteredFiles,
      });
    } catch (error) {
      if (sendFolderAccessError(res, error)) return;
      logger.error(`failed to browse directory ${req.query.path}:`, error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Get file preview
  router.get('/fs/preview', async (req: Request, res: Response) => {
    try {
      const requestedPath = req.query.path as string;
      if (!requestedPath) {
        return res.status(400).json({ error: 'Path is required' });
      }

      logger.debug(`previewing file: ${requestedPath}`);

      // Security check
      if (!isPathSafe(requestedPath, process.cwd())) {
        logger.warn(`access denied for file preview: ${requestedPath}`);
        return res.status(403).json({ error: 'Access denied' });
      }

      const fullPath = path.resolve(process.cwd(), requestedPath);
      const stats = await access.run(fullPath, () => fs.stat(fullPath));

      if (stats.isDirectory()) {
        logger.warn(`cannot preview directory: ${requestedPath}`);
        return res.status(400).json({ error: 'Cannot preview directories' });
      }

      // Determine file type
      const mimeType = mime.lookup(fullPath) || 'application/octet-stream';
      const isText =
        mimeType.startsWith('text/') ||
        mimeType === 'application/json' ||
        mimeType === 'application/javascript' ||
        mimeType === 'application/typescript' ||
        mimeType === 'application/xml';
      const isImage = mimeType.startsWith('image/');

      if (isImage) {
        // For images, return URL to fetch the image
        logger.log(
          colors.green(`image preview generated: ${requestedPath} (${formatBytes(stats.size)})`)
        );
        res.json({
          type: 'image',
          mimeType,
          url: `/api/fs/raw?path=${encodeURIComponent(requestedPath)}`,
          size: stats.size,
        });
      } else if (
        isText ||
        (stats.size < 1024 * 1024 &&
          !(await access.withDeadline(fullPath, () => looksBinary(fullPath, mimeType))))
      ) {
        // Text or small files (< 1MB)
        const content = await access.withDeadline(fullPath, () => fs.readFile(fullPath, 'utf-8'));
        const language = getLanguageFromPath(fullPath);

        logger.log(
          colors.green(
            `text file preview generated: ${requestedPath} (${formatBytes(stats.size)}, ${language})`
          )
        );

        res.json({
          type: 'text',
          content,
          language,
          mimeType,
          size: stats.size,
        });
      } else {
        // Binary or large files
        logger.log(
          `binary file preview metadata returned: ${requestedPath} (${formatBytes(stats.size)})`
        );
        res.json({
          type: 'binary',
          mimeType,
          size: stats.size,
          humanSize: formatBytes(stats.size),
        });
      }
    } catch (error) {
      if (sendFolderAccessError(res, error)) return;
      logger.error(`failed to preview file ${req.query.path}:`, error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Serve raw file content
  router.get('/fs/raw', async (req: Request, res: Response) => {
    try {
      const requestedPath = req.query.path as string;
      if (!requestedPath) {
        return res.status(400).json({ error: 'Path is required' });
      }

      logger.debug(`serving raw file: ${requestedPath}`);

      // Security check
      if (!isPathSafe(requestedPath, process.cwd())) {
        logger.warn(`access denied for raw file: ${requestedPath}`);
        return res.status(403).json({ error: 'Access denied' });
      }

      const fullPath = path.resolve(process.cwd(), requestedPath);

      // Check if file exists (async and guarded: a sync stat on a folder macOS holds behind a
      // privacy prompt would freeze the whole server)
      const stats = await access.run(fullPath, () => fs.stat(fullPath));
      if (!stats.isFile()) {
        logger.warn(`file not found for raw access: ${requestedPath}`);
        return res.status(404).json({ error: 'File not found' });
      }

      // Set appropriate content type
      const mimeType = mime.lookup(fullPath) || 'application/octet-stream';
      res.setHeader('Content-Type', mimeType);
      // 2026-10-20 (security audit): an .html or .svg served from here ran as the app's own
      // origin (with its ambient Tailscale login) when opened in a tab. Same headers as
      // /api/files (routes/files.ts): no sniffing, sandboxed, and only images shown inline.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('Cache-Control', 'private, no-cache');
      res.setHeader(
        'Content-Disposition',
        `${mimeType.startsWith('image/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(fullPath))}`
      );

      // Stream the file
      const stream = createReadStream(fullPath);
      endOnReadError(stream, res);
      stream.pipe(res);

      stream.on('end', () => {
        logger.log(colors.green(`raw file served: ${requestedPath}`));
      });
    } catch (error) {
      if (sendFolderAccessError(res, error)) return;
      logger.error(`failed to serve raw file ${req.query.path}:`, error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Get Git diff for a file
  router.get('/fs/diff', async (req: Request, res: Response) => {
    try {
      const requestedPath = req.query.path as string;
      if (!requestedPath) {
        return res.status(400).json({ error: 'Path is required' });
      }

      logger.debug(`getting git diff: ${requestedPath}`);

      // Security check
      if (!isPathSafe(requestedPath, process.cwd())) {
        logger.warn(`access denied for git diff: ${requestedPath}`);
        return res.status(403).json({ error: 'Access denied' });
      }

      const fullPath = path.resolve(process.cwd(), requestedPath);

      // Asked in the file's own folder, so git finds the file's repository (2026-11-10: it ran
      // in the server's folder, which in the app is no repository at all and in development
      // is Untether's: every other project's diff failed).
      const diffStart = Date.now();
      const { stdout: diff } = await execFileAsync(
        'git',
        ['diff', 'HEAD', '--', path.basename(fullPath)],
        { cwd: path.dirname(fullPath), maxBuffer: 16 * 1024 * 1024 }
      );

      const diffTime = Date.now() - diffStart;
      if (diffTime > 1000) {
        logger.warn(`slow git diff operation: ${requestedPath} took ${diffTime}ms`);
      }

      logger.log(
        colors.green(
          `git diff retrieved: ${requestedPath} (${diff.length > 0 ? 'has changes' : 'no changes'})`
        )
      );

      res.json({
        path: requestedPath,
        diff,
        hasDiff: diff.length > 0,
      });
    } catch (error) {
      logger.error(`failed to get git diff for ${req.query.path}:`, error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Get file content for diff view (current and HEAD versions)
  router.get('/fs/diff-content', async (req: Request, res: Response) => {
    try {
      const requestedPath = req.query.path as string;
      if (!requestedPath) {
        return res.status(400).json({ error: 'Path is required' });
      }

      logger.debug(`getting diff content: ${requestedPath}`);

      // Security check
      if (!isPathSafe(requestedPath, process.cwd())) {
        logger.warn(`access denied for diff content: ${requestedPath}`);
        return res.status(403).json({ error: 'Access denied' });
      }

      const fullPath = path.resolve(process.cwd(), requestedPath);
      // Relative to the file's own folder, where git is asked (see /fs/diff).
      const relativePath = path.basename(fullPath);

      logger.debug(`Getting diff content for: ${requestedPath}`);
      logger.debug(`Full path: ${fullPath}`);
      logger.debug(`CWD: ${process.cwd()}`);

      // Get current file content
      const currentContent = await fs.readFile(fullPath, 'utf-8');
      logger.debug(`Current content length: ${currentContent.length}`);

      // Get HEAD version content
      let originalContent = ''; // Default to empty string for new files
      try {
        // Use ./ prefix as git suggests for paths relative to current directory
        const gitPath = `./${relativePath}`;
        logger.debug(`Getting HEAD version: git show HEAD:"${gitPath}"`);

        const { stdout } = await execFileAsync('git', ['show', `HEAD:${gitPath}`], {
          cwd: path.dirname(fullPath),
          maxBuffer: 16 * 1024 * 1024,
        });
        originalContent = stdout;
        logger.debug(`Got HEAD version for ${gitPath}, length: ${originalContent.length}`);
      } catch (error) {
        // File might be new (not in HEAD), use empty string
        if (error instanceof Error && error.message.includes('does not exist')) {
          originalContent = '';
          logger.debug(`File ${requestedPath} does not exist in HEAD (new file)`);
        } else {
          // For other errors, log the full error
          logger.error(`Failed to get HEAD version of ./${relativePath}:`, error);
          // Check if it's a stderr message
          if (error instanceof Error && 'stderr' in error) {
            const execError = error as Error & { stderr?: string };
            if (execError.stderr) {
              logger.error(`Git stderr: ${execError.stderr}`);
            }
          }
          // For non-git repos, show no diff
          originalContent = currentContent;
        }
      }

      logger.log(colors.green(`diff content retrieved: ${requestedPath}`));

      res.json({
        path: requestedPath,
        originalContent,
        modifiedContent: currentContent,
        language: getLanguageFromPath(fullPath),
      });
    } catch (error) {
      logger.error(`failed to get diff content for ${req.query.path}:`, error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Create directory
  router.post('/fs/mkdir', async (req: Request, res: Response) => {
    try {
      const { path: dirPath, name } = req.body;

      if (!dirPath || !name) {
        return res.status(400).json({ error: 'Path and name are required' });
      }

      logger.log(`creating directory: ${name} in ${dirPath}`);

      // Validate name (no slashes, no dots at start)
      if (name.includes('/') || name.includes('\\') || name.startsWith('.')) {
        logger.warn(`invalid directory name attempted: ${name}`);
        return res.status(400).json({ error: 'Invalid directory name' });
      }

      // Security check
      if (!isPathSafe(dirPath, process.cwd())) {
        logger.warn(`access denied for mkdir: ${dirPath}/${name}`);
        return res.status(403).json({ error: 'Access denied' });
      }

      const fullPath = path.resolve(process.cwd(), dirPath, name);

      // Create directory
      await fs.mkdir(fullPath, { recursive: true });

      logger.log(colors.green(`directory created: ${path.relative(process.cwd(), fullPath)}`));

      res.json({
        success: true,
        path: path.relative(process.cwd(), fullPath),
      });
    } catch (error) {
      logger.error(`failed to create directory ${req.body.path}/${req.body.name}:`, error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Search file and folder names across the Mac (home + iCloud Drive) with Spotlight.
  // User report (2026-10-14): the browser's search box only narrowed the open folder.
  // Behind the same /api auth as every other fs route; it lists names only.
  router.get('/fs/search', async (req: Request, res: Response) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (query.length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' });
    }
    const requested = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit =
      Number.isFinite(requested) && requested > 0
        ? Math.min(requested, SEARCH_MAX_RESULTS)
        : SEARCH_MAX_RESULTS;
    // The client cancels stale searches: stop mdfind / the walk when it goes away.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      const result = await searchFiles(query, {
        limit,
        signal: abort.signal,
        // Tests and isolated QA servers point the search at a fixture folder.
        home: process.env.UNTETHER_FS_SEARCH_HOME || undefined,
        access,
      });
      if (abort.signal.aborted) return;
      res.json({ query, ...result });
    } catch (error) {
      logger.error('file search failed:', error);
      if (!res.headersSent) res.status(500).json({ error: 'Search failed' });
    }
  });

  // Path completions endpoint for autocomplete
  router.get('/fs/completions', async (req: Request, res: Response) => {
    try {
      const originalPath = (req.query.path as string) || '';
      let partialPath = originalPath;

      // Handle tilde expansion for home directory
      partialPath = expandTildePath(partialPath);

      // Separate directory and partial name
      let dirPath: string;
      let partialName: string;

      if (partialPath.endsWith('/')) {
        // If path ends with slash, list contents of that directory
        dirPath = partialPath;
        partialName = '';
      } else {
        // Otherwise, get the directory and partial filename
        dirPath = path.dirname(partialPath);
        partialName = path.basename(partialPath);
      }

      // Resolve the directory path
      const fullDirPath = path.resolve(dirPath);

      // Security check
      if (!isPathSafe(fullDirPath, '/')) {
        logger.warn(`access denied for path completions: ${fullDirPath}`);
        return res.status(403).json({ error: 'Access denied' });
      }

      // Check if directory exists
      let dirStats: Awaited<ReturnType<typeof fs.stat>>;
      let entries: import('fs').Dirent[];
      try {
        dirStats = await access.run(fullDirPath, () => fs.stat(fullDirPath));
        if (!dirStats.isDirectory()) {
          return res.json({ completions: [] });
        }
        // Read directory contents
        entries = await access.run(fullDirPath, () =>
          fs.readdir(fullDirPath, { withFileTypes: true })
        );
      } catch (error) {
        // Directory doesn't exist or macOS holds it: no completions (and say why)
        if (error instanceof FolderAccessError) {
          return res.json({ completions: [], blocked: error.toJSON() });
        }
        return res.json({ completions: [] });
      }

      // Filter and map entries
      const mappedEntries = await Promise.all(
        entries
          .filter((entry) => {
            // Filter by partial name (case-insensitive)
            if (partialName && !entry.name.toLowerCase().startsWith(partialName.toLowerCase())) {
              return false;
            }
            // Optionally hide hidden files unless the partial name starts with '.'
            if (!partialName.startsWith('.') && entry.name.startsWith('.')) {
              return false;
            }
            return true;
          })
          // The 20 that are shown, chosen BEFORE git is asked about each (2026-11-10: every
          // match ran `git branch` and a whole `git status`, with no timeout, and 20 were kept
          // afterwards: ~160 git processes per keystroke in a folder of 80 repositories).
          .sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
            return a.name.localeCompare(b.name);
          })
          .slice(0, 20)
          .map(async (entry) => {
            const isDirectory = entry.isDirectory();
            const entryPath = path.join(fullDirPath, entry.name);

            // Build the suggestion path based on the original input
            let displayPath: string;
            if (originalPath.endsWith('/')) {
              displayPath = originalPath + entry.name;
            } else {
              const lastSlash = originalPath.lastIndexOf('/');
              if (lastSlash >= 0) {
                displayPath = originalPath.substring(0, lastSlash + 1) + entry.name;
              } else {
                displayPath = entry.name;
              }
            }

            // Check if this directory is a git repository and get branch + status
            let isGitRepo = false;
            let gitBranch: string | undefined;
            let gitStatusCount = 0;
            let gitAddedCount = 0;
            let gitModifiedCount = 0;
            let gitDeletedCount = 0;
            let isWorktree = false;
            // Don't look inside a folder macOS privacy hasn't cleared (Downloads in ~/).
            const peek = isDirectory ? access.peek(entryPath) : 'unprotected';
            if (isDirectory && (peek === 'ok' || peek === 'unprotected')) {
              try {
                const gitPath = path.join(entryPath, '.git');
                const gitStat = await fs.stat(gitPath);
                isGitRepo = true;

                // Check if it's a worktree (has a .git file instead of directory)
                if (gitStat.isFile()) {
                  isWorktree = true;
                }

                // Get the current git branch
                try {
                  const { stdout: branch } = await execAsync('git branch --show-current', {
                    cwd: entryPath,
                    timeout: GIT_TIMEOUT_MS,
                  });
                  gitBranch = branch.trim();
                } catch {
                  // Failed to get branch
                }

                // Get the number of changed files by type
                try {
                  const { stdout: statusOutput } = await execAsync('git status --porcelain', {
                    cwd: entryPath,
                    timeout: GIT_TIMEOUT_MS,
                    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
                  });
                  const lines = statusOutput.split('\n').filter((line) => line.trim() !== '');

                  for (const line of lines) {
                    const statusCode = line.substring(0, 2);
                    if (statusCode === '??' || statusCode === 'A ' || statusCode === 'AM') {
                      gitAddedCount++;
                    } else if (statusCode === ' D' || statusCode === 'D ') {
                      gitDeletedCount++;
                    } else if (statusCode === ' M' || statusCode === 'M ' || statusCode === 'MM') {
                      gitModifiedCount++;
                    }
                  }

                  gitStatusCount = gitAddedCount + gitModifiedCount + gitDeletedCount;
                } catch {
                  // Failed to get status
                }
              } catch {
                // Not a git repository
              }
            }

            return {
              name: entry.name,
              path: displayPath,
              type: isDirectory ? 'directory' : 'file',
              // Add trailing slash for directories
              suggestion: isDirectory ? `${displayPath}/` : displayPath,
              isRepository: isGitRepo,
              gitBranch,
              gitStatusCount,
              gitAddedCount,
              gitModifiedCount,
              gitDeletedCount,
              isWorktree,
            };
          })
      );

      const completions = mappedEntries
        .sort((a, b) => {
          // Sort directories first, then by name
          if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        })
        .slice(0, 20); // Limit to 20 suggestions

      logger.debug(`path completions for "${originalPath}": ${completions.length} results`);

      res.json({
        completions,
        partialPath: originalPath,
      });
    } catch (error) {
      logger.error(`failed to get path completions for ${req.query.path}:`, error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}

// Helper function to determine language from file path
function getLanguageFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const languageMap: Record<string, string> = {
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.py': 'python',
    '.java': 'java',
    '.c': 'c',
    '.cpp': 'cpp',
    '.cs': 'csharp',
    '.php': 'php',
    '.rb': 'ruby',
    '.go': 'go',
    '.rs': 'rust',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.scala': 'scala',
    '.r': 'r',
    '.m': 'objective-c',
    '.mm': 'objective-c',
    '.h': 'c',
    '.hpp': 'cpp',
    '.sh': 'shell',
    '.bash': 'shell',
    '.zsh': 'shell',
    '.fish': 'shell',
    '.ps1': 'powershell',
    '.html': 'html',
    '.htm': 'html',
    '.xml': 'xml',
    '.css': 'css',
    '.scss': 'scss',
    '.sass': 'sass',
    '.less': 'less',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'toml',
    '.ini': 'ini',
    '.cfg': 'ini',
    '.conf': 'ini',
    '.sql': 'sql',
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.tex': 'latex',
    '.dockerfile': 'dockerfile',
    '.makefile': 'makefile',
    '.cmake': 'cmake',
    '.gradle': 'gradle',
    '.vue': 'vue',
    '.svelte': 'svelte',
    '.elm': 'elm',
    '.clj': 'clojure',
    '.cljs': 'clojure',
    '.ex': 'elixir',
    '.exs': 'elixir',
    '.erl': 'erlang',
    '.hrl': 'erlang',
    '.fs': 'fsharp',
    '.fsx': 'fsharp',
    '.fsi': 'fsharp',
    '.ml': 'ocaml',
    '.mli': 'ocaml',
    '.pas': 'pascal',
    '.pp': 'pascal',
    '.pl': 'perl',
    '.pm': 'perl',
    '.t': 'perl',
    '.lua': 'lua',
    '.dart': 'dart',
    '.nim': 'nim',
    '.nims': 'nim',
    '.zig': 'zig',
    '.jl': 'julia',
  };

  return languageMap[ext] || 'plaintext';
}

// Helper function to format bytes
function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${Number.parseFloat((bytes / k ** i).toFixed(dm))} ${sizes[i]}`;
}
