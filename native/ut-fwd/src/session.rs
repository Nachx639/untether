use serde::de;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::error::Error;
use std::ffi::OsString;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::ops::Range;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_SESSION_JSON_BYTES: u64 = 1024 * 1024;
const MAX_JSON_DEPTH: usize = 128;
static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub name: String,
    pub command: Vec<String>,
    pub working_dir: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_cols: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_rows: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_clear_offset: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_repo_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_ahead_count: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_behind_count: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_has_changes: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_is_worktree: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_main_repo_path: Option<String>,
    #[serde(
        default,
        rename = "attachedViaUT",
        skip_serializing_if = "Option::is_none"
    )]
    pub attached_via_ut: Option<bool>,
    /// The forwarder's own pid. 2026-10-20: Terminal windows the web app opens get UUID ids,
    /// not `fwd_…`, so the server could not tell them forwarded (500 ms kill grace, "Killed: 9";
    /// Blindar offered and closed the window's program). The server reads this field instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forwarder_pid: Option<i32>,
    /// Llevar a Untether (2026-10-25): this forwarder took the notice the Kill carried and
    /// wrote it after the program ended. The server writes it itself only without it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_notice_written: Option<bool>,
}

#[derive(Debug)]
pub enum SessionError {
    Io(io::Error),
    Json(serde_json::Error),
    InvalidSessionJson,
}

impl fmt::Display for SessionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "session I/O error: {error}"),
            Self::Json(error) => write!(formatter, "invalid session JSON: {error}"),
            Self::InvalidSessionJson => formatter.write_str("session JSON must be an object"),
        }
    }
}

impl Error for SessionError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
            Self::InvalidSessionJson => None,
        }
    }
}

impl From<io::Error> for SessionError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for SessionError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

/// First write of the session file: the only one that may create its folder (0700).
pub fn write_session_info(path: &Path, info: &SessionInfo) -> Result<(), SessionError> {
    create_parent_directories(path)?;
    write_json_atomic(path, info, false)
}

/// The session folder is gone: the server cleaned the session up (Delete, cleanup of exited
/// sessions). 2026-10-20: the exit write recreated the deleted folder, bringing a session the
/// user had removed back to the list as exited. Later writes skip instead.
fn session_folder_missing(path: &Path) -> bool {
    !parent_directory(path).is_dir()
}

#[cfg(test)]
pub fn read_session_info(path: &Path) -> Result<SessionInfo, SessionError> {
    let data = read_limited(path)?;
    Ok(serde_json::from_slice(&data)?)
}

pub fn read_session_name(path: &Path) -> Option<String> {
    let data = read_limited(path).ok()?;
    let object = parse_top_level_object(&data).ok()??;
    let range = object.name_value?;
    serde_json::from_slice::<String>(&data[range]).ok()
}

/// Fields the forwarder owns once the session runs: its lifecycle. Everything else in the
/// file may have been changed meanwhile by the server or `ut title`, and the file wins.
const LIFECYCLE_KEYS: [&str; 4] = ["status", "exitCode", "pid", "forwarderPid"];

/// Writes `info`'s lifecycle (status, exit code, pid) into the session file and keeps what
/// the file already says for every other field.
///
/// 2026-10-16: the exit write replaced session.json whole and dropped the server's
/// `claudeSessionId` (and `claudeTitle`, `userTitle`), so a `ut claude` window closed with
/// Ctrl+C ended as "Sesión terminada" with no "Resume Claude" (user report).
/// 2026-10-18: the merge still put back the forwarder's own copy of `name` (synced only every
/// 500 ms, and not at all once its watcher stopped) and `lastClearOffset` (0 from the start),
/// undoing a rename made just before the window closed. Falls back to a plain write when the
/// file can't be read as a JSON object.
/// 2026-10-20: also re-reads the file right before writing (no stale copy) and never recreates
/// a folder the server deleted (`session_folder_missing`).
pub fn merge_session_info(path: &Path, info: &SessionInfo) -> Result<(), SessionError> {
    if session_folder_missing(path) {
        return Ok(());
    }
    let serde_json::Value::Object(ours) = serde_json::to_value(info)? else {
        return write_json_atomic(path, info, true);
    };
    let existing = read_limited(path)
        .ok()
        .and_then(|data| serde_json::from_slice::<serde_json::Value>(&data).ok());
    let Some(serde_json::Value::Object(mut merged)) = existing else {
        return write_json_atomic(path, info, true);
    };
    for (key, value) in ours {
        if LIFECYCLE_KEYS.contains(&key.as_str()) || !merged.contains_key(&key) {
            merged.insert(key, value);
        }
    }
    write_json_atomic(path, &merged, true)
}

