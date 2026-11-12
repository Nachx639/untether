#[cfg(target_os = "windows")]
compile_error!("untether-fwd does not support Windows");

mod asciinema;
mod cast_compact;
mod control_socket;
mod git;
mod local_output;
mod logger;
mod pty;
mod session;
mod title;
mod title_filter;

use std::collections::BTreeMap;
use std::env;
use std::error::Error;
use std::ffi::{CString, OsStr, OsString};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::mem::MaybeUninit;
use std::os::fd::RawFd;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use asciinema::AsciinemaWriter;
use control_socket::{Handler, Server};
use local_output::LocalOutput;
use logger::{Level, Logger};
use nix::libc;
use pty::{Pty, Winsize, get_winsize_from_fd};
use session::SessionInfo;
use title_filter::TitleFilter;

const USAGE: &str = "Untether Forward (untether-fwd)\n\
\n\
Usage:\n\
  untether-fwd [--session-id <id>] [--title-mode <mode>] [--verbosity <level>] <command> [args...]\n\
  untether-fwd --compact-cast <cap-bytes> <keep-bytes> <cast>...\n\
  untether-fwd --compact-cast-until <cap-bytes> <end-offset> <cast>...\n\
\n\
Options:\n\
  --session-id <id>       Use a pre-generated session ID\n\
  --title-mode <mode>     none, filter, static\n\
  --update-title <title>  Update session title and exit (requires --session-id)\n\
  --verbosity <level>     silent, error, warn, info, verbose, debug\n\
  --log-file <path>       Override default log file path\n\
  -q/-v/-vv/-vvv          Quick verbosity\n";

type AnyError = Box<dyn Error + Send + Sync>;
const WORKER_STACK_BYTES: usize = 2 * 1024 * 1024;
const PTY_WRITE_POLL_MS: libc::c_int = 50;
/// Exit waits at most this long for the Mac window to take queued output.
const LOCAL_OUTPUT_FLUSH_TIMEOUT: Duration = Duration::from_secs(1);
/// A program closed from Untether gets this long to save and exit after its SIGTERM before
/// the forwarder sends SIGKILL to its process group. The server waits a little longer for it
/// (FORWARDER_CLOSE_GRACE_MS in web/src/server/pty/forwarder-kill.ts) before it signals anything.
const CLOSE_GRACE: Duration = Duration::from_secs(4);
/// Most PTY reads taken in one go after the program ended, to pass on its last output.
const FINAL_DRAIN_READS: usize = 128;
/// Leaves the modes a full-screen program may have left on in the window after it was closed:
/// cursor shown, mouse reports, bracketed paste, focus reports, kitty keyboard, attributes.
/// The alternate screen is left first, only when the program had entered it (ALT_SCREEN_LEAVE).
const CLOSE_RESET: &[u8] =
    b"\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1004l\x1b[<u\x1b[0m";
const ALT_SCREEN_LEAVE: &[u8] = b"\x1b[?1049l";

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum TitleMode {
    #[default]
    None,
    Filter,
    Static,
}

#[derive(Clone, Debug)]
struct Options {
    session_id: Option<String>,
    title_mode: TitleMode,
    update_title: Option<OsString>,
    verbosity: Level,
    log_file: Option<PathBuf>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            session_id: None,
            title_mode: TitleMode::None,
            update_title: None,
            verbosity: Level::Error,
            log_file: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct EnvDefaults {
    title_mode: Option<TitleMode>,
    verbosity: Option<Level>,
}

impl EnvDefaults {
    fn load() -> Self {
        let mut defaults = Self::default();
        if let Ok(value) = env::var("UNTETHER_TITLE_MODE") {
            defaults.title_mode = parse_title_mode(&value);
        }
        if let Ok(value) = env::var("UNTETHER_LOG_LEVEL") {
            defaults.verbosity = logger::parse_level(&value);
        }
        if env::var("UNTETHER_DEBUG").is_ok_and(|value| is_truthy(&value)) {
            defaults.verbosity = Some(Level::Debug);
        }
        defaults
    }
}

#[derive(Debug)]
struct ParsedArgs {
    options: Options,
    command: Vec<OsString>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ParseError {
    Help,
    InvalidArguments,
}

#[derive(Clone, Copy, Debug)]
struct SizeInfo {
    cols: u16,
    rows: u16,
    has_size: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ExitInfo {
    exit_code: i32,
    signal: Option<u8>,
}

struct SessionContext {
    running: Arc<AtomicBool>,
    child_pid: AtomicI32,
    pty: Arc<Pty>,
    pty_mutex: Mutex<()>,
    local_output: LocalOutput,
    session_name: Mutex<String>,
    asciinema: Arc<AsciinemaWriter>,
    title_mode: TitleMode,
    session_json_path: PathBuf,
    cwd: String,
    command: Vec<String>,
    home: String,
    last_cols: u16,
    last_rows: u16,
    /// The program was asked to end (Kill from Untether or a signal to the forwarder): the
    /// window gets CLOSE_RESET once it has ended.
    termination_requested: AtomicBool,
    /// Kill from Untether (the control socket), recorded for `ut` (UNTETHER_FWD_CLOSED_FILE).
    closed_from_untether: AtomicBool,
    /// When the program still running after a Kill from Untether gets SIGKILL.
    kill_deadline: Mutex<Option<Instant>>,
    hard_killed: AtomicBool,
    /// The program's output last entered (true) or left the alternate screen.
    alt_screen: AtomicBool,
    /// The line a Kill from Untether asked for in the window once the program has ended.
    window_notice: Mutex<Option<String>>,
}

impl SessionContext {
    /// User report (2026-10-14): a session closed from Untether left its Mac window showing
    /// the program's last frame and bash's "Killed: 9". The kill stopped the main loop, the
    /// only reader of the PTY, so the program blocked writing its exit (final repaint, leave
    /// the alternate screen) and stayed exiting ("?Es") until the server SIGKILLed the
    /// forwarder. Now the program is signalled and the main loop keeps draining the PTY until
    /// it ends; SIGKILL follows after CLOSE_GRACE only for a Kill from Untether.
    fn request_termination(&self, signal: i32, from_untether: bool) {
        let pid = self.child_pid.load(Ordering::Acquire);
        if pid <= 0 {
            return;
        }
        signal_process_group(pid, signal);
        if signal != libc::SIGKILL && signal != libc::SIGCONT {
            // A stopped program only takes its SIGTERM once continued.
            signal_process_group(pid, libc::SIGCONT);
        }
        self.termination_requested.store(true, Ordering::Release);
        if from_untether {
            self.closed_from_untether.store(true, Ordering::Release);
            let mut deadline = lock_unpoisoned(&self.kill_deadline);
            if deadline.is_none() {
                *deadline = Some(Instant::now() + CLOSE_GRACE);
            }
        }
    }

    /// SIGKILL to the program's group once the grace of a Kill from Untether has run out.
    fn enforce_kill_deadline(&self) {
        if self.hard_killed.load(Ordering::Acquire) {
            return;
        }
        let expired = lock_unpoisoned(&self.kill_deadline).is_some_and(|at| Instant::now() >= at);
        if expired {
            self.hard_killed.store(true, Ordering::Release);
            signal_process_group(self.child_pid.load(Ordering::Acquire), libc::SIGKILL);
        }
    }

    /// What the window gets once a program asked to end has ended.
    fn close_reset(&self) -> Vec<u8> {
        let mut reset = Vec::with_capacity(ALT_SCREEN_LEAVE.len() + CLOSE_RESET.len());
        if self.alt_screen.load(Ordering::Acquire) {
            reset.extend_from_slice(ALT_SCREEN_LEAVE);
        }
        reset.extend_from_slice(CLOSE_RESET);
        reset
    }
}

impl Handler for SessionContext {
    fn on_stdin(&self, data: &[u8]) {
        write_to_pty(self, data, true);
    }

    fn on_resize(&self, cols: u16, rows: u16) {
        resize_pty(self, cols, rows);
    }

