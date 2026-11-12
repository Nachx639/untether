//! Keeps session recordings (casts, CONTROL_DIR/<id>/stdout) bounded on disk.
//!
//! 2026-10-22: casts grew without end. A Claude session up for four days used 1.6 GB of real
//! disk, others 950 and 460 MB; the control dir held 3.3 GB. Nothing capped a live cast.
//!
//! A cast is never rewritten or truncated: its writer (this forwarder, or the server's
//! AsciinemaWriter) keeps appending and every reader follows byte offsets into it. Instead, once
//! its real disk use passes a cap, the old middle becomes a hole (F_PUNCHHOLE on macOS): the
//! header line at offset 0 and the last `keep` bytes stay, the apparent size and every offset
//! stay, the disk under the middle is freed and reads there return NUL bytes. The server runs
//! this periodically for every cast (`untether-fwd --compact-cast`), so casts written by any
//! writer, old forwarders still running included, are bounded and existing ones healed.
use serde::Serialize;
use std::ffi::OsString;
use std::fs::{File, FileTimes, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileExt, MetadataExt};
use std::path::Path;

use nix::libc;

/// How far into a cast its header line is looked for.
const MAX_HEADER_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct Report {
    /// Apparent size: unchanged by a compaction.
    pub size: u64,
    /// Bytes on disk before and after.
    pub before: u64,
    pub after: u64,
    /// Length of the range punched, holes already in it included (0 when under the cap).
    pub punched: u64,
}

/// The block-aligned range `(offset, length)` to punch out of a cast of `size` bytes whose
/// header line ends at `header_end`, so that the header and at least the last `keep` bytes
/// stay. None when there is nothing to punch.
pub fn punch_range(header_end: u64, size: u64, keep: u64, block: u64) -> Option<(u64, u64)> {
    if block == 0 {
        return None;
    }
    let start = header_end.div_ceil(block) * block;
    let end = size.saturating_sub(keep) / block * block;
    (end > start).then(|| (start, end - start))
}

/// The block-aligned range to punch so that the hole ends at `end` (rounded down to a block),
/// never past `size`. The server picks `end` (2026-11-01 review): it computed the terminal state
/// a snapshot written into the hole restores right there, and a writer appending in between
/// must not move the hole past it.
pub fn punch_range_until(header_end: u64, size: u64, end: u64, block: u64) -> Option<(u64, u64)> {
    if block == 0 {
        return None;
    }
    let start = header_end.div_ceil(block) * block;
    let end = end.min(size) / block * block;
    (end > start).then(|| (start, end - start))
}

/// Turns the old middle of the cast at `path` into a hole when it uses more than `cap` bytes
/// of disk, keeping its header line and its last `keep` bytes.
pub fn compact(path: &Path, cap: u64, keep: u64) -> io::Result<Report> {
    compact_with(path, cap, |header_end, size, block| {
        punch_range(header_end, size, keep, block)
    })
}

/// compact, the hole ending at `end` (see punch_range_until) instead of `keep` before the end.
pub fn compact_until(path: &Path, cap: u64, end: u64) -> io::Result<Report> {
    compact_with(path, cap, |header_end, size, block| {
        punch_range_until(header_end, size, end, block)
    })
}

fn compact_with(
    path: &Path,
    cap: u64,
    range: impl Fn(u64, u64, u64) -> Option<(u64, u64)>,
) -> io::Result<Report> {
    // Never created or truncated: a missing cast is an error, a running one is left whole.
    let file = OpenOptions::new().read(true).write(true).open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a file"));
    }
    let size = metadata.len();
    let before = allocated_bytes(&file)?;
    let mut report = Report {
        size,
        before,
        after: before,
        punched: 0,
    };
    if before <= cap {
        return Ok(report);
    }
    let header_end = header_end(&file, size)?;
    let Some((offset, length)) = range(header_end, size, block_size(&file)?) else {
        return Ok(report);
    };
    // Punching sets the modification time, which the server reads as the session's last
    // output (session lists, activity): put it back unless the writer appended meanwhile.
    let times = file.metadata()?;
    punch_hole(&file, offset, length)?;
    if file.metadata()?.len() == times.len() {
        file.set_times(
            FileTimes::new()
                .set_accessed(times.accessed()?)
                .set_modified(times.modified()?),
        )?;
    }
    report.after = allocated_bytes(&file)?;
    report.punched = length;
    Ok(report)
}

/// `untether-fwd --compact-cast-until <cap-bytes> <end-offset> <path>...`: as run_cli, each hole
/// ending at `end-offset` (rounded down to a block).
pub fn run_cli_until(args: &[OsString]) -> i32 {
    let number = |arg: Option<&OsString>| {
        arg.and_then(|value| value.to_str())
            .and_then(|value| value.parse::<u64>().ok())
    };
    let (Some(cap), Some(end)) = (number(args.first()), number(args.get(1))) else {
        eprintln!("usage: untether-fwd --compact-cast-until <cap-bytes> <end-offset> <path>...");
        return 2;
    };
    for path in &args[2..] {
        let shown = String::from_utf8_lossy(path.as_bytes()).into_owned();
        let line = match compact_until(Path::new(path), cap, end) {
            Ok(report) => serde_json::json!({ "path": shown, "report": report }),
            Err(error) => serde_json::json!({ "path": shown, "error": error.to_string() }),
        };
        println!("{line}");
    }
    0
}