pub fn update_session_name(path: &Path, name: &str) -> Result<(), SessionError> {
    if session_folder_missing(path) {
        return Ok(());
    }

    let data = read_limited(path)?;
    let object = parse_top_level_object(&data)?.ok_or(SessionError::InvalidSessionJson)?;
    let encoded_name = serde_json::to_vec(name)?;
    let mut updated = Vec::with_capacity(data.len() + encoded_name.len() + 8);

    if let Some(range) = object.name_value {
        updated.extend_from_slice(&data[..range.start]);
        updated.extend_from_slice(&encoded_name);
        updated.extend_from_slice(&data[range.end..]);
    } else {
        updated.extend_from_slice(&data[..object.insertion_index]);
        if object.has_members {
            updated.push(b',');
        }
        updated.extend_from_slice(b"\"name\":");
        updated.extend_from_slice(&encoded_name);
        updated.extend_from_slice(&data[object.insertion_index..]);
    }

    write_bytes_atomic(path, &updated, true)
}

fn read_limited(path: &Path) -> io::Result<Vec<u8>> {
    let file = File::open(path)?;
    let mut data = Vec::new();
    file.take(MAX_SESSION_JSON_BYTES + 1)
        .read_to_end(&mut data)?;
    if data.len() as u64 > MAX_SESSION_JSON_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "session JSON exceeds 1 MiB",
        ));
    }
    Ok(data)
}

struct ParsedObject {
    name_value: Option<Range<usize>>,
    insertion_index: usize,
    has_members: bool,
}

fn parse_top_level_object(data: &[u8]) -> Result<Option<ParsedObject>, serde_json::Error> {
    let mut parser = JsonParser {
        input: data,
        position: 0,
    };
    parser.skip_whitespace();

    let object = if parser.peek() == Some(b'{') {
        Some(parser.parse_object(0, true)?)
    } else {
        parser.parse_value(0)?;
        None
    };

    parser.skip_whitespace();
    if parser.position != data.len() {
        return Err(parser.error("trailing characters"));
    }
    Ok(object)
}

struct JsonParser<'a> {
    input: &'a [u8],
    position: usize,
}