    fn on_reset_size(&self) {
        if !is_tty(libc::STDOUT_FILENO) {
            return;
        }
        if let Ok(size) = get_winsize_from_fd(libc::STDOUT_FILENO) {
            resize_pty(self, size.ws_col, size.ws_row);
        }
    }

    fn on_kill(&self, signal: Option<i32>, notice: Option<&str>) {
        if let Some(line) = notice.and_then(window_notice_line) {
            *lock_unpoisoned(&self.window_notice) = Some(line);
        }
        // The main loop keeps running: it drains the program's exit and ends at its EOF.
        self.request_termination(signal.unwrap_or(libc::SIGTERM), true);
    }

    fn on_update_title(&self, raw_title: &str) {
        let sanitized = title::sanitize_title(raw_title.as_bytes());
        let _ = session::update_session_name(&self.session_json_path, &sanitized);
        replace_session_name(self, sanitized);
    }
}

/// Longest notice written into the window (as the server cuts it, move-to-untether.ts).
const WINDOW_NOTICE_MAX_CHARS: usize = 300;

/// The notice as written into the window: one bold line of printable text (no escape
/// sequence from the message reaches the terminal); None when nothing printable is left.
fn window_notice_line(raw: &str) -> Option<String> {
    let text: String = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return None;
    }
    let text: String = text.chars().take(WINDOW_NOTICE_MAX_CHARS).collect();
    Some(format!("\r\n\x1b[1m{text}\x1b[0m\r\n"))
}

fn main() {
    // Server maintenance (cast_compact.rs), before anything a forwarded session does. A first
    // argument older forwarders reject as an unknown option, so they never run it as a command.
    let raw_args: Vec<OsString> = env::args_os().collect();
    if raw_args
        .get(1)
        .is_some_and(|argument| argument == "--compact-cast")
    {
        std::process::exit(cast_compact::run_cli(&raw_args[2..]));
    }
    if raw_args
        .get(1)
        .is_some_and(|argument| argument == "--compact-cast-until")
    {
        std::process::exit(cast_compact::run_cli_until(&raw_args[2..]));
    }
    let exit_code = match run() {
        Ok(exit_code) => exit_code,
        Err(error) => {
            eprintln!("untether-fwd: {error}");
            1
        }
    };
    std::process::exit(exit_code);
}

fn run() -> Result<i32, AnyError> {
    mark_forwarder_started();
    let closed_file = env::var_os("UNTETHER_FWD_CLOSED_FILE").map(PathBuf::from);

    let raw_args: Vec<OsString> = env::args_os().collect();
    let parsed = match parse_args(&raw_args[1..], EnvDefaults::load()) {
        Ok(parsed) => parsed,
        Err(ParseError::Help) => {
            show_usage();
            return Ok(0);
        }
        Err(ParseError::InvalidArguments) => {
            return Err(invalid_arguments("invalid arguments").into());
        }
    };
    let Options {
        session_id: requested_session_id,
        title_mode,
        update_title,
        verbosity,
        log_file,
    } = parsed.options;
    let raw_command = parsed.command;
    let command: Vec<String> = raw_command
        .iter()
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect();

    if raw_args.len() <= 1 || (command.is_empty() && update_title.is_none()) {
        show_usage();
        return Ok(0);
    }

    let home_path = env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let home = home_path.to_string_lossy().into_owned();
    let default_log_path = default_log_path(&home_path);
    let logger = Arc::new(Logger::new(
        verbosity,
        Some(log_file.as_deref().unwrap_or(&default_log_path)),
    ));

    if let Some(raw_title) = update_title {
        let Some(session_id) = requested_session_id else {
            logger.error("--update-title requires --session-id");
            return Err(invalid_arguments("--update-title requires --session-id").into());
        };
        if !is_valid_session_id(&session_id) {
            logger.error(format_args!("invalid session id: {session_id}"));
            return Err(invalid_arguments("invalid session id").into());
        }

        let path = control_path(&home_path)
            .join(&session_id)
            .join("session.json");
        // A title for a session that doesn't exist is the caller's mistake: say so (the write
        // itself skips a missing folder so a late exit never recreates a deleted session).
        if !path.is_file() {
            logger.error(format_args!("session not found: {session_id}"));
            return Err(invalid_arguments("session not found").into());
        }
        let sanitized = title::sanitize_title(raw_title.as_bytes());
        if let Err(error) = session::update_session_name(&path, &sanitized) {
            logger.error(format_args!("failed to update session title: {error}"));
            return Err(Box::new(error));
        }
        return Ok(0);
    }

    if command.is_empty() {
        logger.error("no command specified");
        show_usage();
        return Err(invalid_arguments("no command specified").into());
    }

    let cwd_path = env::current_dir()?;
    let cwd = cwd_path.to_string_lossy().into_owned();
    let control_path = control_path(&home_path);
    let session_id = requested_session_id.unwrap_or_else(generate_session_id);
    if !is_valid_session_id(&session_id) {
        logger.error(format_args!("invalid session id: {session_id}"));
        return Err(invalid_arguments("invalid session id").into());
    }

    let session_dir = control_path.join(&session_id);
    fs::create_dir_all(&session_dir)?;
    fs::set_permissions(&session_dir, fs::Permissions::from_mode(0o700))?;

    let session_json_path = session_dir.join("session.json");
    let stdout_path = session_dir.join("stdout");
    let ipc_path = session_dir.join("ipc.sock");

    let dimensions = determine_initial_size();
    let initial_cols = dimensions.cols;
    let initial_rows = dimensions.rows;
    let session_name = title::generate_session_name(&command, &cwd, &home);
    let started_at = iso_timestamp();
    let git_info = git::detect_git_info(&cwd_path);

    let mut session_info = SessionInfo {
        id: session_id.clone(),
        name: session_name.clone(),
        command: command.clone(),
        working_dir: cwd.clone(),
        status: "starting".to_owned(),
        exit_code: None,
        started_at,
        pid: None,
        initial_cols: dimensions.has_size.then_some(initial_cols),
        initial_rows: dimensions.has_size.then_some(initial_rows),
        last_clear_offset: Some(0),
        version: Some(
            option_env!("UNTETHER_VERSION")
                .unwrap_or("unknown")
                .to_owned(),
        ),
        git_repo_path: git_info.git_repo_path,
        git_branch: git_info.git_branch,
        git_ahead_count: git_info.git_ahead_count,
        git_behind_count: git_info.git_behind_count,
        git_has_changes: git_info.git_has_changes,
        git_is_worktree: git_info.git_is_worktree,
        git_main_repo_path: git_info.git_main_repo_path,
        attached_via_ut: env::var_os("UNTETHER_SESSION_ID").map(|_| true),
        forwarder_pid: Some(std::process::id() as i32),
        window_notice_written: None,
    };
    // 2026-10-20: the handlers were installed only after the fork, so a SIGHUP (window
    // closed) between the "starting" write and that point killed the forwarder with the
    // default action and left the session "starting" for good. Installed first, a signal
    // that early ends the session through the normal exit path (or below, before the fork).
    let received_signal = Arc::new(AtomicI32::new(0));
    install_signal_handlers(received_signal.clone())?;

    session::write_session_info(&session_json_path, &session_info)?;
    // 2026-10-20: a startup error after this write (pty, socket, threads; even after "running")
    // returned with `?` and left the session "starting"/"running" with nobody behind it. The
    // guard writes "exited" on every early return; the normal exit path disarms it.
    let mut startup_exit = ExitedOnDrop::new(session_json_path.clone(), session_info.clone());

    let command_string = command.join(" ");
    let asciinema = Arc::new(AsciinemaWriter::new(
        &stdout_path,
        initial_cols,
        initial_rows,
        &command_string,
        &session_name,
    )?);
    let mut pty = Pty::open(Winsize {
        ws_col: initial_cols,
        ws_row: initial_rows,
        ws_xpixel: 0,
        ws_ypixel: 0,
    })?;

    // Build every CString and pointer vector before forking. The child branch
    // performs only async-signal-safe libc calls and never allocates.
    let exec_data = ExecData::build(&raw_command, &session_id)?;
    let cwd_c = cstring_from_os(cwd_path.as_os_str())?;
    let master_fd = pty.master_fd();
    let slave_fd = pty
        .slave_fd()
        .ok_or_else(|| invalid_arguments("PTY has no slave descriptor"))?;
    // A signal (window closed) arrived while starting: don't start the program at all.
    let early_signal = received_signal.load(Ordering::Acquire);
    if early_signal != 0 {
        logger.alert_file_only(format_args!(
            "signal {early_signal} before the program started"
        ));
        startup_exit.set_exit_code(128 + early_signal);
        return Ok(128 + early_signal);
    }
    // SAFETY: no other code runs in the child before `execve`/`_exit`.
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        logger.error("failed to fork");
        return Err(io::Error::last_os_error().into());
    }
    if pid == 0 {
        // SAFETY: all pointers/fds were prepared before fork and remain live.
        unsafe { exec_child(master_fd, slave_fd, &cwd_c, &exec_data) };
    }
    drop(exec_data);
    drop(cwd_c);
    pty.close_slave();

