/**
 * Dev-mode stylesheet watcher: rebuilds public/bundle/styles.css when anything the last build
 * read changes, watching each folder Tailwind scans with one recursive fs.watch.
 *
 * 2026-11-02: `postcss --watch` used ~95 % of a core all day on the main checkout. Tailwind v4
 * reports every source it scans (1,300+ files and 8 folders of web/), and postcss-cli handed
 * each one to chokidar 3, which hangs them all as listeners on one FSEvents stream over a
 * parent folder: every file event anywhere below it (git in the shared .git, test runs, other
 * tasks) ran through all 1,300 listeners (89 % of its samples in chokidar's filteredListener).
 * Here a folder is one watcher and the kernel filters by path.
 */
const fs = require('fs');
const path = require('path');

/** Where to watch for `messages` of a build: recursive folders, and files by their folder. */
function watchPlan(input, messages) {
  const dirs = new Set();
  for (const message of messages) {
    if (message.type === 'dir-dependency' && message.dir) dirs.add(path.resolve(message.dir));
  }
  const covered = (file) => {
    for (const dir of dirs) if (file.startsWith(dir + path.sep)) return true;
    return false;
  };
  /** Folder → names in it, for files outside the recursive folders (watched non-recursively). */
  const files = new Map();
  const addFile = (file) => {
    const resolved = path.resolve(file);
    if (covered(resolved)) return;
    const dir = path.dirname(resolved);
    const names = files.get(dir) ?? new Set();
    names.add(path.basename(resolved));
    files.set(dir, names);
  };
  addFile(input);
  for (const message of messages) {
    if (message.type === 'dependency' && message.file) addFile(message.file);
  }
  return { dirs, files };
}

/**
 * Build `input` into `output` with `plugins` now, then again (debounced) on every change to what
 * that build read. `ready` resolves after the first build. `close` stops watching.
 */
function watchStyles({
  input,
  output,
  plugins,
  debounceMs = 150,
  log = (line) => console.error(line),
  watch = fs.watch,
  postcss = require('postcss'),
}) {
  const watchers = new Map();
  let timer = null;
  let running = false;
  let again = false;
  let closed = false;

  const schedule = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void build();
    }, debounceMs);
  };

  const open = (key, dir, recursive, names) => {
    const existing = watchers.get(key);
    if (existing) {
      existing.names = names;
      return;
    }
    try {
      const entry = { names, watcher: null };
      entry.watcher = watch(dir, { recursive }, (_event, filename) => {
        // A folder watched for some of its files: only those (null filename: can't tell).
        if (entry.names && filename && !entry.names.has(path.basename(String(filename)))) return;
        schedule();
      });
      entry.watcher.on?.('error', () => {
        entry.watcher.close();
        watchers.delete(key);
        schedule();
      });
      watchers.set(key, entry);
    } catch (error) {
      // A folder that is gone: the next build looks again.
      if (error?.code !== 'ENOENT') log(`css-watch: cannot watch ${dir}: ${error.message}`);
    }
  };

  const sync = (messages) => {
    const plan = watchPlan(input, messages);
    const wanted = new Set();
    for (const dir of plan.dirs) {
      wanted.add(`r:${dir}`);
      open(`r:${dir}`, dir, true, null);
    }
    for (const [dir, names] of plan.files) {
      wanted.add(`f:${dir}`);
      open(`f:${dir}`, dir, false, names);
    }
    for (const [key, entry] of watchers) {
      if (wanted.has(key)) continue;
      entry.watcher.close();
      watchers.delete(key);
    }
  };

  const build = async () => {
    if (closed) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const css = await fs.promises.readFile(input, 'utf8');
      // Inline map, as `postcss` (the CLI) writes by default.
      const result = await postcss(plugins).process(css, {
        from: input,
        to: output,
        map: { inline: true },
      });
      // Whole file or nothing: the server may be sending it while it is written.
      const temp = `${output}.${process.pid}.tmp`;
      await fs.promises.writeFile(temp, result.css);
      await fs.promises.rename(temp, output);
      // Closed while building: watching again here would leave watchers nobody closes.
      if (closed) return;
      sync(result.messages);
    } catch (error) {
      log(`css-watch: build failed: ${error?.message ?? error}`);
      // Still watch what was watched, and the input, so fixing the error rebuilds.
      if (!closed && watchers.size === 0) sync([]);
    } finally {
      running = false;
      if (again) {
        again = false;
        schedule();
      }
    }
  };

  const ready = build();
  return {
    ready,
    /** Folders and files watched now (tests). */
    watched: () => [...watchers.keys()],
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const entry of watchers.values()) entry.watcher.close();
      watchers.clear();
    },
  };
}

module.exports = { watchStyles, watchPlan };