impl JsonParser<'_> {
    fn parse_value(&mut self, depth: usize) -> Result<(), serde_json::Error> {
        if depth > MAX_JSON_DEPTH {
            return Err(self.error("JSON nesting limit exceeded"));
        }

        self.skip_whitespace();
        match self.peek() {
            Some(b'{') => {
                self.parse_object(depth, false)?;
            }
            Some(b'[') => self.parse_array(depth)?,
            Some(b'\"') => {
                self.parse_string()?;
            }
            Some(b't') => self.parse_keyword(b"true")?,
            Some(b'f') => self.parse_keyword(b"false")?,
            Some(b'n') => self.parse_keyword(b"null")?,
            Some(b'-' | b'0'..=b'9') => self.parse_number()?,
            Some(_) => return Err(self.error("expected a JSON value")),
            None => return Err(self.error("unexpected end of JSON")),
        }
        Ok(())
    }

    fn parse_object(
        &mut self,
        depth: usize,
        capture_top_level: bool,
    ) -> Result<ParsedObject, serde_json::Error> {
        self.position += 1;
        let empty_insertion_index = self.position;
        self.skip_whitespace();

        let mut keys = HashSet::new();
        let mut name_value = None;
        if self.consume(b'}') {
            return Ok(ParsedObject {
                name_value,
                insertion_index: empty_insertion_index,
                has_members: false,
            });
        }

        let insertion_index = loop {
            if self.peek() != Some(b'\"') {
                return Err(self.error("expected an object key"));
            }
            let key = self.parse_string()?;
            if !keys.insert(key.clone()) {
                return Err(self.error(&format!("duplicate object key `{key}`")));
            }

            self.skip_whitespace();
            if !self.consume(b':') {
                return Err(self.error("expected `:` after object key"));
            }
            self.skip_whitespace();
            let value_start = self.position;
            self.parse_value(depth + 1)?;
            let value_end = self.position;
            if capture_top_level && key == "name" {
                name_value = Some(value_start..value_end);
            }

            self.skip_whitespace();
            if self.consume(b'}') {
                break value_end;
            }
            if !self.consume(b',') {
                return Err(self.error("expected `,` or `}` in object"));
            }
            self.skip_whitespace();
        };

        Ok(ParsedObject {
            name_value,
            insertion_index,
            has_members: true,
        })
    }

    fn parse_array(&mut self, depth: usize) -> Result<(), serde_json::Error> {
        self.position += 1;
        self.skip_whitespace();
        if self.consume(b']') {
            return Ok(());
        }

        loop {
            self.parse_value(depth + 1)?;
            self.skip_whitespace();
            if self.consume(b']') {
                return Ok(());
            }
            if !self.consume(b',') {
                return Err(self.error("expected `,` or `]` in array"));
            }
            self.skip_whitespace();
        }
    }

    fn parse_string(&mut self) -> Result<String, serde_json::Error> {
        let start = self.position;
        self.position += 1;

        loop {
            match self.peek() {
                Some(b'\"') => {
                    self.position += 1;
                    return serde_json::from_slice(&self.input[start..self.position]);
                }
                Some(b'\\') => {
                    self.position += 1;
                    if self.peek().is_none() {
                        return Err(self.error("unterminated string escape"));
                    }
                    self.position += 1;
                }
                Some(_) => self.position += 1,
                None => return Err(self.error("unterminated string")),
            }
        }
    }

    fn parse_number(&mut self) -> Result<(), serde_json::Error> {
        self.consume(b'-');
        match self.peek() {
            Some(b'0') => self.position += 1,
            Some(b'1'..=b'9') => self.consume_digits(),
            _ => return Err(self.error("invalid JSON number")),
        }

        if self.consume(b'.') {
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.error("invalid JSON number fraction"));
            }
            self.consume_digits();
        }

        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.position += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.position += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.error("invalid JSON number exponent"));
            }
            self.consume_digits();
        }
        Ok(())
    }

    fn parse_keyword(&mut self, keyword: &[u8]) -> Result<(), serde_json::Error> {
        if self.input.get(self.position..self.position + keyword.len()) != Some(keyword) {
            return Err(self.error("invalid JSON literal"));
        }
        self.position += keyword.len();
        Ok(())
    }

    fn consume_digits(&mut self) {
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.position += 1;
        }
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.position += 1;
        }
    }

    fn consume(&mut self, expected: u8) -> bool {
        if self.peek() == Some(expected) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn peek(&self) -> Option<u8> {
        self.input.get(self.position).copied()
    }

    fn error(&self, message: &str) -> serde_json::Error {
        de::Error::custom(format!("{message} at byte {}", self.position))
    }
}

fn write_json_atomic<T>(path: &Path, value: &T, late: bool) -> Result<(), SessionError>
where
    T: Serialize + ?Sized,
{
    let mut data = Vec::new();
    serde_json::to_writer_pretty(&mut data, value)?;
    data.push(b'\n');
    write_bytes_atomic(path, &data, late)
}

/// `late`: a write after the first one, into a folder the server may delete at any moment.
/// 2026-10-20: the exit write checked the folder only at its start; the server deleting it
/// meanwhile made the temp-file open or the rename fail with ENOENT (an error at exit), or the
/// rename landed after `rm -rf` had listed the folder. Late writes look again right before the
/// rename and treat ENOENT as "the session is gone", never as an error.
fn write_bytes_atomic(path: &Path, data: &[u8], late: bool) -> Result<(), SessionError> {
    match write_bytes_atomic_inner(path, data, late) {
        Err(SessionError::Io(error)) if late && error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

fn write_bytes_atomic_inner(path: &Path, data: &[u8], late: bool) -> Result<(), SessionError> {
    if data.len() as u64 > MAX_SESSION_JSON_BYTES {
        return Err(
            io::Error::new(io::ErrorKind::InvalidData, "session JSON exceeds 1 MiB").into(),
        );
    }
    let parent = parent_directory(path);
    let file_name = path.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "session path has no file name")
    })?;

    let (temporary_path, mut file) = loop {
        let sequence = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut temporary_name = OsString::from(".");
        temporary_name.push(file_name);
        temporary_name.push(format!(".{}.{}.tmp", std::process::id(), sequence));
        let temporary_path = parent.join(temporary_name);

        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary_path)
        {
            Ok(file) => break (temporary_path, file),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    };
    let mut temporary = TemporaryFile::new(temporary_path);

    // `mode` is filtered through the process umask; chmod makes the final mode exact.
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    file.write_all(data)?;
    file.flush()?;
    drop(file);

    if late && session_folder_missing(path) {
        // The temp file went with the folder (or `temporary` removes it on drop).
        return Ok(());
    }
    fs::rename(temporary.path(), path)?;
    temporary.disarm();
    Ok(())
}