    let mut child_guard = ChildGuard::new(pid);
    let running = Arc::new(AtomicBool::new(true));

    session_info.pid = Some(pid);
    session_info.status = "running".to_owned();
    startup_exit.info.pid = Some(pid);
    session::merge_session_info(&session_json_path, &session_info)?;

    let context = Arc::new(SessionContext {
        running: running.clone(),
        child_pid: AtomicI32::new(pid),
        pty: Arc::new(pty),
        pty_mutex: Mutex::new(()),
        local_output: LocalOutput::start(
            libc::STDOUT_FILENO,
            local_output::DEFAULT_CAPACITY,
            Some(logger.clone()),
        )?,
        session_name: Mutex::new(session_name),
        asciinema: asciinema.clone(),
        title_mode,
        session_json_path: session_json_path.clone(),
        cwd,
        command,
        home,
        last_cols: initial_cols,
        last_rows: initial_rows,
        termination_requested: AtomicBool::new(false),
        closed_from_untether: AtomicBool::new(false),
        kill_deadline: Mutex::new(None),
        hard_killed: AtomicBool::new(false),
        alt_screen: AtomicBool::new(false),
        window_notice: Mutex::new(None),
    });

    if title_mode == TitleMode::Static {
        let name = lock_unpoisoned(&context.session_name).clone();
        update_local_title(&context, &name);
    }

    let mut control_server = Server::start(&ipc_path, context.clone())?;
    let session_context = context.clone();
    let session_thread = thread::Builder::new()
        .name("ut-fwd-session-watcher".to_owned())
        .stack_size(WORKER_STACK_BYTES)
        .spawn(move || session_watcher_thread(&session_context))?;
    let resize_context = context.clone();
    let resize_thread = thread::Builder::new()
        .name("ut-fwd-resize-watcher".to_owned())
        .stack_size(WORKER_STACK_BYTES)
        .spawn(move || resize_watcher_thread(&resize_context))?;

    let mut raw_mode = if is_tty(libc::STDIN_FILENO) {
        RawMode::enable(libc::STDIN_FILENO).ok()
    } else {
        None
    };

    let (reaped, main_loop_error) =
        match main_loop(&context, libc::STDIN_FILENO, received_signal.as_ref()) {
            Ok(reaped) => (reaped, None),
            Err(error) => (None, Some(error)),
        };
    if let Some(error) = &main_loop_error {
        logger.error(format_args!("main loop error: {error}"));
    }

    running.store(false, Ordering::Release);
    if reaped.is_none()
        && !forward_pending_signal(pid, received_signal.as_ref())
        && main_loop_error.is_some()
    {
        terminate_child(pid);
    }
    if context.termination_requested.load(Ordering::Acquire) {
        context.local_output.push(&context.close_reset());
    }
    // Llevar a Untether (2026-10-25): the server wrote its notice into the window's tty 700 ms
    // after the Kill, but `ut` exits 166 on a close from Untether and the user's zsh wrapper
    // closes the shell on it: the tab was gone ("notice not written, unavailable"). Written
    // here, after the program's last frame and before `ut` returns, it is always in time.
    // It is the forwarder's once queued, flushed or not: a window that did not drain in time
    // may have shown part of it, and a second copy from the server would double or cut it
    // (2026-10-25 review). A window that stopped draining would not take the server's either.
    if let Some(line) = lock_unpoisoned(&context.window_notice).take() {
        context.local_output.push(line.as_bytes());
        session_info.window_notice_written = Some(true);
    }
    // Bounded: a window that stopped draining must not keep the session alive.
    context.local_output.finish(LOCAL_OUTPUT_FLUSH_TIMEOUT);
    if let Some(mode) = raw_mode.as_mut() {
        mode.restore();
    }
    control_server.stop();
    let _ = control_server.join();
    let _ = session_thread.join();
    let _ = resize_thread.join();

    let waited = match reaped {
        Some(info) => Ok(info),
        None => wait_for_child_forwarding_signals(&context, received_signal.as_ref()),
    };
    let exit_info = match waited {
        Ok(info) => info,
        Err(error) => {
            logger.error(format_args!("waitpid failed: {error}"));
            ExitInfo {
                exit_code: 1,
                signal: None,
            }
        }
    };
    child_guard.disarm();
    if context.closed_from_untether.load(Ordering::Acquire) {
        mark_closed_from_untether(closed_file.as_deref());
    }

    let _ = asciinema.write_exit(exit_info.exit_code, &session_id);
    session_info.name = lock_unpoisoned(&context.session_name).clone();
    session_info.status = "exited".to_owned();
    session_info.exit_code = Some(exit_info.exit_code);
    startup_exit.disarm();
    let _ = session::merge_session_info(&session_json_path, &session_info);

    Ok(exit_info.exit_code)
}

/// Writes "exited" into the session file when dropped armed: every return between the first
/// session write and the normal exit write (see its use in `run`).
struct ExitedOnDrop {
    path: PathBuf,
    info: SessionInfo,
    armed: bool,
}

impl ExitedOnDrop {
    fn new(path: PathBuf, info: SessionInfo) -> Self {
        Self {
            path,
            info,
            armed: true,
        }
    }

    fn set_exit_code(&mut self, code: i32) {
        self.info.exit_code = Some(code);
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ExitedOnDrop {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.info.status = "exited".to_owned();
        if self.info.exit_code.is_none() {
            self.info.exit_code = Some(1);
        }
        let _ = session::merge_session_info(&self.path, &self.info);
    }
}

fn mark_forwarder_started() {
    let Some(path) = env::var_os("UNTETHER_FWD_STARTED_FILE") else {
        return;
    };
    let _ = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path);
}

/// Tells `ut` that the session was closed from Untether (not by `/exit` or Ctrl+D), so the
/// shell wrapper around it may close the Mac window as well.
fn mark_closed_from_untether(path: Option<&Path>) {
    let Some(path) = path else {
        return;
    };
    let _ = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path);
}

fn parse_args(args: &[OsString], defaults: EnvDefaults) -> Result<ParsedArgs, ParseError> {
    let mut options = Options::default();
    if let Some(mode) = defaults.title_mode {
        options.title_mode = mode;
    }
    if let Some(level) = defaults.verbosity {
        options.verbosity = level;
    }

    let mut index = 0;
    while index < args.len() {
        match args[index].as_os_str().as_bytes() {
            b"--help" | b"-h" => return Err(ParseError::Help),
            b"--session-id" => {
                options.session_id = Some(utf8_option_value(args, index)?.to_owned());
                index += 2;
            }
            b"--title-mode" => {
                options.title_mode = parse_title_mode(utf8_option_value(args, index)?)
                    .ok_or(ParseError::InvalidArguments)?;
                index += 2;
            }
            b"--update-title" => {
                options.update_title = Some(option_value(args, index)?.to_owned());
                index += 2;
            }
            b"--verbosity" => {
                options.verbosity = logger::parse_level(utf8_option_value(args, index)?)
                    .ok_or(ParseError::InvalidArguments)?;
                index += 2;
            }
            b"--log-file" => {
                options.log_file = Some(PathBuf::from(option_value(args, index)?));
                index += 2;
            }
            b"-q" => {
                options.verbosity = Level::Silent;
                index += 1;
            }
            b"-v" => {
                options.verbosity = Level::Info;
                index += 1;
            }
            b"-vv" => {
                options.verbosity = Level::Verbose;
                index += 1;
            }
            b"-vvv" => {
                options.verbosity = Level::Debug;
                index += 1;
            }
            b"--" => {
                index += 1;
                break;
            }
            argument if argument.starts_with(b"--") => {
                return Err(ParseError::InvalidArguments);
            }
            _ => break,
        }
    }

    let mut command = args[index..].to_vec();
    if command
        .first()
        .is_some_and(|argument| argument.as_os_str().as_bytes() == b"--")
    {
        command.remove(0);
    }
    Ok(ParsedArgs { options, command })
}

