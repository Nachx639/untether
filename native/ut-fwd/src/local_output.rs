//! Bounded path from the PTY to the forwarder's own stdout (the Mac window).
//!
//! 2026-10-04: with the Mac screen locked, Terminal.app stopped draining the
//! tty of a `ut` window. The forwarder copied PTY output to STDOUT with a
//! blocking `write` on the main loop, so it froze there: it stopped reading
//! the PTY (the child blocked on its own output), the control thread hung on
//! the stdout mutex at the next title update, nothing was reaped, and `/exit`
//! or Kill from the phone did nothing until the window drained again.
//!
//! Local output now goes through a bounded queue drained by one writer
//! thread, the only code that may block on the window. The main loop records
//! output for the cast file and Untether clients before queueing it, so the
//! phone never loses bytes. When the queue is full the push waits at most
//! [`STALL_WAIT`] (normal terminal backpressure for a slow but live window);
//! after that the window counts as stalled and pushes drop the oldest queued
//! bytes instead of waiting, until the window accepts a write again.
//!
//! A drop cuts the queue at an arbitrary byte, possibly inside an escape
//! sequence or a UTF-8 character; a cut OSC or DCS would make the window
//! swallow output until it saw a terminator. So the surviving bytes start at
//! the next ESC or line break (within [`RESYNC_SCAN`] bytes, else at least on
//! a UTF-8 boundary), and the writer sends CAN first, which aborts whatever
//! sequence the window's parser is in (2026-10-04).
//!
//! Why a thread and not `O_NONBLOCK` on stdout: the window's open file
//! description is shared with the login shell and anything else in that
//! terminal tab, and `O_NONBLOCK` is a property of the description. Setting
//! it, even only around each write, leaks `EAGAIN` into those processes, and a
//! SIGKILL between set and restore leaves the shell's tty non-blocking.
//! `poll()` alone is not enough either: `POLLOUT` promises only some space,
//! and a blocking write larger than that still sleeps. The writer thread
//! leaves the descriptor flags untouched, so there is nothing to restore on
//! exit; it still handles `EAGAIN` in case stdout arrived non-blocking.

use std::collections::VecDeque;
use std::io;
use std::os::fd::RawFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use nix::libc;

use crate::logger::Logger;

/// Local output kept for a window that is not draining.
pub const DEFAULT_CAPACITY: usize = 2 * 1024 * 1024;
/// Longest a push waits for a full queue before the window counts as stalled.
pub const STALL_WAIT: Duration = Duration::from_millis(250);
const WRITE_CHUNK: usize = 64 * 1024;
/// How far past a drop the queue is searched for an ESC or line break to resume at.
const RESYNC_SCAN: usize = 256;
/// CAN: aborts an escape, control or string sequence in progress (VT parsers, ECMA-48).
const CANCEL: u8 = 0x18;
const EAGAIN_POLL_MS: libc::c_int = 100;
const WRITER_STACK_BYTES: usize = 256 * 1024;

#[derive(Default)]
struct State {
    queue: VecDeque<u8>,
    /// The writer holds a chunk taken from the queue.
    writing: bool,
    /// The window stopped draining; pushes drop instead of waiting.
    stalled: bool,
    stalled_since: Option<Instant>,
    dropped_in_stall: u64,
    /// Bytes were dropped since the writer last took a chunk: send CAN before the next one.
    resync: bool,
    /// Writing failed for good (closed window); discard everything.
    closed: bool,
    shutdown: bool,
}