/// `untether-fwd --compact-cast <cap-bytes> <keep-bytes> <path>...`: one JSON line per path on
/// stdout, its Report or `{"path":…,"error":…}`. Exit code 2 for bad arguments.
pub fn run_cli(args: &[OsString]) -> i32 {
    let number = |arg: Option<&OsString>| {
        arg.and_then(|value| value.to_str())
            .and_then(|value| value.parse::<u64>().ok())
    };
    let (Some(cap), Some(keep)) = (number(args.first()), number(args.get(1))) else {
        eprintln!("usage: untether-fwd --compact-cast <cap-bytes> <keep-bytes> <path>...");
        return 2;
    };
    for path in &args[2..] {
        let shown = String::from_utf8_lossy(path.as_bytes()).into_owned();
        let line = match compact(Path::new(path), cap, keep) {
            Ok(report) => serde_json::json!({ "path": shown, "report": report }),
            Err(error) => serde_json::json!({ "path": shown, "error": error.to_string() }),
        };
        println!("{line}");
    }
    0
}

fn allocated_bytes(file: &File) -> io::Result<u64> {
    // st_blocks counts 512-byte units whatever the file system's block size.
    Ok(file.metadata()?.blocks() * 512)
}

/// The offset just after the cast's first newline (its header line).
fn header_end(file: &File, size: u64) -> io::Result<u64> {
    let mut buffer = vec![0u8; 64 * 1024];
    let mut position = 0u64;
    while position < size.min(MAX_HEADER_BYTES) {
        let read = file.read_at(&mut buffer, position)?;
        if read == 0 {
            break;
        }
        if let Some(newline) = buffer[..read].iter().position(|&byte| byte == b'\n') {
            return Ok(position + newline as u64 + 1);
        }
        position += read as u64;
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "no header line in the first MB",
    ))
}

fn block_size(file: &File) -> io::Result<u64> {
    let mut stats = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: fstatfs fills the struct on success; it is read only then.
    let result = unsafe { libc::fstatfs(file.as_raw_fd(), stats.as_mut_ptr()) };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: initialized by the successful call above.
    #[allow(clippy::unnecessary_cast)]
    let block = unsafe { stats.assume_init() }.f_bsize as u64;
    Ok(block.max(512))
}