fn option_value(args: &[OsString], index: usize) -> Result<&OsStr, ParseError> {
    args.get(index + 1)
        .map(OsString::as_os_str)
        .ok_or(ParseError::InvalidArguments)
}

fn utf8_option_value(args: &[OsString], index: usize) -> Result<&str, ParseError> {
    option_value(args, index)?
        .to_str()
        .ok_or(ParseError::InvalidArguments)
}

fn show_usage() {
    let mut stdout = io::stdout().lock();
    let _ = stdout.write_all(USAGE.as_bytes());
    let _ = stdout.flush();
}

fn parse_title_mode(value: &str) -> Option<TitleMode> {
    if value.eq_ignore_ascii_case("none") {
        Some(TitleMode::None)
    } else if value.eq_ignore_ascii_case("filter") {
        Some(TitleMode::Filter)
    } else if value.eq_ignore_ascii_case("static") {
        Some(TitleMode::Static)
    } else {
        None
    }
}

fn is_truthy(value: &str) -> bool {
    value.eq_ignore_ascii_case("1") || value.eq_ignore_ascii_case("true")
}

fn default_log_path(home: &Path) -> PathBuf {
    if home.as_os_str().is_empty() {
        PathBuf::from("./.untether/log.txt")
    } else {
        home.join(".untether/log.txt")
    }
}

fn control_path(home: &Path) -> PathBuf {
    if let Some(path) = env::var_os("UNTETHER_CONTROL_DIR") {
        return PathBuf::from(path);
    }
    if home.as_os_str().is_empty() {
        PathBuf::from("./.untether/control")
    } else {
        home.join(".untether/control")
    }
}

fn generate_session_id() -> String {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("fwd_{milliseconds}_{}", std::process::id())
}

fn is_valid_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id.len() <= 64
        && session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn determine_initial_size() -> SizeInfo {
    let external = env::var_os("UNTETHER_SESSION_ID").is_some();
    if external {
        thread::sleep(Duration::from_millis(100));
        if is_tty(libc::STDOUT_FILENO) {
            return get_winsize_from_fd(libc::STDOUT_FILENO).map_or(
                SizeInfo {
                    cols: 80,
                    rows: 24,
                    has_size: false,
                },
                |size| SizeInfo {
                    cols: size.ws_col,
                    rows: size.ws_row,
                    has_size: true,
                },
            );
        }
        return SizeInfo {
            cols: 80,
            rows: 24,
            has_size: false,
        };
    }

    if is_tty(libc::STDOUT_FILENO) {
        return get_winsize_from_fd(libc::STDOUT_FILENO).map_or(
            SizeInfo {
                cols: 120,
                rows: 40,
                has_size: true,
            },
            |size| SizeInfo {
                cols: size.ws_col,
                rows: size.ws_row,
                has_size: true,
            },
        );
    }

    SizeInfo {
        cols: 120,
        rows: 40,
        has_size: true,
    }
}

fn iso_timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let timestamp: libc::time_t = seconds.try_into().unwrap_or(libc::time_t::MAX);
    let mut broken_down = MaybeUninit::<libc::tm>::uninit();
    // SAFETY: both pointers are valid; `gmtime_r` initializes the output when
    // it returns non-null.
    let result = unsafe { libc::gmtime_r(&timestamp, broken_down.as_mut_ptr()) };
    if result.is_null() {
        return "1970-01-01T00:00:00Z".to_owned();
    }
    // SAFETY: `gmtime_r` succeeded.
    let time = unsafe { broken_down.assume_init() };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        time.tm_year + 1900,
        time.tm_mon + 1,
        time.tm_mday,
        time.tm_hour,
        time.tm_min,
        time.tm_sec
    )
}

fn is_tty(fd: RawFd) -> bool {
    // SAFETY: isatty only inspects the descriptor.
    unsafe { libc::isatty(fd) == 1 }
}

