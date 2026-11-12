/**
 * File Browser Component
 *
 * Modal file browser for navigating the filesystem and selecting files/directories.
 * Supports Git status display, file preview with CodeMirror editor, and diff viewing.
 *
 * @fires insert-path - When inserting a file path into terminal (detail: { path: string, type: 'file' | 'directory' })
 * @fires directory-selected - When a directory is selected in 'select' mode (detail: string)
 * @fires browser-cancel - When the browser is cancelled or closed
 */
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { createRef, ref } from 'lit/directives/ref.js';
import { nameMatches, queryTerms } from '../../shared/name-match.js';
import type { Session } from '../../shared/types.js';
import { getLocale, LocaleController, t } from '../i18n/index.js';
import { authClient } from '../services/auth-client.js';
import { Z_INDEX } from '../utils/constants.js';
import {
  type GitStatus as GitStatusType,
  getFileIcon,
  getParentDirectoryIcon,
  renderGitStatusBadge,
  UIIcons,
} from '../utils/file-icons.js';
import { createLogger } from '../utils/logger.js';
import { copyToClipboard, formatPathForDisplay } from '../utils/path-utils.js';
import type { MonacoEditorOptions } from './monaco-editor.js';
import './monaco-editor.js';
import { serverConfigService } from '../services/server-config-service.js';
import { formatShortcut } from '../utils/shortcut-label.js';
import { isDarkMode } from '../utils/theme-utils.js';
import { icon } from './icons.js';
import { sessionDisplayTitle } from './session-view/session-switcher-sheet.js';

const logger = createLogger('file-browser');

// On a phone there's no room for horizontal scrolling or a folding gutter:
// wrap long lines so code and markdown read top to bottom.
const SORT_STORAGE_KEY = 'untether.fileBrowser.sort';

function readStoredSort(): 'name' | 'recent' {
  try {
    return localStorage.getItem(SORT_STORAGE_KEY) === 'recent' ? 'recent' : 'name';
  } catch {
    return 'name';
  }
}