#[cfg(target_os = "macos")]
fn punch_hole(file: &File, offset: u64, length: u64) -> io::Result<()> {
    let args = libc::fpunchhole_t {
        fp_flags: 0,
        reserved: 0,
        fp_offset: offset as libc::off_t,
        fp_length: length as libc::off_t,
    };
    // SAFETY: F_PUNCHHOLE reads a valid fpunchhole_t that outlives the call.
    let result = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_PUNCHHOLE, &args) };
    if result == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn punch_hole(file: &File, offset: u64, length: u64) -> io::Result<()> {
    // SAFETY: plain syscall on an open descriptor.
    let result = unsafe {
        libc::fallocate(
            file.as_raw_fd(),
            libc::FALLOC_FL_PUNCH_HOLE | libc::FALLOC_FL_KEEP_SIZE,
            offset as libc::off_t,
            length as libc::off_t,
        )
    };
    if result == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn punch_hole(_file: &File, _offset: u64, _length: u64) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "punching holes is not supported here",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    const MB: u64 = 1024 * 1024;

    #[test]
    fn punch_range_keeps_the_header_block_and_the_tail_block_aligned() {
        // Header ends mid-block: the hole starts at the next block.
        assert_eq!(
            punch_range(100, 10 * MB, 2 * MB, 4096),
            Some((4096, 8 * MB - 4096))
        );
        // A tail cut mid-block keeps that whole block (more than `keep`, never less).
        let (offset, length) = punch_range(100, 10 * MB + 1000, 2 * MB, 4096).unwrap();
        assert_eq!(offset, 4096);
        assert_eq!((offset + length) % 4096, 0);
        assert!(10 * MB + 1000 - (offset + length) >= 2 * MB);
        assert!(10 * MB + 1000 - (offset + length) < 2 * MB + 4096);
        // A header ending exactly on a block boundary: the hole starts right there.
        assert_eq!(punch_range(4096, 3 * 4096, 0, 4096), Some((4096, 2 * 4096)));
    }

    #[test]
    fn punch_range_is_none_when_header_and_tail_cover_the_file() {
        assert_eq!(punch_range(100, 2 * MB, 2 * MB, 4096), None);
        assert_eq!(punch_range(100, MB, 2 * MB, 4096), None);
        assert_eq!(punch_range(100, 8192, 4096, 4096), None);
        assert_eq!(punch_range(100, 10 * MB, MB, 0), None);
    }

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "untether-cast-compact-{}-{name}",
            std::process::id()
        ))
    }

    fn write_cast(path: &Path, events: usize) -> String {
        let header = "{\"version\":2,\"width\":80,\"height\":24}\n";
        let mut file = File::create(path).unwrap();
        file.write_all(header.as_bytes()).unwrap();
        for n in 0..events {
            writeln!(file, "[{n}.5,\"o\",\"line {n:08} {}\"]", "x".repeat(200)).unwrap();
        }
        file.sync_all().unwrap();
        header.to_owned()
    }

    #[test]
    fn compaction_frees_disk_and_keeps_header_tail_size_and_offsets() {
        let path = temp_path("real");
        let header = write_cast(&path, 40_000); // about 9 MB
        let original = std::fs::read(&path).unwrap();
        let size = original.len() as u64;

        let report = compact(&path, 2 * MB, 2 * MB).unwrap();
        let after = std::fs::read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();

        assert_eq!(report.size, size);
        assert_eq!(after.len() as u64, size, "the apparent size stays");
        assert!(report.punched > 0);
        assert!(report.before >= size - 4096, "fully allocated before");
        // Nearly every punched byte is freed; APFS also keeps some blocks it preallocated past
        // the end (seen: 2.3-3.1 MB on disk for a 2 MB tail).
        assert!(report.before - report.after >= report.punched / 10 * 9);
        assert!(
            report.after <= 2 * MB + 3 * MB / 2,
            "disk used after: {} (before {})",
            report.after,
            report.before
        );
        assert!(after.starts_with(header.as_bytes()), "the header stays");
        let tail = (size - 2 * MB) as usize;
        assert_eq!(
            after[tail..],
            original[tail..],
            "the tail stays, at the same offsets"
        );
        let hole_start = 4096usize;
        let hole_end = hole_start + report.punched as usize;
        assert!(after[hole_start..hole_end].iter().all(|&byte| byte == 0));
        assert_eq!(after[..hole_start], original[..hole_start]);
    }

    #[test]
    fn compaction_keeps_the_modification_time() {
        let path = temp_path("mtime");
        write_cast(&path, 20_000);
        let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let report = compact(&path, MB, MB).unwrap();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(report.punched > 0);
        assert_eq!(modified, old);
    }

    #[test]
    fn a_cast_under_the_cap_is_left_alone() {
        let path = temp_path("small");
        write_cast(&path, 1000);
        let original = std::fs::read(&path).unwrap();
        let report = compact(&path, 64 * MB, MB).unwrap();
        let after = std::fs::read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(report.punched, 0);
        assert_eq!(report.before, report.after);
        assert_eq!(after, original);
    }

    #[test]
    fn compacting_again_frees_what_grew_since() {
        let path = temp_path("again");
        write_cast(&path, 20_000);
        let first = compact(&path, MB, MB).unwrap();
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        for n in 0..20_000 {
            writeln!(file, "[{n}.5,\"o\",\"more {n:08} {}\"]", "y".repeat(200)).unwrap();
        }
        file.sync_all().unwrap();
        let second = compact(&path, MB, MB).unwrap();
        let tail = std::fs::read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(first.before - first.after >= first.punched / 10 * 9);
        assert!(second.before > 3 * MB);
        assert!(
            second.before - second.after >= 2 * MB,
            "what grew since is freed"
        );
        assert!(second.after <= MB + 3 * MB / 2);
        assert!(tail.ends_with(format!("more {:08} {}\"]\n", 19_999, "y".repeat(200)).as_bytes()));
    }

    #[test]
    fn punch_range_until_ends_the_hole_where_asked_never_past_the_size() {
        assert_eq!(
            punch_range_until(100, 10 * MB, 6 * MB + 10, 4096),
            Some((4096, 6 * MB - 4096))
        );
        assert_eq!(
            punch_range_until(100, 2 * MB, 6 * MB, 4096),
            Some((4096, 2 * MB - 4096))
        );
        assert_eq!(punch_range_until(100, 10 * MB, 4096, 4096), None);
    }

    #[test]
    fn compact_until_keeps_everything_from_the_end_asked_even_after_appends() {
        let path = temp_path("until");
        write_cast(&path, 20_000);
        let end = 2 * MB;
        // The writer appends after the server picked `end`: the hole still ends there.
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        for n in 0..20_000 {
            writeln!(file, "[{n}.5,\"o\",\"more {n:08} {}\"]", "y".repeat(200)).unwrap();
        }
        file.sync_all().unwrap();
        let original = std::fs::read(&path).unwrap();
        let report = compact_until(&path, MB, end).unwrap();
        let after = std::fs::read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(4096 + report.punched, end);
        assert_eq!(after[end as usize..], original[end as usize..]);
        assert!(after[4096..end as usize].iter().all(|&byte| byte == 0));
    }

    #[test]
    fn a_missing_cast_is_an_error_and_is_not_created() {
        let path = temp_path("missing");
        assert!(compact(&path, 0, 0).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn a_cast_without_a_header_line_is_left_alone() {
        let path = temp_path("headerless");
        std::fs::write(&path, vec![b'x'; 2 * MB as usize]).unwrap();
        let result = compact(&path, 0, 0);
        let after = std::fs::read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(result.is_err());
        assert!(after.iter().all(|&byte| byte == b'x'));
    }
}