fn invalid_arguments(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn cstring_from_os(value: &OsStr) -> io::Result<CString> {
    CString::new(value.as_bytes())
        .map_err(|_| invalid_arguments("argument or path contains an embedded NUL"))
}

struct ExecData {
    executable: CString,
    _argv_storage: Vec<CString>,
    argv: Vec<*const libc::c_char>,
    _env_storage: Vec<CString>,
    envp: Vec<*const libc::c_char>,
}

impl ExecData {
    fn build(command: &[OsString], session_id: &str) -> io::Result<Self> {
        let executable_name = command
            .first()
            .ok_or_else(|| invalid_arguments("empty command"))?;
        let argv_storage: Vec<CString> = command
            .iter()
            .map(|argument| CString::new(argument.as_bytes()))
            .collect::<Result<_, _>>()
            .map_err(|_| invalid_arguments("command argument contains an embedded NUL"))?;
        let mut argv: Vec<*const libc::c_char> = argv_storage
            .iter()
            .map(|argument| argument.as_ptr())
            .collect();
        argv.push(std::ptr::null());

        let mut environment: BTreeMap<OsString, OsString> = env::vars_os().collect();
        environment.remove(OsStr::new("UNTETHER_FWD_STARTED_FILE"));
        environment.remove(OsStr::new("UNTETHER_FWD_CLOSED_FILE"));
        environment.insert(OsString::from("TERM"), OsString::from("xterm-256color"));
        environment.insert(
            OsString::from("UNTETHER_SESSION_ID"),
            OsString::from(session_id),
        );

        let path = environment
            .get(OsStr::new("PATH"))
            .cloned()
            .unwrap_or_else(|| OsString::from("/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"));
        let executable = resolve_executable(executable_name, &path)?;

        let env_storage: Vec<CString> = environment
            .into_iter()
            .map(|(key, value)| {
                let mut entry = key.into_vec();
                entry.push(b'=');
                entry.extend_from_slice(value.as_bytes());
                CString::new(entry)
                    .map_err(|_| invalid_arguments("environment contains an embedded NUL"))
            })
            .collect::<Result<_, _>>()?;
        let mut envp: Vec<*const libc::c_char> =
            env_storage.iter().map(|entry| entry.as_ptr()).collect();
        envp.push(std::ptr::null());

        Ok(Self {
            executable,
            _argv_storage: argv_storage,
            argv,
            _env_storage: env_storage,
            envp,
        })
    }
}

fn resolve_executable(executable: &OsStr, path: &OsStr) -> io::Result<CString> {
    if executable.as_bytes().contains(&b'/') {
        return CString::new(executable.as_bytes())
            .map_err(|_| invalid_arguments("executable contains an embedded NUL"));
    }

    for directory in env::split_paths(path) {
        let directory = if directory.as_os_str().is_empty() {
            Path::new(".")
        } else {
            directory.as_path()
        };
        let candidate = directory.join(executable);
        let candidate_c = cstring_from_os(candidate.as_os_str())?;
        // SAFETY: the candidate is a valid C string.
        if unsafe { libc::access(candidate_c.as_ptr(), libc::X_OK) } == 0 {
            return Ok(candidate_c);
        }
    }

    CString::new(executable.as_bytes())
        .map_err(|_| invalid_arguments("executable contains an embedded NUL"))
}

unsafe fn exec_child(master_fd: RawFd, slave_fd: RawFd, cwd: &CString, exec_data: &ExecData) -> ! {
    // Keep this branch allocation-free: after fork the inherited allocator and
    // synchronization state may be held by another vanished thread.
    // SAFETY: raw syscalls use prevalidated fds and C strings.
    if unsafe { libc::signal(libc::SIGPIPE, libc::SIG_DFL) } == libc::SIG_ERR
        || unsafe { libc::close(master_fd) } != 0
        || unsafe { libc::setsid() } < 0
        || unsafe { libc::ioctl(slave_fd, libc::TIOCSCTTY as _, 0) } < 0
        || unsafe { libc::dup2(slave_fd, libc::STDIN_FILENO) } < 0
        || unsafe { libc::dup2(slave_fd, libc::STDOUT_FILENO) } < 0
        || unsafe { libc::dup2(slave_fd, libc::STDERR_FILENO) } < 0
        || unsafe { libc::close(slave_fd) } != 0
        || unsafe { libc::chdir(cwd.as_ptr()) } != 0
    {
        unsafe { libc::_exit(126) };
    }

    unsafe {
        libc::execve(
            exec_data.executable.as_ptr(),
            exec_data.argv.as_ptr(),
            exec_data.envp.as_ptr(),
        );
        libc::_exit(127);
    }
}

/// SIGINT/SIGTERM/SIGHUP to the forwarder are passed on to the program's group by the main
/// loop (or the final wait), which keeps draining the PTY until the program has ended.
///
/// 2026-10-20: SIGHUP (the Terminal window closed) had no handler and killed the forwarder
/// outright: no exit written to session.json, ipc.sock left behind, the session stuck
/// "running" with a dead socket. Now it ends the program like SIGTERM (as SIGHUP, which
/// interactive shells honour while they ignore SIGTERM) and the exit is recorded.
const FORWARDED_SIGNALS: [i32; 3] = [libc::SIGINT, libc::SIGTERM, libc::SIGHUP];

fn install_signal_handlers(received_signal: Arc<AtomicI32>) -> io::Result<()> {
    for signal in FORWARDED_SIGNALS {
        let received_signal = received_signal.clone();
        // SAFETY: the registered action performs only a lock-free atomic store,
        // which is async-signal-safe and cannot unwind.
        unsafe {
            signal_hook::low_level::register(signal, move || {
                received_signal.store(signal, Ordering::Release);
            })?;
        }
    }
    Ok(())
}

struct RawMode {
    fd: RawFd,
    original: libc::termios,
    restored: bool,
}

impl RawMode {
    fn enable(fd: RawFd) -> io::Result<Self> {
        let mut original = MaybeUninit::<libc::termios>::uninit();
        // SAFETY: tcgetattr initializes `original` on success.
        if unsafe { libc::tcgetattr(fd, original.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: tcgetattr succeeded.
        let original = unsafe { original.assume_init() };
        let mut raw = original;
        // SAFETY: `raw` is a fully initialized termios value.
        unsafe { libc::cfmakeraw(&mut raw) };
        // SAFETY: `raw` remains alive for the call.
        if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &raw) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            fd,
            original,
            restored: false,
        })
    }

    fn restore(&mut self) {
        if self.restored {
            return;
        }
        // SAFETY: `original` was captured from this descriptor.
        unsafe {
            libc::tcsetattr(self.fd, libc::TCSANOW, &self.original);
        }
        self.restored = true;
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        self.restore();
    }
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn write_to_pty(context: &SessionContext, data: &[u8], record_input: bool) {
    let _guard = lock_unpoisoned(&context.pty_mutex);
    if write_pty_all(context, data).is_err() {
        return;
    }
    if record_input {
        let _ = context.asciinema.write_input(data);
    }
}

fn write_pty_all(context: &SessionContext, data: &[u8]) -> io::Result<()> {
    let fd = context.pty.master_fd();
    let mut offset = 0;
    while offset < data.len() {
        if !context.running.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "forwarder is shutting down",
            ));
        }

        // SAFETY: the remaining slice is valid for the duration of `write`.
        let written = unsafe {
            libc::write(
                fd,
                data[offset..].as_ptr().cast::<libc::c_void>(),
                data.len() - offset,
            )
        };
        if written > 0 {
            offset += written as usize;
            continue;
        }
        if written == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "PTY write returned zero",
            ));
        }

        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Interrupted {
            continue;
        }
        if error.kind() != io::ErrorKind::WouldBlock {
            return Err(error);
        }

        let mut poll_fd = libc::pollfd {
            fd,
            events: libc::POLLOUT,
            revents: 0,
        };
        // SAFETY: poll_fd remains valid throughout the call.
        let ready = unsafe { libc::poll(&raw mut poll_fd, 1, PTY_WRITE_POLL_MS) };
        if ready < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if ready > 0 && poll_fd.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "PTY closed while waiting to write",
            ));
        }
    }
    Ok(())
}

fn resize_pty(context: &SessionContext, cols: u16, rows: u16) {
    if cols == 0 || rows == 0 {
        return;
    }
    let _ = context.pty.set_size(Winsize {
        ws_col: cols,
        ws_row: rows,
        ws_xpixel: 0,
        ws_ypixel: 0,
    });
    let _ = context.asciinema.write_resize(cols, rows);
}

/// 2026-10-12: the phone no longer gives the size back (reset-size) every time it leaves the
/// session view: each switch made Claude Code repaint a whole screen into the history, which
/// the phone then showed duplicated and, at the Mac's width, broken into fragments. The Mac
/// window takes its size back here instead, as soon as it is typed into.
fn take_back_window_size(context: &SessionContext) {
    if !is_tty(libc::STDOUT_FILENO) {
        return;
    }
    let (Ok(window), Ok(pty)) = (
        get_winsize_from_fd(libc::STDOUT_FILENO),
        context.pty.get_size(),
    ) else {
        return;
    };
    if let Some((cols, rows)) =
        window_size_to_reclaim((window.ws_col, window.ws_row), (pty.ws_col, pty.ws_row))
    {
        resize_pty(context, cols, rows);
    }
}

/// The window's size when the PTY has another one (a phone's), else None.
fn window_size_to_reclaim(window: (u16, u16), pty: (u16, u16)) -> Option<(u16, u16)> {
    if window.0 == 0 || window.1 == 0 || window == pty {
        return None;
    }
    Some(window)
}

/// Whether a read from the Mac window's stdin holds anything the user typed or pasted, rather
/// than only what Terminal.app sends by itself. User report (2026-10-14): any byte took the
/// size back from a phone, including the focus reports Claude Code asks for (`?1004h`) and the
/// terminal's replies to queries, so clicking the Mac window or switching apps resized the
/// session under the phone and Claude Code repainted a screen into the history each time.
/// Skipped here: focus reports `ESC[I`/`ESC[O`; CSI replies (DA `ESC[?..c`/`ESC[>..c`, cursor
/// position `ESC[n;nR`, status `ESC[..n`, mode reports `ESC[?..$y`, window reports `ESC[..t`,
/// keyboard-protocol `ESC[?..u`); OSC and DCS replies; mouse reports `ESC[<..M/m`, `ESC[M...`.
/// A lone ESC, arrows, bracketed paste and every other byte count as input. A terminal writes
/// each reply in one go, so a read never starts in the middle of one: no state between reads.
fn has_user_input(data: &[u8]) -> bool {
    let mut i = 0;
    while i < data.len() {
        if data[i] != 0x1b {
            return true;
        }
        match data.get(i + 1) {
            Some(b'[') => match skip_csi_reply(data, i + 2) {
                Some(next) => i = next,
                None => return true,
            },
            Some(b']') | Some(b'P') => match skip_string_reply(data, i + 2) {
                Some(next) => i = next,
                None => return true,
            },
            _ => return true,
        }
    }
    false
}