struct Shared {
    state: Mutex<State>,
    /// Signalled when bytes are queued or shutdown starts.
    data: Condvar,
    /// Signalled when queue space frees up or the writer goes idle.
    space: Condvar,
    redraw: AtomicBool,
    capacity: usize,
    logger: Option<Arc<Logger>>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

pub struct LocalOutput {
    shared: Arc<Shared>,
}

impl LocalOutput {
    pub fn start(fd: RawFd, capacity: usize, logger: Option<Arc<Logger>>) -> io::Result<Self> {
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            data: Condvar::new(),
            space: Condvar::new(),
            redraw: AtomicBool::new(false),
            capacity: capacity.max(1),
            logger,
        });
        let writer_shared = shared.clone();
        // The writer may stay blocked in `write` until process exit, so it
        // is detached rather than joined.
        thread::Builder::new()
            .name("ut-fwd-local-output".to_owned())
            .stack_size(WRITER_STACK_BYTES)
            .spawn(move || writer_thread(fd, &writer_shared))?;
        Ok(Self { shared })
    }

    /// Queues bytes for the window. Never blocks longer than [`STALL_WAIT`].
    pub fn push(&self, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        let shared = &self.shared;
        let capacity = shared.capacity;
        let mut state = shared.lock();
        if state.closed {
            return;
        }

        if !state.stalled && state.queue.len() + data.len() > capacity {
            let deadline = Instant::now() + STALL_WAIT;
            while state.queue.len() + data.len() > capacity && !state.closed {
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                state = shared
                    .space
                    .wait_timeout(state, deadline - now)
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .0;
            }
            if state.closed {
                return;
            }
        }

        // A single push larger than the queue keeps only its newest bytes.
        let skipped = data.len().saturating_sub(capacity);
        let data = &data[skipped..];
        let overflow = (state.queue.len() + data.len()).saturating_sub(capacity);
        if overflow > 0 || skipped > 0 {
            if !state.stalled {
                state.stalled = true;
                state.stalled_since = Some(Instant::now());
                // The log file only: stderr is usually the same stalled window.
                if let Some(logger) = &shared.logger {
                    logger.alert_file_only(format_args!(
                        "local window stopped draining; dropping oldest local output \
                         beyond {capacity} bytes (cast file and Untether clients unaffected)"
                    ));
                }
            }
            state.queue.drain(..overflow);
            state.dropped_in_stall += (overflow + skipped) as u64;
            state.queue.extend(data);
            let cut = resync_cut(&state.queue);
            state.queue.drain(..cut);
            state.dropped_in_stall += cut as u64;
            state.resync = true;
        } else {
            state.queue.extend(data);
        }
        shared.data.notify_one();
    }

    /// True once after the window recovered from a stall that dropped output.
    pub fn take_redraw_request(&self) -> bool {
        self.shared.redraw.swap(false, Ordering::AcqRel)
    }

    /// Lets the writer flush what is queued, waiting at most `timeout`.
    /// Returns whether everything reached the window.
    pub fn finish(&self, timeout: Duration) -> bool {
        let shared = &self.shared;
        let deadline = Instant::now() + timeout;
        let mut state = shared.lock();
        state.shutdown = true;
        shared.data.notify_all();
        loop {
            if state.closed || (state.queue.is_empty() && !state.writing) {
                return !state.closed;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            state = shared
                .space
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .0;
        }
    }
}

/// Bytes to skip at the head of a queue that was just cut: up to the next ESC or
/// line break when one is near, else past any UTF-8 continuation bytes.
fn resync_cut(queue: &VecDeque<u8>) -> usize {
    if let Some(boundary) = queue
        .iter()
        .take(RESYNC_SCAN)
        .position(|byte| matches!(byte, 0x1b | b'\n' | b'\r'))
    {
        return boundary;
    }
    queue
        .iter()
        .take_while(|byte| (**byte & 0xC0) == 0x80)
        .count()
}

fn writer_thread(fd: RawFd, shared: &Shared) {
    let mut chunk = Vec::with_capacity(WRITE_CHUNK);
    loop {
        {
            let mut state = shared.lock();
            while state.queue.is_empty() && !state.shutdown {
                state = shared
                    .data
                    .wait(state)
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
            }
            if state.queue.is_empty() {
                shared.space.notify_all();
                return;
            }
            let take = state.queue.len().min(WRITE_CHUNK);
            chunk.clear();
            if std::mem::take(&mut state.resync) {
                chunk.push(CANCEL);
            }
            chunk.extend(state.queue.drain(..take));
            state.writing = true;
            shared.space.notify_all();
        }

        let result = write_all(fd, &chunk);

        let mut state = shared.lock();
        state.writing = false;
        match result {
            Ok(()) => {
                if state.stalled {
                    state.stalled = false;
                    let dropped = std::mem::take(&mut state.dropped_in_stall);
                    let stalled_for = state
                        .stalled_since
                        .take()
                        .map_or(Duration::ZERO, |since| since.elapsed());
                    if dropped > 0 {
                        shared.redraw.store(true, Ordering::Release);
                    }
                    if let Some(logger) = &shared.logger {
                        logger.alert_file_only(format_args!(
                            "local window draining again after {:.1}s; dropped {dropped} bytes \
                             of local output",
                            stalled_for.as_secs_f64()
                        ));
                    }
                }
            }
            Err(_) => {
                state.closed = true;
                state.queue.clear();
            }
        }
        shared.space.notify_all();
        if state.closed {
            return;
        }
    }
}

fn write_all(fd: RawFd, data: &[u8]) -> io::Result<()> {
    let mut offset = 0;
    while offset < data.len() {
        // SAFETY: the remaining slice is valid for the duration of `write`.
        let written = unsafe {
            libc::write(
                fd,
                data[offset..].as_ptr().cast::<libc::c_void>(),
                data.len() - offset,
            )
        };
        if written > 0 {
            // Partial writes resume at the first byte the kernel did not take.
            offset += written as usize;
            continue;
        }
        if written == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "descriptor write returned zero",
            ));
        }
        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::EINTR) => continue,
            Some(code) if code == libc::EAGAIN || code == libc::EWOULDBLOCK => {
                wait_writable(fd)?;
            }
            _ => return Err(error),
        }
    }
    Ok(())
}