/** "5 min ago"-style label in the UI language, for the Recent sort. */
function formatModifiedAgo(modified: string, now = Date.now()): string {
  const time = Date.parse(modified);
  if (Number.isNaN(time)) return '';
  const seconds = Math.round((time - now) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  const format = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto', style: 'narrow' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, 'second');
}

/** "12 Mar" (or "12 Mar 2024" for another year) in the UI language, for search results. */
function formatShortDate(modified: string, now = new Date()): string {
  const time = Date.parse(modified);
  if (Number.isNaN(time)) return '';
  const date = new Date(time);
  const options: Intl.DateTimeFormatOptions =
    date.getFullYear() === now.getFullYear()
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' };
  return new Intl.DateTimeFormat(getLocale(), options).format(date);
}

/** A hit from GET /api/fs/search (server/services/file-search.ts). */
interface GlobalSearchHit {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modified: string;
  area: 'home' | 'icloud';
  parent: string;
}

/**
 * A folder macOS privacy is holding: the server answers {error, folder, place} instead of
 * hanging (user report 2026-10-14, server/services/folder-access.ts).
 */
interface BlockedFolder {
  error: 'permission-pending' | 'permission-denied';
  folder: string;
  place: 'downloads' | 'desktop' | 'documents' | 'icloud' | 'volume' | 'other';
}

function asBlockedFolder(data: unknown): BlockedFolder | null {
  const value = data as Partial<BlockedFolder> | null;
  if (!value || typeof value !== 'object' || typeof value.folder !== 'string') return null;
  if (value.error !== 'permission-pending' && value.error !== 'permission-denied') return null;
  return { error: value.error, folder: value.folder, place: value.place ?? 'other' };
}

/** «Descargas», «iCloud Drive», or the folder's own name. */
function blockedFolderLabel(blocked: BlockedFolder): string {
  switch (blocked.place) {
    case 'downloads':
      return t('files.place.downloads');
    case 'desktop':
      return t('files.place.desktop');
    case 'documents':
      return t('files.place.documents');
    case 'icloud':
      return t('files.place.icloud');
    default:
      return blocked.folder;
  }
}

/** Debounce before asking the server to search the whole Mac. */
const GLOBAL_SEARCH_DEBOUNCE_MS = 250;
const GLOBAL_SEARCH_MIN_CHARS = 2;

const HOME_PLACES: Record<
  string,
  'files.place.downloads' | 'files.place.desktop' | 'files.place.documents'
> = {
  Downloads: 'files.place.downloads',
  Desktop: 'files.place.desktop',
  Documents: 'files.place.documents',
};

/** Friendly parent folder of a hit: "Descargas", "iCloud Drive › Trámites", "Carpeta personal". */
function hitPlaceLabel(hit: GlobalSearchHit): string {
  const segments = hit.parent.split('/').filter(Boolean);
  if (hit.area === 'icloud') return [t('files.place.icloud'), ...segments].join(' › ');
  if (segments.length === 0) return t('files.place.home');
  const known = HOME_PLACES[segments[0]];
  if (known) segments[0] = t(known);
  return segments.join(' › ');
}

function parentDirectoryOf(filePath: string): string {
  const cut = filePath.replace(/\/+$/, '').lastIndexOf('/');
  return cut <= 0 ? '/' : filePath.slice(0, cut);
}

const PHONE_EDITOR_OPTIONS: MonacoEditorOptions = {
  wordWrap: 'on',
  fontSize: 13,
  folding: false,
  lineNumbersMinChars: 3,
};

/**
 * The preview editor's options. QA 2026-10-12: monaco-editor creates every editor with
 * theme 'vs-dark' (a global Monaco setting), so the preview stayed dark next to a light list.
 * Passing the app's theme here wins at creation; 'theme-changed' follows later switches.
 */
function editorOptions(isMobile: boolean): MonacoEditorOptions {
  return { ...(isMobile ? PHONE_EDITOR_OPTIONS : {}), theme: isDarkMode() ? 'vs-dark' : 'vs' };
}

function syncMonacoTheme() {
  window.monaco?.editor.setTheme(isDarkMode() ? 'vs-dark' : 'vs');
}

interface FileInfo {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modified: string;
  permissions?: string;
  isGitTracked?: boolean;
  gitStatus?: GitStatusType;
  isSymlink?: boolean;
}

interface DirectoryListing {
  path: string;
  fullPath: string;
  gitStatus: GitStatus | null;
  files: FileInfo[];
}

interface GitStatus {
  isGitRepo: boolean;
  branch?: string;
  modified: string[];
  added: string[];
  deleted: string[];
  untracked: string[];
}

interface FilePreview {
  type: 'image' | 'text' | 'binary';
  content?: string;
  language?: string;
  url?: string;
  mimeType?: string;
  size: number;
  humanSize?: string;
}

interface FileDiff {
  path: string;
  diff: string;
  hasDiff: boolean;
}

interface FileDiffContent {
  path: string;
  originalContent: string;
  modifiedContent: string;
  language?: string;
}

@customElement('file-browser')
export class FileBrowser extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  @property({ type: Boolean }) visible = false;
  @property({ type: String }) mode: 'browse' | 'select' = 'browse';
  @property({ type: Object }) session: Session | null = null;

  protected readonly i18n = new LocaleController(this);
  @state() private currentPath = '';
  @state() private currentFullPath = '';
  @state() private files: FileInfo[] = [];
  @state() private loading = false;
  @state() private selectedFile: FileInfo | null = null;
  @state() private preview: FilePreview | null = null;
  @state() private diff: FileDiff | null = null;
  @state() private diffContent: FileDiffContent | null = null;
  @state() private gitFilter: 'all' | 'changed' = 'all';
  @state() private showHidden = false;
  @state() private gitStatus: GitStatus | null = null;
  @state() private previewLoading = false;
  @state() private showDiff = false;
  @state() private errorMessage = '';
  /** A folder that does not exist or cannot be read: an inline state with "Go to ~". */
  @state() private missingPath = '';
  /** The folder being opened is held by macOS privacy (shows the how-to-allow state). */
  @state() private blockedFolder: (BlockedFolder & { path: string }) | null = null;
  @state() private mobileView: 'list' | 'preview' = 'list';
  @state() private isMobile = window.innerWidth < 768;
  @state() private editingPath = false;
  @state() private pathInputValue = '';
  // Object URL of the previewed image. `<img src>` can't carry the Bearer
  // header, so behind the login gate /api/fs/raw would answer 401; fetch it
  // with auth and show a blob URL instead.
  @state() private imageObjectUrl = '';
  @state() private copyFeedback: '' | 'copied' | 'failed' = '';
  @state() private filterQuery = '';
  @state() private sortBy: 'name' | 'recent' = readStoredSort();
  /** "On this Mac" results for the search box (user report 2026-10-14). */
  @state() private globalResults: GlobalSearchHit[] = [];
  @state() private globalStatus: 'idle' | 'loading' | 'done' | 'error' = 'idle';
  @state() private globalTruncated = false;
  @state() private globalBlocked: BlockedFolder[] = [];
  private globalSearchTimer?: ReturnType<typeof setTimeout>;
  private globalSearchAbort?: AbortController;
  private copyFeedbackTimer?: ReturnType<typeof setTimeout>;

  private editorRef = createRef<HTMLElement>();
  private breadcrumbsRef = createRef<HTMLElement>();
  private pathInputRef = createRef<HTMLInputElement>();
  private noAuthMode = false;
  private authReady: Promise<void> = Promise.resolve();
  /** Latest directory/diff request; an answer for an older one is dropped (2026-11-10). */
  private directorySeq = 0;
  private diffSeq = 0;

  /**
   * Where browsing starts: the session's folder, or (opened from the session list) the
   * repository base path from Settings (~/Projects by default). It used to be '.', the folder
   * the server happened to run in (e.g. ~/Projects/untether/web).
   */
  private async startPath(): Promise<string> {
    if (this.session?.workingDir) return this.session.workingDir;
    try {
      return (await serverConfigService.getRepositoryBasePath()) || '~';
    } catch {
      return '~';
    }
  }

  connectedCallback() {
    super.connectedCallback();

    // 2026-11-10: listeners are registered synchronously; they used to follow two awaits, so an
    // element removed during the load left them on document/window for good.
    document.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('resize', this.handleResize);
    window.addEventListener('theme-changed', syncMonacoTheme);
    this.setupTouchHandlers();

    this.authReady = this.checkAuthConfig();
    // First connection: updated() opens the folder once the first render has the `visible`
    // value (2026-11-10: opening here as well listed the folder twice). Only a re-attached,
    // already rendered element has to open it itself.
    if (this.hasUpdated && this.visible) void this.openStartFolder();
  }

  /** Lists the start folder once the auth config is known. */
  private async openStartFolder() {
    await this.authReady;
    if (!this.isConnected) return;
    this.clearSelection();
    this.currentPath = await this.startPath();
    if (!this.isConnected) return;
    await this.loadDirectory(this.currentPath, { fallbackHome: true, opening: true });
  }

  async updated(changedProperties: Map<string, unknown>) {
    super.updated(changedProperties);

    // Only load directory when the component becomes visible or when session's workingDir actually changes
    if (changedProperties.has('visible')) {
      if (this.visible) {
        // Component just became visible
        await this.openStartFolder();
      }
    } else if (changedProperties.has('session') && this.visible) {
      // Check if the workingDir actually changed
      const oldSession = changedProperties.get('session') as Session | null;
      const oldWorkingDir = oldSession?.workingDir;
      const newWorkingDir = this.session?.workingDir;

      if (oldWorkingDir !== newWorkingDir) {
        // Working directory actually changed, reload
        await this.authReady;
        this.currentPath = await this.startPath();
        await this.loadDirectory(this.currentPath);
      }
      // If only the session object reference changed but workingDir is the same, don't reload
    }

    // Keep the current folder in view: long paths overflow to the left
    if (changedProperties.has('currentFullPath') && this.breadcrumbsRef.value) {
      this.breadcrumbsRef.value.scrollLeft = this.breadcrumbsRef.value.scrollWidth;
      this.markCrumbsScrolled();
    }

    // Monaco editor will handle its own updates through properties
  }

  /**
   * Lists `dirPath`. A folder that is gone or unreadable shows the inline "This folder doesn't
   * exist" state; on first open (`fallbackHome`, e.g. a repository base path that was moved)
   * it opens ~ instead (2026-10-12).
   */
  private async loadDirectory(
    dirPath: string,
    options: { fallbackHome?: boolean; opening?: boolean } = {}
  ) {
    // 2026-11-10: a slow answer for an earlier folder used to replace the one navigated to next.
    const seq = ++this.directorySeq;
    this.loading = true;
    // Navigating away drops the old folder's preview (QA 2026-10-12). Not while opening: the
    // selection was already cleared then, and a file picked meanwhile stays.
    const selectedBefore = options.opening ? undefined : this.selectedFile;
    try {
      const params = new URLSearchParams({
        path: dirPath,
        showHidden: this.showHidden.toString(),
        gitFilter: this.gitFilter,
      });

      const url = `/api/fs/browse?${params}`;
      logger.debug(`loading directory: ${dirPath}`);
      logger.debug(`fetching URL: ${url}`);

      const headers = this.noAuthMode ? {} : { ...authClient.getAuthHeader() };
      const response = await fetch(url, { headers });
      if (seq !== this.directorySeq) return;
      logger.debug(`response status: ${response.status}`);

      if (response.ok) {
        const data: DirectoryListing = await response.json();
        if (seq !== this.directorySeq) return;
        logger.debug(`received ${data.files?.length || 0} files`);
        // Use the absolute path (fullPath) instead of the potentially relative path
        this.currentPath = data.fullPath;
        if (data.fullPath !== this.currentFullPath) {
          this.filterQuery = '';
          this.resetGlobalSearch();
          // Another folder than the one listed: its preview no longer belongs.
          if (this.selectedFile === selectedBefore) this.clearSelection();
        }
        this.currentFullPath = data.fullPath;
        this.files = data.files || [];
        this.gitStatus = data.gitStatus;
        // Clear any previous error message on successful load
        this.errorMessage = '';
        this.missingPath = '';
        this.blockedFolder = null;
      } else {
        let errorMessage = t('files.error.load');
        let blocked: BlockedFolder | null = null;
        try {
          const errorData = await response.json();
          blocked = asBlockedFolder(errorData);
          errorMessage = errorData.error || errorMessage;
        } catch {
          // If response isn't JSON, use default message
          errorMessage = t('files.error.loadStatus', { status: response.status });
        }
        if (seq !== this.directorySeq) return;

        if (blocked) {
          // macOS is holding the folder behind a privacy prompt: say how to allow it, and let
          // the user retry (not "doesn't exist", not a silent jump to ~).
          logger.warn(`folder held by macOS privacy (${blocked.error}): ${blocked.folder}`);
          if (this.selectedFile === selectedBefore) this.clearSelection();
          this.blockedFolder = { ...blocked, path: dirPath };
          this.missingPath = '';
          this.currentPath = dirPath;
          this.currentFullPath = '';
          this.files = [];
          this.gitStatus = null;
          return;
        }

        const missing =
          response.status === 404 ||
          response.status === 403 ||
          /not found|no such|ENOENT|EACCES|EPERM|permission/i.test(errorMessage);
        if (missing) logger.warn(`folder not available (${response.status}): ${dirPath}`);
        else logger.error(`failed to load directory: ${response.status}`, new Error(errorMessage));
        if (missing && options.fallbackHome && dirPath !== '~') {
          await this.loadDirectory('~', { opening: options.opening });
          return;
        }
        if (missing) {
          // QA 2026-10-12: the previous folder's preview stayed beside "folder doesn't exist".
          if (this.selectedFile === selectedBefore) this.clearSelection();
          this.blockedFolder = null;
          this.missingPath = dirPath;
          this.currentPath = dirPath;
          this.currentFullPath = '';
          this.files = [];
          this.gitStatus = null;
        } else {
          this.showErrorMessage(errorMessage);
        }
      }
    } catch (error) {
      if (seq !== this.directorySeq) return;
      logger.error('error loading directory:', error);
      this.showErrorMessage(t('files.error.network'));
    } finally {
      if (seq === this.directorySeq) this.loading = false;
    }
  }

  /** Drops the selected file and its preview (another folder is now listed). */
  private clearSelection() {
    this.selectedFile = null;
    this.preview = null;
    this.diff = null;
    this.diffContent = null;
    this.showDiff = false;
    this.diffSeq++;
    this.previewLoading = false;
    this.revokeImageObjectUrl();
    if (this.isMobile) this.mobileView = 'list';
  }

  private async loadPreview(file: FileInfo) {
    if (file.type === 'directory') return;

    this.previewLoading = true;
    this.selectedFile = file;
    this.showDiff = false;

    try {
      logger.debug(`loading preview for file: ${file.name}`);
      logger.debug(`file path: ${file.path}`);

      const headers = this.noAuthMode ? {} : { ...authClient.getAuthHeader() };
      const response = await fetch(`/api/fs/preview?path=${encodeURIComponent(file.path)}`, {
        headers,
      });
      if (response.ok) {
        const preview: FilePreview = await response.json();
        const imageUrl =
          preview.type === 'image' && preview.url
            ? await this.loadImageObjectUrl(preview.url, headers)
            : '';
        // A newer tap may have selected another file while this one loaded: don't let this
        // (slower) image replace that file's preview.
        if (this.selectedFile?.path !== file.path) {
          if (imageUrl) URL.revokeObjectURL(imageUrl);
          return;
        }
        this.revokeImageObjectUrl();
        this.imageObjectUrl = imageUrl;
        this.preview = preview;
        this.requestUpdate(); // Trigger re-render to initialize Monaco if needed
      } else {
        const body = await response.text();
        let blocked: BlockedFolder | null = null;
        try {
          blocked = asBlockedFolder(JSON.parse(body));
        } catch {
          // not JSON
        }
        if (blocked) {
          this.showErrorMessage(t('files.blocked', { folder: blockedFolderLabel(blocked) }));
        } else {
          logger.error(`preview failed: ${response.status}`, new Error(body));
        }
      }
    } catch (error) {
      logger.error('error loading preview:', error);
    } finally {
      this.previewLoading = false;
    }
  }

  /** The image as a blob URL ('' on failure); the caller decides whether it's still wanted. */
  private async loadImageObjectUrl(url: string, headers: Record<string, string>): Promise<string> {
    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        logger.error(`image fetch failed: ${response.status}`);
        return '';
      }
      return URL.createObjectURL(await response.blob());
    } catch (error) {
      logger.error('error loading image:', error);
      return '';
    }
  }

  private revokeImageObjectUrl() {
    if (this.imageObjectUrl) {
      URL.revokeObjectURL(this.imageObjectUrl);
      this.imageObjectUrl = '';
    }
  }

  private async loadDiff(file: FileInfo) {
    if (file.type === 'directory' || !file.gitStatus || file.gitStatus === 'unchanged') return;

    // 2026-11-10: a slow diff for an earlier file used to land on the file shown next.
    const seq = ++this.diffSeq;
    this.previewLoading = true;
    this.showDiff = true;

    try {
      // Load both the unified diff and the full content for Monaco
      const headers = this.noAuthMode ? {} : { ...authClient.getAuthHeader() };
      const [diffResponse, contentResponse] = await Promise.all([
        fetch(`/api/fs/diff?path=${encodeURIComponent(file.path)}`, {
          headers,
        }),
        fetch(`/api/fs/diff-content?path=${encodeURIComponent(file.path)}`, {
          headers,
        }),
      ]);

      const diff = diffResponse.ok ? await diffResponse.json() : undefined;
      const content = contentResponse.ok ? await contentResponse.json() : undefined;
      if (seq !== this.diffSeq) return;
      if (diff !== undefined) this.diff = diff;
      if (content !== undefined) this.diffContent = content;
    } catch (error) {
      if (seq !== this.diffSeq) return;
      logger.error('error loading diff:', error);
    } finally {
      if (seq === this.diffSeq) this.previewLoading = false;
    }
  }

  /**
   * Files in the current directory narrowed by the search box: every word, any order, without
   * case or accents (user report 2026-10-14: «inscripcion» missed «inscripción»).
   */
  private get visibleFiles(): FileInfo[] {
    const terms = queryTerms(this.filterQuery);
    const files = terms.length
      ? this.files.filter((file) => nameMatches(file.name, terms))
      : this.files;
    if (this.sortBy !== 'recent') return files;
    // Newest first, folders mixed in: "what did the agent just touch?"
    return [...files].sort((a, b) => (Date.parse(b.modified) || 0) - (Date.parse(a.modified) || 0));
  }

  private handleSearchInput(value: string) {
    this.filterQuery = value;
    this.scheduleGlobalSearch();
  }

  /** Cancels any pending or running "On this Mac" search and hides its results. */
  private resetGlobalSearch() {
    clearTimeout(this.globalSearchTimer);
    this.globalSearchAbort?.abort();
    this.globalSearchAbort = undefined;
    this.globalResults = [];
    this.globalStatus = 'idle';
    this.globalTruncated = false;
    this.globalBlocked = [];
  }

  /** Debounced: each keystroke cancels the previous request so stale answers never show. */
  private scheduleGlobalSearch() {
    const query = this.filterQuery.trim();
    clearTimeout(this.globalSearchTimer);
    this.globalSearchAbort?.abort();
    this.globalSearchAbort = undefined;
    if (query.length < GLOBAL_SEARCH_MIN_CHARS) {
      this.resetGlobalSearch();
      return;
    }
    this.globalStatus = 'loading';
    this.globalSearchTimer = setTimeout(() => {
      void this.runGlobalSearch(query);
    }, GLOBAL_SEARCH_DEBOUNCE_MS);
  }

  private async runGlobalSearch(query: string) {
    const controller = new AbortController();
    this.globalSearchAbort = controller;
    try {
      const headers = this.noAuthMode ? {} : { ...authClient.getAuthHeader() };
      const response = await fetch(`/api/fs/search?q=${encodeURIComponent(query)}`, {
        headers,
        signal: controller.signal,
      });
      if (controller.signal.aborted || this.globalSearchAbort !== controller) return;
      if (!response.ok) {
        logger.warn(`global search failed: ${response.status}`);
        this.globalResults = [];
        this.globalStatus = 'error';
        return;
      }
      const data: { results?: GlobalSearchHit[]; truncated?: boolean; blocked?: unknown[] } =
        await response.json();
      if (controller.signal.aborted || this.globalSearchAbort !== controller) return;
      this.globalResults = data.results ?? [];
      this.globalTruncated = Boolean(data.truncated);
      this.globalBlocked = (data.blocked ?? [])
        .map(asBlockedFolder)
        .filter((entry): entry is BlockedFolder => entry !== null);
      this.globalStatus = 'done';
    } catch (error) {
      if (controller.signal.aborted) return;
      logger.warn('global search error:', error);
      this.globalResults = [];
      this.globalStatus = 'error';
    } finally {
      if (this.globalSearchAbort === controller) this.globalSearchAbort = undefined;
    }
  }

  /** "On this Mac" hits not already listed above (the open folder's own matches). */
  private get globalHits(): GlobalSearchHit[] {
    const here = (this.currentFullPath || '').replace(/\/+$/, '');
    return this.globalResults.filter((hit) => parentDirectoryOf(hit.path) !== here);
  }

  /**
   * Opens a hit like any file in the browser: lists its folder and selects it there, so the
   * preview, Copy Path and Insert Path work as usual. A folder is simply opened.
   */
  private async openGlobalHit(hit: GlobalSearchHit) {
    if (hit.type === 'directory') {
      await this.loadDirectory(hit.path);
      return;
    }
    const folder = parentDirectoryOf(hit.path);
    await this.loadDirectory(folder);
    const listed = this.currentFullPath === folder && this.files.find((f) => f.name === hit.name);
    this.handleFileClick(
      listed || {
        name: hit.name,
        path: hit.path,
        type: 'file',
        size: hit.size,
        modified: hit.modified,
      }
    );
  }

  private toggleSort() {
    this.sortBy = this.sortBy === 'recent' ? 'name' : 'recent';
    try {
      localStorage.setItem(SORT_STORAGE_KEY, this.sortBy);
    } catch {
      // Private mode / blocked storage: the choice just won't persist
    }
  }

  private handleFileClick(file: FileInfo) {
    if (file.type === 'directory') {
      // Use the absolute path provided by the server
      this.loadDirectory(file.path);
    } else {
      // Clear previous state when selecting a new file
      if (this.selectedFile?.path !== file.path) {
        this.preview = null;
        this.diff = null;
        this.diffContent = null;
        this.showDiff = false;
      }
      // Set the selected file
      this.selectedFile = file;
      // On mobile, switch to preview view
      if (this.isMobile) {
        this.mobileView = 'preview';
      }
      // Always show file content by default, regardless of git filter
      this.loadPreview(file);
    }
  }

  private async handleCopyToClipboard(text: string) {
    const success = await copyToClipboard(text);
    if (success) {
      logger.debug(`copied to clipboard: ${text}`);
    } else {
      logger.error('failed to copy to clipboard');
    }
    // On a phone there's no other sign the tap did anything
    this.copyFeedback = success ? 'copied' : 'failed';
    clearTimeout(this.copyFeedbackTimer);
    this.copyFeedbackTimer = setTimeout(() => {
      this.copyFeedback = '';
    }, 1500);
  }

  /**
   * file.path is relative to the server's cwd (e.g. "../../Users/me/x.ts"),
   * useless outside the server; join the listed directory with the name.
   */
  private absolutePathOf(file: FileInfo): string {
    if (this.currentFullPath && file.name) {
      return this.currentFullPath.endsWith('/')
        ? this.currentFullPath + file.name
        : `${this.currentFullPath}/${file.name}`;
    }
    // Fallback to relative path if absolute path construction fails
    return file.path;
  }

  private insertPathIntoTerminal() {
    if (!this.selectedFile) return;

    const absolutePath = this.absolutePathOf(this.selectedFile);

    // Dispatch event with the absolute file path
    this.dispatchEvent(
      new CustomEvent('insert-path', {
        detail: {
          path: absolutePath,
          type: this.selectedFile.type,
        },
        bubbles: true,
        composed: true,
      })
    );

    // Close the file browser
    this.dispatchEvent(new CustomEvent('browser-cancel'));
  }

  private showErrorMessage(message: string) {
    this.errorMessage = message;
    // Clear error message after 5 seconds
    setTimeout(() => {
      this.errorMessage = '';
    }, 5000);
  }

  private handleParentClick() {
    // Handle navigation to parent directory
    let parentPath: string;

    if (this.currentFullPath === '/') {
      // Already at root, can't go higher
      return;
    }

    if (this.currentFullPath) {
      // Use full path for accurate parent calculation
      const parts = this.currentFullPath.split('/').filter((part) => part !== '');
      if (parts.length === 0) {
        // We're at root
        parentPath = '/';
      } else {
        // Remove last part to get parent
        parts.pop();
        parentPath = parts.length === 0 ? '/' : `/${parts.join('/')}`;
      }
    } else {
      // Fallback to current path logic
      const parts = this.currentPath.split('/').filter((part) => part !== '');
      if (parts.length <= 1) {
        parentPath = '/';
      } else {
        parts.pop();
        parentPath = `/${parts.join('/')}`;
      }
    }

    this.loadDirectory(parentPath);
  }

  private toggleGitFilter() {
    this.gitFilter = this.gitFilter === 'all' ? 'changed' : 'all';
    this.loadDirectory(this.currentPath);
  }

  private toggleHidden() {
    this.showHidden = !this.showHidden;
    this.loadDirectory(this.currentPath);
  }

  private toggleDiff() {
    if (this.selectedFile?.gitStatus && this.selectedFile.gitStatus !== 'unchanged') {
      if (this.showDiff) {
        this.loadPreview(this.selectedFile);
      } else {
        this.loadDiff(this.selectedFile);
      }
    }
  }

  private handleSelect() {
    if (this.mode === 'select' && this.currentPath) {
      this.dispatchEvent(
        new CustomEvent('directory-selected', {
          detail: this.currentFullPath || this.currentPath,
        })
      );
    }
  }

  private handleCancel() {
    this.dispatchEvent(new CustomEvent('browser-cancel'));
  }

  /** Ancestors of the current folder (home collapsed to ~), each with the path to jump to. */
  private get breadcrumbs(): Array<{ label: string; path: string }> {
    const fullPath = this.currentFullPath || this.currentPath;
    if (!fullPath) return [];
    const display = formatPathForDisplay(fullPath);
    const crumbs: Array<{ label: string; path: string }> = [];
    let base: string;
    let rest: string;
    if (display.startsWith('~') && fullPath.startsWith('/')) {
      base = fullPath.slice(0, fullPath.length - (display.length - 1)) || '/';
      rest = display.slice(1);
      crumbs.push({ label: '~', path: base });
    } else if (fullPath.startsWith('/')) {
      base = '';
      rest = fullPath;
      crumbs.push({ label: '/', path: '/' });
    } else {
      // Relative or Windows path: nothing reliable to split, show it whole
      return [{ label: display, path: fullPath }];
    }
    let current = base.replace(/\/$/, '');
    for (const part of rest.split('/').filter(Boolean)) {
      current = `${current}/${part}`;
      crumbs.push({ label: part, path: current });
    }
    return crumbs;
  }

  /**
   * Marks the path bar while scrolled away from its start, so CSS fades the cut segment on the
   * left (2026-10-12 QA: it read as a broken glyph, "ꜟojects").
   */
  private markCrumbsScrolled = () => {
    const nav = this.breadcrumbsRef.value;
    if (!nav) return;
    nav.toggleAttribute('data-scrolled', nav.scrollLeft > 1);
  };

  private renderBreadcrumbs(tap: string) {
    const crumbs = this.breadcrumbs;
    const fullPath = this.currentFullPath || this.currentPath || t('files.title');
    return html`
      <nav
        ${ref(this.breadcrumbsRef)}
        class="fb-crumbs flex items-center min-w-0 overflow-x-auto whitespace-nowrap font-mono text-[13px] text-text-muted"
        style="scrollbar-width: none;"
        dir="ltr"
        @scroll=${this.markCrumbsScrolled}
        aria-label=${fullPath}
      >
        ${
          crumbs.length === 0
            ? html`<span class="px-1">${t('files.title')}</span>`
            : crumbs.map((crumb, i) => {
                const last = i === crumbs.length - 1;
                return html`
                  ${i > 1 || (i === 1 && crumbs[0].label !== '/') ? html`<span class="text-text-dim">/</span>` : ''}
                  <button
                    class="ut-surface--badge fb-crumb flex-shrink-0 rounded-chip px-1 py-0.5 hover:bg-surface-hover ${tap} ${
                      last ? 'text-text font-medium' : 'text-text-muted hover:text-text'
                    }"
                    title=${last ? t('files.clickToEdit', { path: fullPath }) : crumb.path}
                    @click=${() => (last ? this.handlePathClick() : this.loadDirectory(crumb.path))}
                  >
                    ${crumb.label}
                  </button>
                `;
              })
        }
      </nav>
    `;
  }

  private renderPreview() {
    if (this.previewLoading) {
      return html`
        <div class="flex flex-col gap-2 p-4 h-full" aria-busy="true">
          <span class="sr-only">${t('files.loadingPreview')}</span>
          <div class="ut-skeleton h-4 w-2/3"></div>
          <div class="ut-skeleton h-4 w-1/2"></div>
          <div class="ut-skeleton h-4 w-3/4"></div>
        </div>
      `;
    }

    if (this.showDiff && (this.diff || this.diffContent)) {
      return this.renderDiff();
    }

    if (!this.preview) {
      return html`
        <div class="flex flex-col items-center justify-center gap-3 h-full text-text-muted" data-testid="file-preview-empty">
          <span class="text-text-dim">${icon('fileText', 40)}</span>
          <div class="text-ui">${t('files.selectFile')}</div>
          ${
            this.isMobile
              ? nothing
              : html`<div class="flex items-center gap-1.5 text-caption text-text-dim">
                  <kbd class="ut-kbd">${formatShortcut('esc')}</kbd> ${t('common.close')}
                </div>`
          }
        </div>
      `;
    }

    switch (this.preview.type) {
      case 'image':
        return html`
          <div class="flex items-center justify-center p-4 h-full">
            <img
              src="${this.imageObjectUrl || this.preview.url}"
              alt="${this.selectedFile?.name}"
              class="max-w-full max-h-full object-contain rounded-rem"
            />
          </div>
        `;

      case 'text':
        return html`
          <monaco-editor
            ${ref(this.editorRef)}
            .content=${this.preview.content || ''}
            .language=${this.preview.language || ''}
            .filename=${this.selectedFile?.name || ''}
            .readOnly=${true}
            .options=${editorOptions(this.isMobile)}
            mode="normal"
            class="h-full w-full"
          ></monaco-editor>
        `;

      case 'binary':
        return html`
          <div class="flex flex-col items-center justify-center h-full text-text-muted">
            ${UIIcons.binary}
            <div class="text-lg mb-2">${t('files.binary')}</div>
            <div class="text-sm">${this.preview.humanSize || t('files.bytes', { size: this.preview.size })}</div>
            <div class="text-sm text-text-muted mt-2">
              ${this.preview.mimeType || t('files.unknownType')}
            </div>
          </div>
        `;
    }
  }

  private renderDiff() {
    // For new files (added or untracked), we might not have a diff but we have diffContent
    if (!this.diffContent && !this.diff?.diff) {
      return html`
        <div class="flex items-center justify-center h-full text-text-muted">
          ${t('files.noChanges')}
        </div>
      `;
    }

    // If we have diff content, show it in Monaco's diff editor
    if (this.diffContent) {
      return html`
        <monaco-editor
          ${ref(this.editorRef)}
          .originalContent=${this.diffContent.originalContent || ''}
          .modifiedContent=${this.diffContent.modifiedContent || ''}
          .language=${this.diffContent.language || ''}
          .filename=${this.selectedFile?.name || ''}
          .readOnly=${true}
          .options=${editorOptions(this.isMobile)}
          mode="diff"
          .showModeToggle=${true}
          class="h-full w-full"
        ></monaco-editor>
      `;
    }

    // Fallback to simple diff display
    if (!this.diff) return html``;
    const lines = this.diff.diff.split('\n');
    return html`
      <div class="overflow-auto h-full p-4 font-mono text-xs">
        ${lines.map((line) => {
          let className = 'text-text-muted';
          if (line.startsWith('+')) className = 'text-status-success bg-status-success/10';
          else if (line.startsWith('-')) className = 'text-status-error bg-status-error/10';
          else if (line.startsWith('@@')) className = 'text-status-info font-semibold';

          return html`<div class="whitespace-pre ${className}">${line}</div>`;
        })}
      </div>
    `;
  }

  private renderToggle(on: boolean, label: string, title: string, toggle: () => void, tap: string) {
    return html`<button
      type="button"
      class="ut-surface--control fb-toggle ${tap}"
      aria-pressed=${on ? 'true' : 'false'}
      title=${title}
      @click=${toggle}
    >
      ${on ? icon('check', 12) : nothing}<span class="fb-toggle-label">${label}</span>
    </button>`;
  }

  /** The "On this Mac" section under the folder's own matches while searching. */
  private renderGlobalResults(tap: string) {
    if (this.globalStatus === 'idle') return nothing;
    const hits = this.globalHits;
    let status: unknown = nothing;
    if (this.globalStatus === 'loading') {
      status = html`<div class="fb-section-note" aria-live="polite">${t('files.global.searching')}</div>`;
    } else if (this.globalStatus === 'error') {
      status = html`<div class="fb-section-note" role="status">${t('files.global.error')}</div>`;
    } else if (hits.length === 0) {
      status = html`<div class="fb-section-note" role="status" data-testid="file-browser-global-empty">
        ${t('files.global.empty')}
      </div>`;
    }
    // Partial results: macOS kept some folders out (privacy prompt pending or denied).
    const blockedNote =
      this.globalStatus === 'done' && this.globalBlocked.length > 0
        ? html`<div
            class="fb-section-note"
            role="status"
            id="file-browser-global-blocked"
            data-testid="file-browser-global-blocked"
          >
            ${t('files.global.blocked', {
              folders: this.globalBlocked.map(blockedFolderLabel).join(', '),
            })}
          </div>`
        : nothing;
    return html`
      <section id="file-browser-global-results" data-testid="file-browser-global-results" aria-labelledby="file-browser-global-title">
        <div class="fb-section-title" id="file-browser-global-title">
          <span>${t('files.global.title')}</span>
          ${
            this.globalStatus === 'done' && this.globalTruncated && hits.length > 0
              ? html`<span class="fb-section-count">${t('files.global.more', { n: hits.length })}</span>`
              : nothing
          }
        </div>
        ${status}
        ${blockedNote}
        ${
          this.globalStatus === 'loading' && hits.length === 0
            ? nothing
            : hits.map(
                (hit) => html`
                  <div
                    class="fb-row fb-row--hit ${this.isMobile ? 'fb-row--touch' : ''} ${tap}"
                    data-testid="file-browser-global-row"
                    data-path=${hit.path}
                    role="button"
                    tabindex="0"
                    @click=${() => this.openGlobalHit(hit)}
                    @keydown=${(e: KeyboardEvent) => {
                      // Only the row itself: Enter on the inner folder button bubbles here too,
                      // and must not also open the file.
                      if (e.target !== e.currentTarget) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        this.openGlobalHit(hit);
                      }
                    }}
                  >
                    <span class="fb-icon">${getFileIcon(hit.name, hit.type)}</span>
                    <span class="flex-1 min-w-0 flex flex-col">
                      <span class="fb-hit-name" title=${hit.path} dir="auto">${hit.name}</span>
                      <span class="fb-hit-meta" dir="auto">
                        ${hitPlaceLabel(hit)}${hit.modified ? html` · <span class="tnum">${formatShortDate(hit.modified)}</span>` : nothing}
                      </span>
                    </span>
                    <button
                      type="button"
                      class="ut-surface--control fb-hit-folder"
                      data-testid="file-browser-global-folder"
                      title=${t('files.global.showInFolder')}
                      aria-label=${t('files.global.showInFolder')}
                      @click=${(e: Event) => {
                        e.stopPropagation();
                        this.loadDirectory(parentDirectoryOf(hit.path));
                      }}
                    >
                      ${icon('folder', 16)}
                    </button>
                  </div>
                `
              )
        }
      </section>
    `;
  }

  /** macOS privacy holds the folder: how to allow it, and a retry. */
  private renderBlocked(blocked: BlockedFolder & { path: string }) {
    return html`
      <div
        class="flex flex-col items-center text-center gap-3 px-6 py-10"
        id="file-browser-blocked"
        data-testid="file-browser-blocked"
        data-error=${blocked.error}
        role="alert"
      >
        <span class="text-text-dim">${icon('folder', 32)}</span>
        <p class="m-0 text-ui text-text-muted" dir="auto">
          ${t('files.blocked', { folder: blockedFolderLabel(blocked) })}
        </p>
        <div class="flex gap-2 flex-wrap justify-center">
          <button
            type="button"
            class="ut-btn ut-btn--primary"
            id="file-browser-blocked-retry"
            data-testid="file-browser-blocked-retry"
            @click=${() => this.loadDirectory(blocked.path)}
          >
            ${t('files.blocked.retry')}
          </button>
          <button
            type="button"
            class="ut-btn ut-btn--secondary"
            data-testid="file-browser-blocked-home"
            @click=${() => this.loadDirectory('~')}
          >
            ${t('files.goHome')}
          </button>
        </div>
      </div>
    `;
  }

  private renderMissing() {
    return html`
      <div class="flex flex-col items-center text-center gap-3 px-6 py-10" data-testid="file-browser-missing">
        <span class="text-text-dim">${icon('folder', 32)}</span>
        <p class="m-0 text-ui text-text-muted break-all" dir="auto">
          ${t('files.notFound', { path: formatPathForDisplay(this.missingPath) })}
        </p>
        <button
          type="button"
          class="ut-btn ut-btn--secondary"
          data-testid="file-browser-go-home"
          @click=${() => this.loadDirectory('~')}
        >
          ${t('files.goHome')}
        </button>
      </div>
    `;
  }

  render() {
    if (!this.visible) {
      return html``;
    }

    // Phones get 44px-tall controls (Apple HIG minimum); desktop keeps the dense look
    const tap = this.isMobile ? 'min-h-[44px]' : '';

    return html`
      <div class="fixed inset-0 bg-bg/80 backdrop-blur-sm flex items-center justify-center" style="z-index: ${Z_INDEX.FILE_BROWSER};" @click=${this.handleCancel}>
        <div class="fixed inset-0 bg-bg flex flex-col" style="z-index: ${Z_INDEX.FILE_BROWSER};" @click=${(e: Event) => e.stopPropagation()}>
        ${
          this.isMobile && this.mobileView === 'preview'
            ? html`
              <div class="absolute top-1/2 left-2 -translate-y-1/2 text-text-muted opacity-50">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M11 19l-7-7 7-7m8 14l-7-7 7-7"
                  ></path>
                </svg>
              </div>
            `
            : ''
        }
        <div
          class="w-full h-full flex flex-col overflow-hidden ut-surface--panel"
          data-testid="file-browser"
        >
          <!-- Compact Header (like session-view) -->
          <div
            class="ut-surface--bar flex items-center justify-between px-3 ${this.isMobile ? 'py-2' : 'min-h-11'} border-b border-border text-ui font-ui min-w-0 bg-bg-secondary flex-none"
            style="min-height: var(--ut-compact-bar-h, 0px); padding-top: max(0.5rem, env(safe-area-inset-top)); padding-left: max(0.75rem, env(safe-area-inset-left)); padding-right: max(0.75rem, env(safe-area-inset-right));"
          >
            <div class="flex items-center gap-3 min-w-0 flex-1">
              ${
                // Phones: one leading back that names where it goes, "‹ <session>", in text
                // color (phone spec 4.2, 2026-10-12).
                this.isMobile && this.session
                  ? html`<button
                      type="button"
                      class="ut-surface--control fb-phone-back flex-shrink-0"
                      @click=${this.handleCancel}
                      aria-label=${t('previewView.backToLabel', { name: sessionDisplayTitle(this.session) })}
                      data-testid="file-browser-back"
                    >
                      ${icon('chevronLeft', 22)}
                      <span class="fb-phone-back-name" dir="auto">${sessionDisplayTitle(this.session)}</span>
                    </button>`
                  : html`<button
                      type="button"
                      class="ut-btn ut-btn--ghost ut-btn--sm flex-shrink-0 ${tap}"
                      @click=${this.handleCancel}
                      title=${`${t('header.back')} (⎋)`}
                      data-testid="file-browser-back"
                    >
                      ${icon('chevronLeft')}
                      <span>${t('header.back')}</span>
                    </button>`
              }
              <div class="min-w-0 flex-1 overflow-hidden flex items-center gap-2">
                ${
                  this.editingPath
                    ? html`
                      <input
                        ${ref(this.pathInputRef)}
                        type="text"
                        .value=${this.pathInputValue}
                        @input=${this.handlePathInput}
                        @keydown=${this.handlePathKeyDown}
                        @blur=${this.handlePathBlur}
                        class="ut-field ut-field--mono h-7 ${this.isMobile ? 'text-base' : ''} w-full min-w-0"
                        placeholder=${t('files.pathPlaceholder')}
                        dir="ltr"
                      />
                    `
                    : this.renderBreadcrumbs(tap)
                }
                ${
                  this.gitStatus?.branch
                    ? html`
                      <span
                        class="ut-chip ut-chip--mono flex-shrink-0 max-w-[35%] min-w-0"
                        title=${this.gitStatus.branch}
                      >
                        ${icon('gitBranch', 12)} <span class="truncate">${this.gitStatus.branch}</span>
                      </span>
                    `
                    : ''
                }
              </div>
            </div>
          </div>
          ${
            // Full-width row so a long error doesn't squeeze the path to nothing on a phone
            this.errorMessage
              ? html`
                <div
                  class="bg-status-error/10 border-b border-border text-status-error px-3 py-2 text-caption break-words"
                  role="alert"
                >
                  ${this.errorMessage}
                </div>
              `
              : ''
          }

          <!-- Main content -->
          <div class="flex-1 flex overflow-hidden">
            <!-- File list -->
            <div
              class="${this.isMobile && this.mobileView === 'preview' ? 'hidden' : ''} ${
                this.isMobile ? 'w-full' : 'w-[340px]'
              } bg-bg-secondary border-r border-border flex flex-col font-ui"
            >
              <!-- File list header: compact toggles and the name filter -->
              <div class="border-b border-border px-3 py-2 space-y-2">
                <div class="fb-toggles" role="group" aria-label=${t('files.filter')}>
                  ${this.renderToggle(this.gitFilter === 'changed', t('files.gitChanges'), t('files.gitChanges.title'), this.toggleGitFilter, tap)}
                  ${this.renderToggle(this.showHidden, t('files.hidden'), t('files.hidden.title'), this.toggleHidden, tap)}
                  ${this.renderToggle(this.sortBy === 'recent', t('files.sortRecent'), t('files.sortRecent.title'), this.toggleSort, tap)}
                </div>
                <input
                  type="search"
                  enterkeyhint="search"
                  autocapitalize="off"
                  autocorrect="off"
                  autocomplete="off"
                  spellcheck="false"
                  class="ut-field ${
                    // iOS zooms the page when focusing an input under 16px
                    this.isMobile ? 'text-base min-h-[44px]' : 'h-7'
                  }"
                  id="file-browser-search"
                  placeholder=${t('files.search')}
                  aria-label=${t('files.search')}
                  .value=${this.filterQuery}
                  @input=${(e: Event) => this.handleSearchInput((e.target as HTMLInputElement).value)}
                />
              </div>

              <!-- File list content -->
              <div
                class="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent hover:scrollbar-thumb-white/30"
                style=${this.mode === 'browse' ? 'padding-bottom: env(safe-area-inset-bottom);' : ''}
              >
                ${
                  this.loading
                    ? html`
                      <div class="p-3 space-y-2" aria-busy="true">
                        <span class="sr-only">${t('files.loading')}</span>
                        ${[0, 1, 2, 3, 4].map(() => html`<div class="ut-skeleton h-5"></div>`)}
                      </div>
                    `
                    : this.blockedFolder
                      ? this.renderBlocked(this.blockedFolder)
                      : this.missingPath
                        ? this.renderMissing()
                        : html`
                      ${
                        this.currentFullPath !== '/'
                          ? html`
                            <div
                              class="fb-row ${this.isMobile ? 'fb-row--touch' : ''} ${tap}"
                              @click=${this.handleParentClick}
                            >
                              <span class="fb-icon">${getParentDirectoryIcon()}</span>
                              <span class="text-text-muted">..</span>
                            </div>
                          `
                          : ''
                      }
                      ${
                        this.globalStatus !== 'idle'
                          ? html`<div class="fb-section-title" id="file-browser-folder-results-title">
                              ${t('files.inThisFolder')}
                            </div>`
                          : ''
                      }
                      ${
                        this.filterQuery.trim() && this.visibleFiles.length === 0
                          ? html`<div class="p-3 text-caption text-text-muted">${t('files.filterEmpty')}</div>`
                          : ''
                      }
                      ${this.visibleFiles.map(
                        (file) => html`
                          <div
                            class="fb-row ${this.isMobile ? 'fb-row--touch' : ''} ${tap}"
                            aria-selected=${this.selectedFile?.path === file.path ? 'true' : 'false'}
                            @click=${() => this.handleFileClick(file)}
                          >
                            <span class="fb-icon flex-shrink-0 relative">
                              ${getFileIcon(file.name, file.type)}
                              ${
                                file.isSymlink
                                  ? html`
                                    <svg
                                      class="w-3 h-3 text-text-muted absolute -bottom-1 -right-1"
                                      fill="currentColor"
                                      viewBox="0 0 20 20"
                                    >
                                      <path
                                        fill-rule="evenodd"
                                        d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5zm-5 5a2 2 0 012.828 0 1 1 0 101.414-1.414 4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5a1 1 0 10-1.414-1.414l-1.5 1.5a2 2 0 11-2.828-2.828l3-3z"
                                        clip-rule="evenodd"
                                      />
                                    </svg>
                                  `
                                  : ''
                              }
                            </span>
                            <span
                              class="flex-1 min-w-0 truncate text-text"
                              title="${file.name}${file.isSymlink ? ` (${t('files.symlink')})` : ''}"
                              >${file.name}</span
                            >
                            ${
                              this.sortBy === 'recent'
                                ? html`<span class="flex-shrink-0 text-caption tnum text-text-dim"
                                    >${formatModifiedAgo(file.modified)}</span
                                  >`
                                : ''
                            }
                            <span class="flex-shrink-0"
                              >${renderGitStatusBadge(file.gitStatus)}</span
                            >
                          </div>
                        `
                      )}
                      ${this.renderGlobalResults(tap)}
                    `
                }
              </div>
            </div>

            <!-- Preview pane -->
            <div
              class="${this.isMobile && this.mobileView === 'list' ? 'hidden' : ''} ${
                this.isMobile ? 'w-full' : 'flex-1'
              } bg-bg flex flex-col overflow-hidden"
            >
              ${
                this.selectedFile
                  ? html`
                    <div
                      class="bg-bg-secondary border-b border-border px-3 ${this.isMobile ? 'py-3' : 'h-11'} font-ui ${
                        this.isMobile ? 'space-y-2' : 'flex items-center justify-between'
                      }"
                    >
                      <div class="flex items-center gap-2 ${this.isMobile ? 'min-w-0' : ''}">
                        ${
                          this.isMobile
                            ? html`
                              <button
                                @click=${() => {
                                  this.mobileView = 'list';
                                }}
                                class="text-text-muted hover:text-primary transition-colors flex-shrink-0 flex items-center justify-center min-w-[44px] min-h-[44px] -my-2 -ml-2"
                                title=${t('files.backToFiles')}
                                aria-label=${t('files.backToFiles')}
                              >
                                <svg
                                  class="w-5 h-5"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    stroke-width="2"
                                    d="M15 19l-7-7 7-7"
                                  ></path>
                                </svg>
                              </button>
                            `
                            : ''
                        }
                        <span class="fb-icon flex-shrink-0 relative"
                          >${getFileIcon(this.selectedFile.name, this.selectedFile.type)}
                          ${
                            this.selectedFile.isSymlink
                              ? html`
                                <svg
                                  class="w-3 h-3 text-text-muted absolute -bottom-1 -right-1"
                                  fill="currentColor"
                                  viewBox="0 0 20 20"
                                >
                                  <path
                                    fill-rule="evenodd"
                                    d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5zm-5 5a2 2 0 012.828 0 1 1 0 101.414-1.414 4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5a1 1 0 10-1.414-1.414l-1.5 1.5a2 2 0 11-2.828-2.828l3-3z"
                                    clip-rule="evenodd"
                                  />
                                </svg>
                              `
                              : ''
                          }
                        </span>
                        <span class="font-mono text-[13px] text-text ${this.isMobile ? 'truncate' : ''}"
                          >${this.selectedFile.name}${this.selectedFile.isSymlink ? ' →' : ''}</span
                        >
                        ${renderGitStatusBadge(this.selectedFile.gitStatus)}
                      </div>
                      <div
                        class="${
                          this.isMobile ? 'grid grid-cols-2 gap-2' : 'flex gap-2 flex-shrink-0'
                        }"
                      >
                        ${
                          this.selectedFile.type === 'file'
                            ? html`
                              <button
                                class="ut-btn ut-btn--secondary ut-btn--sm ${tap}"
                                @click=${() =>
                                  this.selectedFile &&
                                  this.handleCopyToClipboard(
                                    this.absolutePathOf(this.selectedFile)
                                  )}
                                title=${`${t('files.copyPath.title')} (⌘C)`}
                              >
                                ${
                                  this.copyFeedback === 'copied'
                                    ? t('files.copied')
                                    : this.copyFeedback === 'failed'
                                      ? t('files.copyFailed')
                                      : t('files.copyPath')
                                }
                              </button>
                              ${
                                this.mode === 'browse'
                                  ? html`
                                    <button
                                      class="ut-btn ut-btn--primary ut-btn--sm ${tap}"
                                      @click=${this.insertPathIntoTerminal}
                                      title=${`${t('files.insertPath.title')} (Enter)`}
                                    >
                                      ${t('files.insertPath')}
                                    </button>
                                  `
                                  : ''
                              }
                            `
                            : ''
                        }
                        ${
                          this.selectedFile.gitStatus && this.selectedFile.gitStatus !== 'unchanged'
                            ? html`
                              <button
                                aria-pressed=${this.showDiff ? 'true' : 'false'}
                                class="ut-btn ut-btn--secondary ut-btn--sm ${tap} ${
                                  this.isMobile &&
                                  this.selectedFile.type === 'file' &&
                                  this.mode === 'browse'
                                    ? ''
                                    : 'col-span-2'
                                }"
                                @click=${this.toggleDiff}
                              >
                                ${this.showDiff ? t('files.viewFile') : t('files.viewDiff')}
                              </button>
                            `
                            : ''
                        }
                      </div>
                    </div>
                  `
                  : ''
              }
              <div class="flex-1 overflow-hidden">${this.renderPreview()}</div>
            </div>
          </div>

          ${
            this.mode === 'select'
              ? html`
                <div
                  class="px-4 py-3 border-t border-border flex gap-3 bg-bg-secondary"
                  style="padding-bottom: max(1rem, env(safe-area-inset-bottom));"
                >
                  <button class="ut-btn ut-btn--ghost ut-btn--lg flex-1 justify-center" @click=${this.handleCancel}>
                    ${t('common.cancel')}
                  </button>
                  <button class="ut-btn ut-btn--primary ut-btn--lg flex-1 justify-center" @click=${this.handleSelect}>
                    ${t('files.selectDirectory')}
                  </button>
                </div>
              `
              : ''
          }
        </div>
        </div>
      </div>
    `;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('theme-changed', syncMonacoTheme);
    this.removeTouchHandlers();
    this.revokeImageObjectUrl();
    clearTimeout(this.copyFeedbackTimer);
    this.resetGlobalSearch();
  }

  private async checkAuthConfig() {
    try {
      const response = await fetch('/api/auth/config');
      if (response.ok) {
        const config = await response.json();
        this.noAuthMode = config.noAuth === true;
        logger.debug('Auth config:', config);
      }
    } catch (error) {
      logger.error('Failed to fetch auth config:', error);
    }
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    if (!this.visible) return;
    // Enter/⌘C inside the filter or path field belong to that field
    const target = e.target as HTMLElement | null;
    const inField = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';

    if (e.key === 'Escape') {
      // 2026-11-11: closing was left to a modal-wrapper this component stopped rendering in,
      // so Escape did nothing though the Back button ("Back (⎋)") and the preview's hint
      // ("Esc Close") promise it. An Escape something inside already took (the editor's
      // find box) stays there.
      if (e.defaultPrevented) return;
      e.preventDefault();
      // Its Escape only: the app's own would also leave the session under it, and the create
      // form's would close the form whose folder picker this is.
      e.stopImmediatePropagation();
      if (this.editingPath) {
        this.cancelPathEdit();
      } else {
        this.handleCancel();
      }
    } else if (
      e.key === 'Enter' &&
      !e.defaultPrevented && // a focused row/button already handled this Enter (2026-11-10)
      this.selectedFile &&
      this.selectedFile.type === 'file' &&
      !this.editingPath &&
      !inField
    ) {
      e.preventDefault();
      this.insertPathIntoTerminal();
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'c' && this.selectedFile && !inField) {
      e.preventDefault();
      this.handleCopyToClipboard(this.absolutePathOf(this.selectedFile));
    }
  };

  private handleResize = () => {
    this.isMobile = window.innerWidth < 768;
    if (!this.isMobile && this.mobileView === 'preview') {
      this.mobileView = 'list';
    }
  };

  private touchStartX = 0;
  private touchStartY = 0;

  private setupTouchHandlers() {
    if (!this.isMobile) return;

    const handleTouchStart = (e: TouchEvent) => {
      this.touchStartX = e.touches[0].clientX;
      this.touchStartY = e.touches[0].clientY;
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (!this.visible || !this.isMobile) return;

      const deltaX = e.changedTouches[0].clientX - this.touchStartX;
      const deltaY = Math.abs(e.changedTouches[0].clientY - this.touchStartY);

      // Only handle horizontal swipes
      if (Math.abs(deltaX) > 50 && deltaY < 50) {
        if (deltaX > 0) {
          // Swipe right
          if (this.mobileView === 'preview') {
            this.mobileView = 'list';
          } else {
            this.handleCancel();
          }
        }
      }
    };

    document.addEventListener('touchstart', handleTouchStart);
    document.addEventListener('touchend', handleTouchEnd);

    // Store handlers for removal
    interface TouchHandlers {
      handleTouchStart: (e: TouchEvent) => void;
      handleTouchEnd: (e: TouchEvent) => void;
    }
    (this as unknown as { _touchHandlers: TouchHandlers })._touchHandlers = {
      handleTouchStart,
      handleTouchEnd,
    };
  }

  private removeTouchHandlers() {
    interface TouchHandlers {
      handleTouchStart: (e: TouchEvent) => void;
      handleTouchEnd: (e: TouchEvent) => void;
    }
    const handlers = (this as unknown as { _touchHandlers?: TouchHandlers })._touchHandlers;
    if (handlers) {
      document.removeEventListener('touchstart', handlers.handleTouchStart);
      document.removeEventListener('touchend', handlers.handleTouchEnd);
    }
  }

  private handlePathClick() {
    this.editingPath = true;
    this.pathInputValue = this.currentFullPath || this.currentPath || '';
    this.requestUpdate();
    // Focus the input after render
    setTimeout(() => {
      if (this.pathInputRef.value) {
        this.pathInputRef.value.focus();
        this.pathInputRef.value.select();
      }
    }, 0);
  }

  private handlePathInput(e: Event) {
    const input = e.target as HTMLInputElement;
    this.pathInputValue = input.value;
  }

  private handlePathKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.navigateToPath();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.cancelPathEdit();
    }
  }

  private handlePathBlur() {
    // Don't cancel on blur, let user decide with Escape or Enter
    // this.cancelPathEdit();
  }

  private async navigateToPath() {
    const path = this.pathInputValue.trim();
    if (path) {
      this.editingPath = false;
      await this.loadDirectory(path);
    } else {
      this.cancelPathEdit();
    }
  }

  private cancelPathEdit() {
    this.editingPath = false;
    this.pathInputValue = '';
  }
}