/// After `ESC [` at `start`: the index past a CSI sequence the terminal sends by itself, or
/// None when it is a key (arrows, function keys, bracketed paste) or incomplete.
fn skip_csi_reply(data: &[u8], start: usize) -> Option<usize> {
    // X10 mouse report: ESC [ M and three bytes.
    if data.get(start) == Some(&b'M') {
        return (start + 4 <= data.len()).then_some(start + 4);
    }
    let mut end = start;
    while end < data.len() && (0x20..=0x3f).contains(&data[end]) {
        end += 1;
    }
    let final_byte = *data.get(end)?;
    if !(0x40..=0x7e).contains(&final_byte) {
        return None;
    }
    let params = &data[start..end];
    let private = params.first().copied();
    let is_reply = match final_byte {
        b'I' | b'O' => params.is_empty(),
        b'c' => matches!(private, Some(b'?') | Some(b'>') | Some(b'=')),
        b'R' => params.contains(&b';'),
        b'n' => true,
        b'y' => params.last() == Some(&b'$'),
        b't' => true,
        b'u' => private == Some(b'?'),
        b'M' | b'm' => private == Some(b'<'),
        _ => false,
    };
    is_reply.then_some(end + 1)
}

/// After `ESC ]` or `ESC P` at `start`: the index past its terminator (BEL or `ESC \`).
fn skip_string_reply(data: &[u8], start: usize) -> Option<usize> {
    let mut j = start;
    while j < data.len() {
        match data[j] {
            0x07 => return Some(j + 1),
            0x1b if data.get(j + 1) == Some(&b'\\') => return Some(j + 2),
            _ => j += 1,
        }
    }
    None
}

fn update_local_title(context: &SessionContext, name: &str) {
    let safe_name = title::sanitize_title(name.as_bytes());
    let sequence = match context.title_mode {
        TitleMode::None | TitleMode::Filter => format!("\x1b]2;{safe_name}\x07"),
        TitleMode::Static => title::generate_title_sequence(
            &context.cwd,
            &context.command,
            Some(&safe_name),
            &context.home,
        ),
    };

    context.local_output.push(sequence.as_bytes());
}

fn replace_session_name(context: &SessionContext, name: String) {
    let mut current_name = lock_unpoisoned(&context.session_name);
    if *current_name == name {
        return;
    }
    *current_name = name;
    update_local_title(context, &current_name);
}

fn session_watcher_thread(context: &SessionContext) {
    let mut last_modified = fs::metadata(&context.session_json_path)
        .and_then(|metadata| metadata.modified())
        .ok();

    while context.running.load(Ordering::Acquire) {
        thread::sleep(Duration::from_millis(500));
        let Ok(modified) =
            fs::metadata(&context.session_json_path).and_then(|metadata| metadata.modified())
        else {
            continue;
        };
        if last_modified == Some(modified) {
            continue;
        }
        last_modified = Some(modified);
        if let Some(name) = session::read_session_name(&context.session_json_path) {
            replace_session_name(context, name);
        }
    }
}

fn resize_watcher_thread(context: &SessionContext) {
    if !is_tty(libc::STDOUT_FILENO) {
        return;
    }
    let mut last_cols = context.last_cols;
    let mut last_rows = context.last_rows;

    while context.running.load(Ordering::Acquire) {
        thread::sleep(Duration::from_millis(200));
        let Ok(size) = get_winsize_from_fd(libc::STDOUT_FILENO) else {
            continue;
        };
        if size.ws_col == last_cols && size.ws_row == last_rows {
            continue;
        }
        last_cols = size.ws_col;
        last_rows = size.ws_row;
        resize_pty(context, size.ws_col, size.ws_row);
    }
}

/// What one read from the PTY master gave.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PtyRead {
    Data,
    WouldBlock,
    /// The PTY has no writer left (EOF or EIO).
    Closed,
}

/// Program output on its way to the cast file, Untether clients and the Mac window.
struct OutputPath {
    buffer: [u8; 8192],
    filtered: Vec<u8>,
    title_filter: TitleFilter,
}

impl OutputPath {
    fn new() -> Self {
        Self {
            buffer: [0_u8; 8192],
            filtered: Vec::new(),
            title_filter: TitleFilter::new(),
        }
    }

    /// One read from the PTY master, passed on.
    fn forward(&mut self, context: &SessionContext) -> io::Result<PtyRead> {
        // SAFETY: `buffer` is writable for its full length.
        let read = unsafe {
            libc::read(
                context.pty.master_fd(),
                self.buffer.as_mut_ptr().cast::<libc::c_void>(),
                self.buffer.len(),
            )
        };
        if read < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::WouldBlock
                || error.raw_os_error() == Some(libc::EINTR)
            {
                return Ok(PtyRead::WouldBlock);
            }
            if error.raw_os_error() == Some(libc::EIO) {
                return Ok(PtyRead::Closed);
            }
            return Err(error);
        }
        if read == 0 {
            return Ok(PtyRead::Closed);
        }

        let chunk = &self.buffer[..read as usize];
        if let Some(entered) = alt_screen_change(chunk) {
            context.alt_screen.store(entered, Ordering::Release);
        }
        let output = if context.title_mode == TitleMode::None {
            chunk
        } else {
            self.filtered.clear();
            self.title_filter.filter(chunk, &mut self.filtered);
            self.filtered.as_slice()
        };
        if !output.is_empty() {
            // Record first: the cast file and clients must never depend
            // on the Mac window draining (see local_output.rs).
            let _ = context.asciinema.write_output(output);
            context.local_output.push(output);
        }
        Ok(PtyRead::Data)
    }

    /// Passes on what the PTY holds now (bounded), e.g. a program's last output once it ended.
    fn drain(&mut self, context: &SessionContext) {
        for _ in 0..FINAL_DRAIN_READS {
            if !matches!(self.forward(context), Ok(PtyRead::Data)) {
                return;
            }
        }
    }
}

/// Whether `chunk` last enters (true) or leaves (false) the alternate screen, if it does.
fn alt_screen_change(chunk: &[u8]) -> Option<bool> {
    const MODES: [&[u8]; 3] = [b"\x1b[?1049", b"\x1b[?1047", b"\x1b[?47"];
    let mut last: Option<(usize, bool)> = None;
    for mode in MODES {
        let mut from = 0;
        while let Some(found) = find_bytes(&chunk[from..], mode) {
            let end = from + found + mode.len();
            let entered = match chunk.get(end) {
                Some(b'h') => Some(true),
                Some(b'l') => Some(false),
                _ => None,
            };
            if let Some(entered) = entered
                && last.is_none_or(|(at, _)| end > at)
            {
                last = Some((end, entered));
            }
            from = end;
        }
    }
    last.map(|(_, entered)| entered)
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Waits for the program without blocking: Some(exit) once it has ended and was reaped.
fn try_reap(pid: libc::pid_t) -> Option<ExitInfo> {
    if pid <= 0 {
        return None;
    }
    let mut status = 0;
    // SAFETY: status points to valid writable storage.
    let result = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
    (result == pid).then(|| decode_exit_status(status as u32))
}

/// Copies between the PTY and the Mac window until the PTY closes. Once the program was asked
/// to end it also returns as soon as it has ended (the exit, already reaped), as anything it
/// left running could keep the PTY open.
fn main_loop(
    context: &SessionContext,
    stdin_fd: RawFd,
    received_signal: &AtomicI32,
) -> io::Result<Option<ExitInfo>> {
    let mut stdin_active = true;
    let mut poll_fds = [
        libc::pollfd {
            fd: context.pty.master_fd(),
            events: libc::POLLIN,
            revents: 0,
        },
        libc::pollfd {
            fd: stdin_fd,
            events: libc::POLLIN,
            revents: 0,
        },
    ];
    let mut input = [0_u8; 8192];
    let mut output = OutputPath::new();

    while context.running.load(Ordering::Acquire) {
        let signal = received_signal.swap(0, Ordering::AcqRel);
        if signal != 0 {
            context.request_termination(signal, false);
        }
        if context.termination_requested.load(Ordering::Acquire) {
            if let Some(exit) = try_reap(context.child_pid.load(Ordering::Acquire)) {
                output.drain(context);
                return Ok(Some(exit));
            }
            context.enforce_kill_deadline();
        }
        if context.local_output.take_redraw_request() {
            request_redraw(context);
        }
        if !stdin_active {
            poll_fds[1].fd = -1;
            poll_fds[1].events = 0;
        }
        poll_fds[0].revents = 0;
        poll_fds[1].revents = 0;
        // SAFETY: the fixed-size pollfd array remains valid throughout `poll`.
        let ready = unsafe { libc::poll(poll_fds.as_mut_ptr(), poll_fds.len() as _, 200) };
        if ready < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return Err(error);
        }
        if ready == 0 {
            continue;
        }

        if poll_fds[0].revents & libc::POLLIN != 0 {
            match output.forward(context)? {
                PtyRead::Data => {}
                PtyRead::WouldBlock => continue,
                PtyRead::Closed => break,
            }
        }

        if poll_fds[0].revents & libc::POLLIN == 0
            && poll_fds[0].revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0
        {
            break;
        }

        if stdin_active
            && poll_fds[1].revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0
        {
            stdin_active = false;
        } else if stdin_active && poll_fds[1].revents & libc::POLLIN != 0 {
            // SAFETY: `input` is writable for its full length.
            let read = unsafe {
                libc::read(
                    stdin_fd,
                    input.as_mut_ptr().cast::<libc::c_void>(),
                    input.len(),
                )
            };
            if read < 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                return Err(error);
            }
            if read == 0 {
                stdin_active = false;
            } else {
                let input = &input[..read as usize];
                if has_user_input(input) {
                    take_back_window_size(context);
                }
                write_to_pty(context, input, true);
            }
        }
    }
    Ok(None)
}