fn wait_writable(fd: RawFd) -> io::Result<()> {
    let mut poll_fd = libc::pollfd {
        fd,
        events: libc::POLLOUT,
        revents: 0,
    };
    // SAFETY: poll_fd remains valid throughout the call.
    let ready = unsafe { libc::poll(&raw mut poll_fd, 1, EAGAIN_POLL_MS) };
    if ready < 0 {
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Interrupted {
            return Ok(());
        }
        return Err(error);
    }
    if ready > 0 && poll_fd.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
        return Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "window closed while waiting to write",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    fn pipe() -> (OwnedFd, OwnedFd) {
        let mut fds = [0; 2];
        // SAFETY: `fds` has room for both descriptors.
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        // SAFETY: pipe returned two fresh descriptors we now own.
        unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
    }

    fn read_available(fd: &OwnedFd, until: impl Fn(&[u8]) -> bool) -> Vec<u8> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut output = Vec::new();
        let mut buffer = [0_u8; 65536];
        while !until(&output) {
            assert!(Instant::now() < deadline, "window never received the tail");
            // SAFETY: `buffer` is writable for its full length.
            let read = unsafe {
                libc::read(
                    fd.as_raw_fd(),
                    buffer.as_mut_ptr().cast::<libc::c_void>(),
                    buffer.len(),
                )
            };
            assert!(read > 0, "pipe read failed");
            output.extend_from_slice(&buffer[..read as usize]);
        }
        output
    }

    #[test]
    fn pushes_stay_bounded_when_the_window_never_drains() {
        let (read_end, write_end) = pipe();
        let output = LocalOutput::start(write_end.as_raw_fd(), 64 * 1024, None).unwrap();
        let block = vec![b'x'; 8192];

        let started = Instant::now();
        for _ in 0..2048 {
            output.push(&block);
        }
        output.push(b"TAIL");
        // 16 MiB against an unread pipe: only the first full queue may wait.
        assert!(
            started.elapsed() < STALL_WAIT * 4,
            "push blocked on the window: {:?}",
            started.elapsed()
        );
        assert!(output.shared.lock().stalled);
        assert!(output.shared.lock().queue.len() <= 64 * 1024);

        // Once drained, the window gets the most recent output, not the oldest.
        let received = read_available(&read_end, |seen| seen.ends_with(b"TAIL"));
        assert!(received.len() < 16 * 1024 * 1024);
        assert!(output.finish(Duration::from_secs(5)));
        assert!(!output.shared.lock().stalled);
        assert!(output.take_redraw_request());
        assert!(!output.take_redraw_request());
        drop(write_end);
    }

    #[test]
    fn a_drop_never_leaves_the_window_inside_a_cut_sequence() {
        let (read_end, write_end) = pipe();
        let output = LocalOutput::start(write_end.as_raw_fd(), 4096, None).unwrap();
        // Title updates (OSC, BEL-terminated) and colored UTF-8 text, like an agent's TUI.
        let unit = "\x1b]0;caf\u{e9} build\x07\x1b[31mr\u{e9}sum\u{e9}\x1b[0m line\n".as_bytes();
        let block: Vec<u8> = unit
            .iter()
            .copied()
            .cycle()
            .take(unit.len() * 300 + 7)
            .collect();
        for _ in 0..200 {
            output.push(&block);
        }
        output.push(b"TAIL");

        let received = read_available(&read_end, |seen| seen.ends_with(b"TAIL"));
        assert!(output.finish(Duration::from_secs(5)));
        // Each drop is followed by CAN (aborts any sequence the window's parser is in) and
        // the surviving bytes start on a sequence or line boundary.
        let cans: Vec<usize> = received
            .iter()
            .enumerate()
            .filter_map(|(index, byte)| (*byte == 0x18).then_some(index))
            .collect();
        assert!(!cans.is_empty(), "no drop was marked");
        for index in cans {
            let next = received[index + 1];
            assert!(
                next == 0x1b || next == b'\n' || next == b'\r',
                "after CAN comes {next:#04x}"
            );
        }
        drop(write_end);
    }

    #[test]
    fn a_draining_window_gets_every_byte_in_order() {
        let (read_end, write_end) = pipe();
        let output = LocalOutput::start(write_end.as_raw_fd(), 64 * 1024, None).unwrap();
        let expected: Vec<u8> = (0..400_000_u32).map(|value| value as u8).collect();
        let reader = thread::spawn(move || read_available(&read_end, |seen| seen.len() >= 400_000));
        for piece in expected.chunks(1000) {
            output.push(piece);
        }
        assert!(output.finish(Duration::from_secs(5)));
        assert_eq!(reader.join().unwrap(), expected);
        assert!(!output.take_redraw_request());
        drop(write_end);
    }

    #[test]
    fn a_closed_window_discards_output_without_blocking() {
        let (read_end, write_end) = pipe();
        drop(read_end);
        let output = LocalOutput::start(write_end.as_raw_fd(), 1024, None).unwrap();
        output.push(b"lost");
        assert!(!output.finish(Duration::from_secs(5)));
        let started = Instant::now();
        output.push(&[b'y'; 4096]);
        assert!(started.elapsed() < STALL_WAIT);
        drop(write_end);
    }
}