fn create_parent_directories(path: &Path) -> io::Result<()> {
    let parent = parent_directory(path);
    if parent != Path::new(".") {
        // 2026-10-20: session folders were created 0755 (world-listable).
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)?;
    }
    Ok(())
}

fn parent_directory(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

struct TemporaryFile {
    path: PathBuf,
    armed: bool,
}

impl TemporaryFile {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            loop {
                let sequence = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "untether-session-test-{}-{sequence}",
                    std::process::id()
                ));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("create test directory: {error}"),
                }
            }
        }

        fn join(&self, path: impl AsRef<Path>) -> PathBuf {
            self.0.join(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn sample_info() -> SessionInfo {
        SessionInfo {
            id: "test-session".to_owned(),
            name: "initial name".to_owned(),
            command: vec!["echo".to_owned(), "hi".to_owned()],
            working_dir: "/tmp".to_owned(),
            status: "running".to_owned(),
            exit_code: None,
            started_at: "2025-01-01T00:00:00Z".to_owned(),
            pid: None,
            initial_cols: Some(120),
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
            attached_via_ut: Some(true),
            forwarder_pid: Some(4242),
            window_notice_written: None,
        }
    }

    #[test]
    fn writes_the_forwarder_pid_and_keeps_it_on_the_exit_write() {
        let directory = TestDirectory::new();
        let path = directory.join("session.json");
        let mut info = sample_info();
        write_session_info(&path, &info).unwrap();
        let on_disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk["forwarderPid"], 4242);

        info.status = "exited".to_owned();
        info.exit_code = Some(0);
        merge_session_info(&path, &info).unwrap();
        let after: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(after["forwarderPid"], 4242);
        assert_eq!(after["status"], "exited");
    }

    #[test]
    fn exit_write_and_rename_do_not_recreate_a_deleted_session_folder() {
        let directory = TestDirectory::new();
        let session_dir = directory.join("deleted-session");
        let path = session_dir.join("session.json");
        let mut info = sample_info();
        write_session_info(&path, &info).unwrap();
        // The server cleans the session up while the window still runs.
        fs::remove_dir_all(&session_dir).unwrap();

        info.status = "exited".to_owned();
        info.exit_code = Some(0);
        merge_session_info(&path, &info).unwrap();
        update_session_name(&path, "late title").unwrap();
        assert!(!session_dir.exists());
    }

    #[test]
    fn a_late_write_into_a_folder_deleted_meanwhile_is_not_an_error() {
        // 2026-10-20: the server deleting the folder during the exit write gave ENOENT.
        let directory = TestDirectory::new();
        let path = directory.join("gone").join("session.json");
        write_bytes_atomic(&path, b"{}", true).unwrap();
        assert!(!directory.join("gone").exists());
        assert!(write_bytes_atomic(&path, b"{}", false).is_err());
        // A late write whose folder exists still lands.
        let kept = directory.join("kept");
        fs::create_dir(&kept).unwrap();
        write_bytes_atomic(&kept.join("session.json"), b"{}", true).unwrap();
        assert_eq!(fs::read(kept.join("session.json")).unwrap(), b"{}");
        assert_eq!(fs::read_dir(&kept).unwrap().count(), 1);
    }

    #[test]
    fn first_write_creates_the_session_folder_private() {
        let directory = TestDirectory::new();
        let session_dir = directory.join("new-session");
        let path = session_dir.join("session.json");
        write_session_info(&path, &sample_info()).unwrap();
        let mode = fs::metadata(&session_dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        let file_mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(file_mode, 0o600);
    }

    #[test]
    fn exit_write_keeps_server_fields_written_after_the_forwarder_started() {
        let directory = TestDirectory::new();
        let path = directory.join("session.json");
        let mut info = sample_info();
        write_session_info(&path, &info).unwrap();
        let mut on_disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        on_disk["userTitle"] = "mine".into();
        on_disk["muted"] = true.into();
        on_disk["shielded"] = false.into();
        on_disk["claudeTitle"] = "conv".into();
        fs::write(&path, serde_json::to_vec(&on_disk).unwrap()).unwrap();

        info.status = "exited".to_owned();
        merge_session_info(&path, &info).unwrap();
        let after: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(after["userTitle"], "mine");
        assert_eq!(after["muted"], true);
        assert_eq!(after["shielded"], false);
        assert_eq!(after["claudeTitle"], "conv");
        assert_eq!(after["status"], "exited");
    }

    #[test]
    fn exit_write_keeps_fields_the_server_added() {
        let directory = TestDirectory::new();
        let path = directory.join("session.json");
        let mut info = sample_info();
        write_session_info(&path, &info).unwrap();

        // The server records the Claude conversation while the session runs.
        let mut on_disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        on_disk["claudeSessionId"] = "7ccbfb1c-ad1b-404a-843d-bb31676ce579".into();
        on_disk["claudeTitle"] = "a title".into();
        fs::write(&path, serde_json::to_vec(&on_disk).unwrap()).unwrap();

        info.status = "exited".to_owned();
        info.exit_code = Some(0);
        merge_session_info(&path, &info).unwrap();

        let after: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            after["claudeSessionId"],
            "7ccbfb1c-ad1b-404a-843d-bb31676ce579"
        );
        assert_eq!(after["claudeTitle"], "a title");
        assert_eq!(after["status"], "exited");
        assert_eq!(after["exitCode"], 0);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );

        // Unreadable file: a plain write still records the exit.
        fs::write(&path, b"not json").unwrap();
        merge_session_info(&path, &info).unwrap();
        assert_eq!(read_session_info(&path).unwrap(), info);
    }

    #[test]
    fn exit_write_keeps_a_rename_made_after_the_forwarder_last_read_the_file() {
        let directory = TestDirectory::new();
        let path = directory.join("session.json");
        let mut info = sample_info();
        write_session_info(&path, &info).unwrap();

        // Renamed (server PATCH, git event) and replayed (lastClearOffset) meanwhile; the
        // forwarder's own copy still has the first name and offset 0.
        let mut on_disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        on_disk["name"] = "renamed".into();
        on_disk["lastClearOffset"] = 4096.into();
        on_disk["userTitle"] = "ATLAS".into();
        fs::write(&path, serde_json::to_vec(&on_disk).unwrap()).unwrap();

        info.status = "exited".to_owned();
        info.exit_code = Some(130);
        info.pid = Some(4242);
        merge_session_info(&path, &info).unwrap();

        let after: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(after["name"], "renamed");
        assert_eq!(after["lastClearOffset"], 4096);
        assert_eq!(after["userTitle"], "ATLAS");
        assert_eq!(after["status"], "exited");
        assert_eq!(after["exitCode"], 130);
        assert_eq!(after["pid"], 4242);
    }

    #[test]
    fn writes_reads_and_updates_session_info() {
        let directory = TestDirectory::new();
        let path = directory.join("nested/session.json");
        let info = sample_info();

        write_session_info(&path, &info).unwrap();

        assert_eq!(read_session_info(&path).unwrap(), info);
        assert_eq!(read_session_name(&path).as_deref(), Some("initial name"));

        let data = fs::read_to_string(&path).unwrap();
        assert!(data.ends_with("\n"));
        assert!(data.contains("\"workingDir\""));
        assert!(data.contains("\"initialCols\""));
        assert!(data.contains("\"attachedViaUT\""));
        assert!(!data.contains("exitCode"));
        assert!(!data.contains("initialRows"));
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );

        update_session_name(&path, "updated name").unwrap();
        assert_eq!(read_session_name(&path).as_deref(), Some("updated name"));
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn update_preserves_unknown_fields_and_tolerates_missing_keys() {
        let directory = TestDirectory::new();
        let path = directory.join("session.json");
        let original = r#"{
  "id": "test-session",
  "name": "old name",
  "command": ["bash"],
  "workingDir": "/tmp",
  "status": "running",
  "extraField": "keep-me",
  "nestedObject": { "a": 1 }
}"#;
        fs::write(&path, original).unwrap();

        update_session_name(&path, "new name").unwrap();

        let updated = fs::read_to_string(&path).unwrap();
        assert_eq!(updated, original.replace("\"old name\"", "\"new name\""));
        let value: Value = serde_json::from_str(&updated).unwrap();
        assert_eq!(value["name"], "new name");
        assert_eq!(value["extraField"], "keep-me");
        assert_eq!(value["nestedObject"]["a"], 1);
    }

    #[test]
    fn update_preserves_arbitrary_precision_numbers() {
        let directory = TestDirectory::new();
        let path = directory.join("session.json");
        fs::write(
            &path,
            r#"{"name":"old","integer":18446744073709551616,"exponent":1e400}"#,
        )
        .unwrap();

        update_session_name(&path, "new name").unwrap();

        let updated = fs::read_to_string(&path).unwrap();
        assert_eq!(
            updated,
            r#"{"name":"new name","integer":18446744073709551616,"exponent":1e400}"#
        );
    }

    #[test]
    fn update_preserves_legitimate_serde_private_number_keys() {
        let directory = TestDirectory::new();
        let path = directory.join("session.json");
        let original = r#"{"name":"old","metadata":{"$serde_json::private::Number":"not-a-number"},"$serde_json::private::Number":{"nested":true}}"#;
        fs::write(&path, original).unwrap();

        update_session_name(&path, "new").unwrap();

        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            original.replace("old", "new")
        );
    }

    #[test]
    fn update_adds_name_when_missing() {
        let directory = TestDirectory::new();
        let path = directory.join("session.json");
        fs::write(
            &path,
            r#"{
  "id": "test-session",
  "command": ["bash"],
  "workingDir": "/tmp",
  "status": "running"
}"#,
        )
        .unwrap();

        update_session_name(&path, "inserted name").unwrap();

        let value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(value["name"], "inserted name");
        assert_eq!(value["id"], "test-session");
    }

    #[test]
    fn update_rejects_non_object_json() {
        let directory = TestDirectory::new();
        let path = directory.join("session.json");
        fs::write(&path, "[]\n").unwrap();

        assert!(matches!(
            update_session_name(&path, "new name"),
            Err(SessionError::InvalidSessionJson)
        ));
    }

    #[test]
    fn update_rejects_output_that_would_exceed_size_limit() {
        let directory = TestDirectory::new();
        let path = directory.join("session.json");
        let prefix = br#"{"padding":""#;
        let suffix = br#""}"#;
        let padding_len = MAX_SESSION_JSON_BYTES as usize - prefix.len() - suffix.len();
        let mut original = Vec::with_capacity(MAX_SESSION_JSON_BYTES as usize);
        original.extend_from_slice(prefix);
        original.extend(std::iter::repeat_n(b'a', padding_len));
        original.extend_from_slice(suffix);
        assert_eq!(original.len(), MAX_SESSION_JSON_BYTES as usize);
        fs::write(&path, &original).unwrap();

        assert!(matches!(
            update_session_name(&path, "new"),
            Err(SessionError::Io(error)) if error.kind() == io::ErrorKind::InvalidData
        ));
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[test]
    fn typed_read_rejects_unknown_fields() {
        let directory = TestDirectory::new();
        let path = directory.join("session.json");
        fs::write(
            &path,
            r#"{
  "id": "test-session",
  "name": "name",
  "command": ["bash"],
  "workingDir": "/tmp",
  "status": "running",
  "startedAt": "2025-01-01T00:00:00Z",
  "extraField": true
}"#,
        )
        .unwrap();

        assert!(matches!(
            read_session_info(&path),
            Err(SessionError::Json(_))
        ));
    }

    #[test]
    fn value_reads_reject_duplicate_keys() {
        let directory = TestDirectory::new();
        let path = directory.join("session.json");

        fs::write(&path, r#"{"name":"first","name":"second"}"#).unwrap();
        assert!(read_session_name(&path).is_none());
        assert!(matches!(
            update_session_name(&path, "new name"),
            Err(SessionError::Json(_))
        ));

        fs::write(&path, r#"{"name":"old","nested":{"a":1,"a":2}}"#).unwrap();
        assert!(matches!(
            update_session_name(&path, "new name"),
            Err(SessionError::Json(_))
        ));

        fs::write(&path, r#"{"name":"first","\u006eame":"second"}"#).unwrap();
        assert!(matches!(
            update_session_name(&path, "new name"),
            Err(SessionError::Json(_))
        ));
    }

    #[test]
    fn read_name_returns_none_for_missing_or_invalid_data() {
        let directory = TestDirectory::new();
        let path = directory.join("session.json");

        assert!(read_session_name(&path).is_none());
        fs::write(&path, "not JSON").unwrap();
        assert!(read_session_name(&path).is_none());
        fs::write(&path, r#"{"name": 42}"#).unwrap();
        assert!(read_session_name(&path).is_none());
    }
}