/// The Mac window lost output while it was stalled; SIGWINCH makes full-screen
/// programs repaint it. Clients see at most a harmless repaint.
fn request_redraw(context: &SessionContext) {
    // SAFETY: tcgetpgrp only inspects the descriptor.
    let foreground = unsafe { libc::tcgetpgrp(context.pty.master_fd()) };
    let group = if foreground > 0 {
        foreground
    } else {
        context.child_pid.load(Ordering::Acquire)
    };
    signal_process_group(group, libc::SIGWINCH);
}

fn decode_exit_status(status: u32) -> ExitInfo {
    if status & 0x7f == 0 {
        ExitInfo {
            exit_code: ((status >> 8) & 0xff) as i32,
            signal: None,
        }
    } else {
        let signal = (status & 0x7f) as u8;
        ExitInfo {
            exit_code: 128 + i32::from(signal),
            signal: Some(signal),
        }
    }
}

fn signal_process_group(pid: libc::pid_t, signal: i32) {
    if pid > 0 {
        // SAFETY: negative pid targets the process group created by setsid.
        unsafe {
            libc::kill(-pid, signal);
        }
    }
}

fn forward_pending_signal(pid: libc::pid_t, received_signal: &AtomicI32) -> bool {
    let signal = received_signal.swap(0, Ordering::AcqRel);
    if signal == 0 {
        return false;
    }
    signal_process_group(pid, signal);
    true
}

fn terminate_child(pid: libc::pid_t) {
    signal_process_group(pid, libc::SIGTERM);
}

fn wait_for_child(pid: libc::pid_t) -> io::Result<ExitInfo> {
    loop {
        let mut status = 0;
        // SAFETY: status points to valid writable storage.
        let result = unsafe { libc::waitpid(pid, &mut status, 0) };
        if result == pid {
            return Ok(decode_exit_status(status as u32));
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        return Err(error);
    }
}

fn wait_for_child_forwarding_signals(
    context: &SessionContext,
    received_signal: &AtomicI32,
) -> io::Result<ExitInfo> {
    let pid = context.child_pid.load(Ordering::Acquire);
    let mut discard = [0_u8; 8192];
    loop {
        let signal = received_signal.swap(0, Ordering::AcqRel);
        if signal != 0 {
            context.request_termination(signal, false);
        }
        context.enforce_kill_deadline();
        // Backstop: the program's output still reaches the cast file, so a program writing
        // to its terminal can never wedge its own exit here (2026-10-14).
        drain_pty_to_cast(context, &mut discard);
        let mut status = 0;
        // WNOHANG keeps signal delivery race-free: every pending signal is
        // drained before the next bounded wait for child exit.
        let result = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if result == pid {
            return Ok(decode_exit_status(status as u32));
        }
        if result == 0 {
            thread::sleep(Duration::from_millis(25));
            continue;
        }
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Interrupted {
            continue;
        }
        return Err(error);
    }
}

/// Reads what the PTY holds (bounded) into the cast file only: the window was let go already.
fn drain_pty_to_cast(context: &SessionContext, buffer: &mut [u8]) {
    for _ in 0..FINAL_DRAIN_READS {
        // SAFETY: `buffer` is writable for its full length.
        let read = unsafe {
            libc::read(
                context.pty.master_fd(),
                buffer.as_mut_ptr().cast::<libc::c_void>(),
                buffer.len(),
            )
        };
        if read <= 0 {
            return;
        }
        let _ = context.asciinema.write_output(&buffer[..read as usize]);
    }
}

struct ChildGuard {
    pid: libc::pid_t,
    active: bool,
}

impl ChildGuard {
    fn new(pid: libc::pid_t) -> Self {
        Self { pid, active: true }
    }

    fn disarm(&mut self) {
        self.active = false;
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if self.active {
            terminate_child(self.pid);
            let _ = wait_for_child(self.pid);
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn signal_handlers_are_installed_before_the_first_session_write() {
        // 2026-10-20: a SIGHUP between the "starting" write and the handlers left the session
        // "starting" forever.
        let source = include_str!("main.rs");
        let run = &source[source.find("fn run() ->").unwrap()..];
        let handlers = run.find("install_signal_handlers(received_signal").unwrap();
        let first_write = run.find("session::write_session_info(").unwrap();
        assert!(handlers < first_write);
    }

    fn temp_session_file(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ut-fwd-exit-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("session.json")
    }

    #[test]
    fn window_notice_is_one_printable_bold_line() {
        assert_eq!(
            super::window_notice_line("Sigue en\x1b[2J Untether\r\n").as_deref(),
            Some("\r\n\x1b[1mSigue en [2J Untether\x1b[0m\r\n")
        );
        assert_eq!(super::window_notice_line(" \n\t "), None);
        let long = super::window_notice_line(&"ñ".repeat(400)).unwrap();
        assert_eq!(long.chars().filter(|c| *c == 'ñ').count(), 300);
    }

    fn sample(status: &str) -> super::SessionInfo {
        super::SessionInfo {
            id: "s".to_owned(),
            name: "n".to_owned(),
            command: vec!["true".to_owned()],
            working_dir: "/tmp".to_owned(),
            status: status.to_owned(),
            exit_code: None,
            started_at: "2026-10-20T00:00:00Z".to_owned(),
            pid: Some(4242),
            initial_cols: None,
            initial_rows: None,
            last_clear_offset: None,
            version: None,
            git_repo_path: None,
            git_branch: None,
            git_ahead_count: None,
            git_behind_count: None,
            git_has_changes: None,
            git_is_worktree: None,
            git_main_repo_path: None,
            attached_via_ut: None,
            forwarder_pid: None,
            window_notice_written: None,
        }
    }

    #[test]
    fn a_startup_error_after_running_was_written_leaves_the_session_exited() {
        // 2026-10-20: an error after the "running" write left a running session nobody ran.
        let path = temp_session_file("err");
        super::session::write_session_info(&path, &sample("running")).unwrap();
        drop(super::ExitedOnDrop::new(path.clone(), sample("running")));
        let after = super::session::read_session_info(&path).unwrap();
        assert_eq!(after.status, "exited");
        assert_eq!(after.exit_code, Some(1));

        let mut early = super::ExitedOnDrop::new(path.clone(), sample("starting"));
        early.set_exit_code(129);
        drop(early);
        assert_eq!(
            super::session::read_session_info(&path).unwrap().exit_code,
            Some(129)
        );

        super::session::write_session_info(&path, &sample("running")).unwrap();
        let mut normal = super::ExitedOnDrop::new(path.clone(), sample("running"));
        normal.disarm();
        drop(normal);
        assert_eq!(
            super::session::read_session_info(&path).unwrap().status,
            "running"
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_closed_terminal_window_sighup_is_handled_like_sigterm() {
        // 2026-10-20: SIGHUP killed the forwarder without writing the exit.
        assert!(super::FORWARDED_SIGNALS.contains(&libc::SIGHUP));
        assert!(super::FORWARDED_SIGNALS.contains(&libc::SIGTERM));
    }

    #[test]
    fn alt_screen_tracking_follows_the_last_switch_in_a_chunk() {
        use super::alt_screen_change;
        assert_eq!(alt_screen_change(b"plain text"), None);
        assert_eq!(alt_screen_change(b"\x1b[?1049h\x1b[H"), Some(true));
        assert_eq!(alt_screen_change(b"\x1b[?1049h..\x1b[?1049l"), Some(false));
        assert_eq!(alt_screen_change(b"\x1b[?47l..\x1b[?1047h"), Some(true));
        assert_eq!(alt_screen_change(b"\x1b[?1049l..\x1b[?47h"), Some(true));
        assert_eq!(alt_screen_change(b"\x1b[?1049"), None);
        assert_eq!(alt_screen_change(b"\x1b[?2004h"), None);
    }

    #[test]
    fn close_reset_restores_the_window_modes() {
        let reset = super::CLOSE_RESET;
        for mode in [
            &b"\x1b[?25h"[..],
            b"\x1b[?1000l",
            b"\x1b[?1002l",
            b"\x1b[?1003l",
            b"\x1b[?1006l",
            b"\x1b[?2004l",
            b"\x1b[?1004l",
            b"\x1b[0m",
        ] {
            assert!(super::find_bytes(reset, mode).is_some());
        }
        // Never leaves the alternate screen by itself: on the main screen ?1049l restores a
        // stale cursor position on some terminals.
        assert!(super::find_bytes(reset, b"\x1b[?1049").is_none());
    }

    #[test]
    fn local_input_takes_the_window_size_back_from_a_phone() {
        assert_eq!(
            super::window_size_to_reclaim((120, 52), (80, 33)),
            Some((120, 52))
        );
        assert_eq!(super::window_size_to_reclaim((120, 52), (120, 52)), None);
        assert_eq!(super::window_size_to_reclaim((0, 0), (80, 33)), None);
    }

    #[test]
    fn terminal_replies_and_focus_reports_are_not_user_input() {
        let replies: &[&[u8]] = &[
            b"\x1b[I",
            b"\x1b[O",
            b"\x1b[?62;22c",
            b"\x1b[>1;95;0c",
            b"\x1b[12;40R",
            b"\x1b[0n",
            b"\x1b[?2026;2$y",
            b"\x1b[8;67;120t",
            b"\x1b[?0u",
            b"\x1b]11;rgb:1e1e/1e1e/1e1e\x07",
            b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
            b"\x1bP>|Terminal.app\x1b\\",
            b"\x1b[<0;12;5M",
            b"\x1b[<0;12;5m",
            b"\x1b[M !!",
        ];
        for reply in replies {
            assert!(!super::has_user_input(reply), "{reply:?}");
        }
        assert!(!super::has_user_input(b"\x1b[O\x1b[I\x1b[?62;22c\x1b[3;1R"));
        assert!(!super::has_user_input(b""));
    }

    #[test]
    fn keys_and_pastes_are_user_input() {
        let inputs: &[&[u8]] = &[
            b"a",
            b"\r",
            b"\x1b",
            b"\x1b[A",
            b"\x1b[3~",
            b"\x1bOP",
            b"\x1b[200~hello\x1b[201~",
            b"\x1b[I\x1b[O a",
            b"\x1b[Ia",
            b"\x7f",
        ];
        for input in inputs {
            assert!(super::has_user_input(input), "{input:?}");
        }
    }

    use super::*;
    use std::os::unix::ffi::OsStringExt;

    fn os_strings(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn parse_args_handles_verbosity_and_command_boundaries() {
        let parsed = parse_args(
            &os_strings(&["-q", "echo", "hello"]),
            EnvDefaults::default(),
        )
        .expect("parse arguments");
        assert_eq!(parsed.options.verbosity, Level::Silent);
        assert_eq!(parsed.command, os_strings(&["echo", "hello"]));

        let parsed = parse_args(
            &os_strings(&["--", "--", "echo", "hello"]),
            EnvDefaults::default(),
        )
        .expect("parse doubled boundary");
        assert_eq!(parsed.command, os_strings(&["echo", "hello"]));
    }

    #[test]
    fn parse_args_applies_environment_defaults_and_cli_overrides() {
        let defaults = EnvDefaults {
            title_mode: Some(TitleMode::Filter),
            verbosity: Some(Level::Debug),
        };
        let parsed = parse_args(
            &os_strings(&["--title-mode", "static", "-v", "bash"]),
            defaults,
        )
        .expect("parse overrides");
        assert_eq!(parsed.options.title_mode, TitleMode::Static);
        assert_eq!(parsed.options.verbosity, Level::Info);
        assert_eq!(parsed.command, os_strings(&["bash"]));
    }

    #[test]
    fn parse_args_rejects_missing_values_unknown_options_and_invalid_values() {
        assert_eq!(
            parse_args(&os_strings(&["--session-id"]), EnvDefaults::default()).unwrap_err(),
            ParseError::InvalidArguments
        );
        assert_eq!(
            parse_args(&os_strings(&["--unknown"]), EnvDefaults::default()).unwrap_err(),
            ParseError::InvalidArguments
        );
        assert_eq!(
            parse_args(
                &os_strings(&["--title-mode", "dynamic", "bash"]),
                EnvDefaults::default()
            )
            .unwrap_err(),
            ParseError::InvalidArguments
        );
    }

    #[test]
    fn parse_args_preserves_non_utf8_path_and_title_values() {
        let log_path = OsString::from_vec(b"/tmp/log-\xff".to_vec());
        let title = OsString::from_vec(b"title-\xff".to_vec());
        let args = vec![
            OsString::from("--log-file"),
            log_path.clone(),
            OsString::from("--update-title"),
            title.clone(),
        ];

        let parsed = parse_args(&args, EnvDefaults::default()).expect("parse raw option values");
        assert_eq!(parsed.options.log_file, Some(PathBuf::from(log_path)));
        assert_eq!(parsed.options.update_title, Some(title));
    }

    #[test]
    fn session_ids_are_bounded_and_path_safe() {
        assert!(is_valid_session_id("fwd_123_456"));
        assert!(is_valid_session_id("a-Z_09"));
        assert!(!is_valid_session_id(""));
        assert!(!is_valid_session_id("../escape"));
        assert!(!is_valid_session_id(&"a".repeat(65)));
    }

    #[test]
    fn exit_status_decoding_matches_shell_conventions() {
        assert_eq!(
            decode_exit_status(7 << 8),
            ExitInfo {
                exit_code: 7,
                signal: None
            }
        );
        assert_eq!(
            decode_exit_status(15),
            ExitInfo {
                exit_code: 143,
                signal: Some(15)
            }
        );
    }

    #[test]
    fn exec_data_preserves_non_utf8_command_arguments() {
        let command = vec![OsString::from("/bin/echo"), OsString::from_vec(vec![0xff])];
        let data = ExecData::build(&command, "test-session").expect("build exec data");
        assert_eq!(data._argv_storage[1].as_bytes(), &[0xff]);
    }

    #[test]
    fn default_paths_preserve_non_utf8_home() {
        let home = PathBuf::from(OsString::from_vec(b"/tmp/home-\xff".to_vec()));
        assert_eq!(default_log_path(&home), home.join(".untether/log.txt"));
    }
}
