#!/usr/bin/env python3

import json
import os
from pathlib import Path
import pty
import signal
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time


MAX_PAYLOAD = 1024 * 1024


def wait_for(predicate, label, timeout=8.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.03)
    raise AssertionError(f"timed out waiting for {label}")


def frame(kind, payload=b""):
    return bytes([kind]) + struct.pack(">I", len(payload)) + payload


def read_cast(path):
    text = path.read_text(encoding="utf-8")
    rows = [json.loads(line) for line in text.splitlines() if line]
    assert rows and rows[0]["version"] == 2
    return rows


def main():
    binary = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix="ut-", dir="/tmp") as root:
        home = Path(root)
        control_dir = home / "custom-control"
        env = os.environ.copy()
        env["HOME"] = str(home)
        env["UNTETHER_CONTROL_DIR"] = str(control_dir)
        env["UNTETHER_LOG_LEVEL"] = "debug"

        test_exit_and_artifacts(binary, control_dir, env)
        test_non_utf8_option_values(binary, control_dir, env)
        test_non_utf8_home(binary, control_dir, env)
        test_rust_min_stack_is_child_only(binary, env)
        test_child_sigpipe(binary, control_dir, env)
        test_binary_output(binary, control_dir, env)
        test_shutdown_interrupts_backpressured_ipc(binary, control_dir, env)
        test_signal_during_shutdown_cleanup(binary, control_dir, env)
        test_ipc(binary, control_dir, env)
        test_stalled_local_window(binary, control_dir, env, "pipe")
        test_stalled_local_window(binary, control_dir, env, "pty")
        test_close_drains_program_exit(binary, control_dir, env)
        test_close_kills_program_ignoring_sigterm(binary, control_dir, env)
        test_close_writes_window_notice(binary, control_dir, env)

        log_path = home / ".untether/log.txt"
        assert stat.S_IMODE(log_path.stat().st_mode) == 0o600


def test_exit_and_artifacts(binary, control_dir, env):
    session_id = "basic_exit"
    proc = subprocess.Popen(
        [binary, "--session-id", session_id, "/bin/sh", "-c", 'printf "hello\\n"; exit 7'],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    output, stderr = proc.communicate(timeout=10)
    assert proc.returncode == 7, (proc.returncode, stderr)
    assert b"hello" in output

    session_dir = control_dir / session_id
    info = json.loads((session_dir / "session.json").read_text())
    assert info["status"] == "exited" and info["exitCode"] == 7
    assert read_cast(session_dir / "stdout")[-1] == ["exit", 7, session_id]
    assert stat.S_IMODE(session_dir.stat().st_mode) == 0o700
    assert stat.S_IMODE((session_dir / "session.json").stat().st_mode) == 0o600
    assert stat.S_IMODE((session_dir / "stdout").stat().st_mode) == 0o600
    # Input goes through ipc.sock: no stdin artifact (a FIFO nothing read, until 2026-11-10).
    assert not (session_dir / "stdin").exists()
    assert not (session_dir / "ipc.sock").exists()


def test_binary_output(binary, control_dir, env):
    session_id = "binary_output"
    code = 'import os; os.write(1, bytes(range(256)) + b"\\nDONE\\n")'
    proc = subprocess.Popen(
        [binary, "--session-id", session_id, sys.executable, "-c", code],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    output, stderr = proc.communicate(timeout=10)
    assert proc.returncode == 0, (proc.returncode, stderr)
    assert b"DONE" in output and len(output) >= 256

    rows = read_cast(control_dir / session_id / "stdout")
    assert rows[-1] == ["exit", 0, session_id]
    output_text = "".join(
        row[2] for row in rows if isinstance(row, list) and len(row) == 3 and row[1] == "o"
    )
    assert "DONE" in output_text and "\ufffd" in output_text


def test_non_utf8_option_values(binary, control_dir, env):
    session_id = b"raw_options"
    raw_log_path = os.fsencode(control_dir.parent / "log-") + b"\xff"
    raw_binary = os.fsencode(binary)
    true_binary = shutil.which("true")
    assert true_binary is not None
    proc = subprocess.run(
        [
            raw_binary,
            b"--session-id",
            session_id,
            b"--log-file",
            raw_log_path,
            os.fsencode(true_binary),
        ],
        env=env,
        capture_output=True,
        timeout=10,
    )
    assert proc.returncode == 0, (proc.returncode, proc.stderr)
    replacement_log_path = raw_log_path[:-1] + "\ufffd".encode()
    assert not os.path.exists(replacement_log_path)
    if sys.platform == "darwin":
        # APFS rejects malformed UTF-8 path components with EILSEQ. The
        # important parity check here is that no replacement path is created.
        assert not os.path.exists(raw_log_path)
    else:
        assert os.path.exists(raw_log_path)

    updater = subprocess.run(
        [
            raw_binary,
            b"--session-id",
            session_id,
            b"--update-title",
            b"raw\xfftitle",
        ],
        env=env,
        capture_output=True,
        timeout=10,
    )
    assert updater.returncode == 0, (updater.returncode, updater.stderr)
    info = json.loads((control_dir / os.fsdecode(session_id) / "session.json").read_text())
    assert info["name"] == "rawtitle"


def test_non_utf8_home(binary, control_dir, env):
    session_id = "raw_home"
    raw_home = b"/tmp/home-\xff"
    raw_env = {os.fsencode(key): os.fsencode(value) for key, value in env.items()}
    raw_env[b"HOME"] = raw_home
    expected = raw_home.hex().encode()
    code = (
        b"import os,sys;sys.exit(0 if os.environb[b'HOME'].hex().encode()=="
        + repr(expected).encode()
        + b" else 9)"
    )
    proc = subprocess.run(
        [
            os.fsencode(binary),
            b"--session-id",
            os.fsencode(session_id),
            b"--log-file",
            os.fsencode(control_dir.parent / "raw-home.log"),
            os.fsencode(sys.executable),
            b"-c",
            code,
        ],
        env=raw_env,
        capture_output=True,
        timeout=10,
    )
    assert proc.returncode == 0, (proc.returncode, proc.stderr)
    info = json.loads((control_dir / session_id / "session.json").read_text())
    assert info["status"] == "exited" and info["exitCode"] == 0


def test_child_sigpipe(binary, control_dir, env):
    session_id = "child_sigpipe"
    proc = subprocess.Popen(
        [binary, "--session-id", session_id, "/bin/sleep", "30"],
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    session_path = control_dir / session_id / "session.json"
    child_pid = None

    def session_is_running():
        nonlocal child_pid
        try:
            info = json.loads(session_path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return False
        child_pid = info.get("pid")
        return info.get("status") == "running" and isinstance(child_pid, int)

    wait_for(session_is_running, "SIGPIPE child pid")
    os.kill(child_pid, signal.SIGPIPE)
    _, stderr = proc.communicate(timeout=10)
    assert proc.returncode == 141, (proc.returncode, stderr)
    info = json.loads(session_path.read_text())
    assert info["status"] == "exited" and info["exitCode"] == 141


def test_rust_min_stack_is_child_only(binary, env):
    child_env = env.copy()
    child_env["RUST_MIN_STACK"] = "9000000000000000000"
    true_binary = shutil.which("true")
    assert true_binary is not None
    proc = subprocess.run(
        [binary, "--session-id", "rust_min_stack", true_binary],
        env=child_env,
        capture_output=True,
        timeout=10,
    )
    assert proc.returncode == 0, (proc.returncode, proc.stderr)


def test_shutdown_interrupts_backpressured_ipc(binary, control_dir, env):
    session_id = "backpressured_shutdown"
    session_dir = control_dir / session_id
    proc = subprocess.Popen(
        [
            binary,
            "--session-id",
            session_id,
            sys.executable,
            "-c",
            (
                "import os,signal,time,tty;"
                "signal.signal(signal.SIGTERM,signal.SIG_IGN);"
                "signal.signal(signal.SIGINT,signal.SIG_DFL);"
                "tty.setraw(0);os.write(1,b'ready\\n');time.sleep(30)"
            ),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        env=env,
    )
    socket_path = session_dir / "ipc.sock"
    session_path = session_dir / "session.json"
    child_pid = None

    def session_is_running():
        nonlocal child_pid
        try:
            info = json.loads(session_path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return False
        child_pid = info.get("pid")
        return info.get("status") == "running" and isinstance(child_pid, int)

    wait_for(socket_path.exists, "backpressure IPC socket")
    wait_for(session_is_running, "backpressure child pid")
    cast_path = session_dir / "stdout"
    wait_for(
        lambda: cast_path.exists() and "ready" in cast_path.read_text(encoding="utf-8"),
        "raw PTY child",
    )
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.connect(str(socket_path))
        client.sendall(frame(1, b"x" * MAX_PAYLOAD) + frame(4))
        client.settimeout(0.2)
        try:
            response = client.recv(5)
        except socket.timeout:
            response = None
        assert response is None, "PTY input did not backpressure the control worker"

        proc.send_signal(signal.SIGTERM)
        time.sleep(0.2)
        assert proc.poll() is None, "child unexpectedly accepted SIGTERM"
        proc.send_signal(signal.SIGINT)
        _, stderr = proc.communicate(timeout=5)
    finally:
        client.close()
        if proc.poll() is None:
            try:
                os.killpg(child_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.kill()
            proc.communicate(timeout=5)
    assert proc.returncode == 130, (proc.returncode, stderr)

    def child_is_gone():
        try:
            os.kill(child_pid, 0)
        except ProcessLookupError:
            return True
        return False

    wait_for(child_is_gone, "backpressured child exit", timeout=3)
    info = json.loads(session_path.read_text())
    assert info["status"] == "exited" and info["exitCode"] == 130
    assert not socket_path.exists()


def test_signal_during_shutdown_cleanup(binary, control_dir, env):
    session_id = "cleanup_signal"
    session_dir = control_dir / session_id
    child_code = (
        "import os,time;time.sleep(.2);"
        "[os.close(fd) for fd in (0,1,2)];time.sleep(30)"
    )
    closed_file = control_dir.parent / "cleanup-signal-closed"
    proc = subprocess.Popen(
        [binary, "--session-id", session_id, sys.executable, "-c", child_code],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        env={**env, "UNTETHER_FWD_CLOSED_FILE": str(closed_file)},
    )
    socket_path = session_dir / "ipc.sock"
    session_path = session_dir / "session.json"
    child_pid = None

    def session_is_running():
        nonlocal child_pid
        try:
            info = json.loads(session_path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return False
        child_pid = info.get("pid")
        return info.get("status") == "running" and isinstance(child_pid, int)

    try:
        wait_for(socket_path.exists, "cleanup-signal IPC socket")
        wait_for(session_is_running, "cleanup-signal child pid")
        wait_for(lambda: not socket_path.exists(), "shutdown cleanup start")
        time.sleep(1)
        assert proc.poll() is None, "child exited before the late-signal probe"
        proc.send_signal(signal.SIGTERM)
        _, stderr = proc.communicate(timeout=5)
    finally:
        if proc.poll() is None:
            try:
                os.killpg(child_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.kill()
            proc.communicate(timeout=5)
    assert proc.returncode == 143, (proc.returncode, stderr)
    info = json.loads(session_path.read_text())
    assert info["status"] == "exited" and info["exitCode"] == 143
    assert not closed_file.exists(), "a signal to the forwarder is not a close from Untether"


def test_ipc(binary, control_dir, env):
    session_id = "ipc_control"
    session_dir = control_dir / session_id
    proc = subprocess.Popen(
        [
            binary,
            "--session-id",
            session_id,
            "/bin/sh",
            "-c",
            'read line; printf "got:%s\\n" "$line"; sleep 30',
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    socket_path = session_dir / "ipc.sock"
    wait_for(socket_path.exists, "IPC socket")
    assert stat.S_ISSOCK(socket_path.stat().st_mode)
    assert stat.S_IMODE(socket_path.stat().st_mode) == 0o600

    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.connect(str(socket_path))
    heartbeat = frame(4)
    for byte in heartbeat:
        client.sendall(bytes([byte]))
    assert client.recv(5) == heartbeat

    client.sendall(bytes([2]) + struct.pack(">I", MAX_PAYLOAD + 1))
    client.settimeout(3)
    assert client.recv(1) == b""
    client.close()

    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.connect(str(socket_path))
    client.sendall(frame(0xFF, b"ignored") + heartbeat)
    assert client.recv(5) == heartbeat

    client.sendall(frame(2, json.dumps({"cmd": "kill", "signal": "NOPE"}).encode()))
    time.sleep(0.2)
    assert proc.poll() is None

    resize = json.dumps({"cmd": "resize", "cols": 100, "rows": 40}).encode()
    title = json.dumps({"cmd": "update-title", "title": "IPC\x1b]2;unsafe"}).encode()
    client.sendall(frame(2, resize) + frame(2, title) + frame(1, b"hello\n"))
    cast_path = session_dir / "stdout"
    wait_for(lambda: "got:hello" in cast_path.read_text(encoding="utf-8"), "stdin echo")

    updater = subprocess.run(
        [binary, "--session-id", session_id, "--update-title", "CLI\nTitle"],
        env=env,
        capture_output=True,
        timeout=10,
    )
    assert updater.returncode == 0, updater.stderr
    session_path = session_dir / "session.json"
    wait_for(lambda: json.loads(session_path.read_text())["name"] == "CLITitle", "title update")

    kill = json.dumps({"cmd": "kill", "signal": "SIGTERM"}).encode()
    client.sendall(frame(2, kill))
    client.close()
    _, stderr = proc.communicate(timeout=10)
    assert proc.returncode in (42, 143), (proc.returncode, stderr)

    info = json.loads(session_path.read_text())
    assert info["status"] == "exited" and info["name"] == "CLITitle"
    rows = read_cast(cast_path)
    assert any(row[1:] == ["r", "100x40"] for row in rows if isinstance(row, list))
    assert any(row[1:] == ["i", "hello\n"] for row in rows if isinstance(row, list))
    assert not socket_path.exists()


class CastScanner:
    """Finds text appended to a fast-growing cast file after a given point."""

    def __init__(self, path):
        self.path = path
        self.offset = path.stat().st_size
        self.carry = b""

    def seen(self, text):
        needle = text.encode()
        with self.path.open("rb") as handle:
            handle.seek(self.offset)
            data = self.carry + handle.read()
        self.offset += len(data) - len(self.carry)
        if needle in data:
            return True
        self.carry = data[-len(needle):]
        return False


# 2026-10-04: with the Mac screen locked, Terminal.app stopped draining the
# `ut` window. The forwarder blocked writing to its own stdout, stopped reading
# the PTY (the child froze mid-write), and ignored input and Kill from the
# phone. Its stdout here is a pipe or a PTY that nobody ever reads.
def test_stalled_local_window(binary, control_dir, env, kind):
    session_id = f"stalled_window_{kind}"
    session_dir = control_dir / session_id
    # The reply marker is built reversed so the command text in the cast
    # header cannot satisfy the input check.
    child_code = (
        "import os,select\n"
        "i=0\n"
        "while True:\n"
        "    os.write(1, (f'tick {i} ' + 'x'*400 + '\\n').encode()); i+=1\n"
        "    if select.select([0],[],[],0)[0] and b'ping' in os.read(0, 1024):\n"
        "        os.write(1, b'\\n' + b'devieceR-GNOP'[::-1] + b'\\n')\n"
    )
    if kind == "pipe":
        window_read, window_write = os.pipe()
    else:
        window_read, window_write = pty.openpty()
    proc = None
    client = None
    child_pid = None
    try:
        proc = subprocess.Popen(
            [binary, "--session-id", session_id, sys.executable, "-c", child_code],
            stdin=subprocess.DEVNULL,
            stdout=window_write,
            stderr=subprocess.DEVNULL,
            env=env,
        )
        os.close(window_write)
        window_write = None

        socket_path = session_dir / "ipc.sock"
        session_path = session_dir / "session.json"
        cast_path = session_dir / "stdout"

        def session_is_running():
            nonlocal child_pid
            try:
                info = json.loads(session_path.read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                return False
            child_pid = info.get("pid")
            return info.get("status") == "running" and isinstance(child_pid, int)

        wait_for(socket_path.exists, f"{kind}: stalled-window IPC socket")
        wait_for(session_is_running, f"{kind}: stalled-window child pid")

        # The unread window holds at most a few hundred KB (pipe or PTY
        # buffer plus the forwarder's bounded local queue). The recording must
        # keep growing far past that.
        wait_for(
            lambda: cast_path.stat().st_size > 8 * 1024 * 1024,
            f"{kind}: child output keeps reaching the cast with an unread window",
            timeout=20,
        )
        size_before = cast_path.stat().st_size
        time.sleep(0.5)
        assert cast_path.stat().st_size > size_before, f"{kind}: recording stopped growing"

        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.connect(str(socket_path))
        client.settimeout(5)
        client.sendall(frame(4))
        assert client.recv(5) == frame(4), f"{kind}: control socket heartbeat"
        scanner = CastScanner(cast_path)
        client.sendall(frame(1, b"ping\n"))
        wait_for(
            lambda: scanner.seen("PONG-Received"),
            f"{kind}: input from Untether reaches the child",
        )

        client.sendall(frame(2, json.dumps({"cmd": "kill", "signal": "SIGTERM"}).encode()))
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            raise AssertionError(f"{kind}: forwarder did not exit after Kill") from None
        assert proc.returncode == 143, (kind, proc.returncode)
        info = json.loads(session_path.read_text())
        assert info["status"] == "exited" and info["exitCode"] == 143, info
        assert not socket_path.exists()
    finally:
        if client is not None:
            client.close()
        if proc is not None and proc.poll() is None:
            if child_pid:
                try:
                    os.killpg(child_pid, signal.SIGKILL)
                except OSError:
                    # ESRCH, or EPERM once only zombies are left.
                    pass
            proc.kill()
            proc.wait(timeout=5)
        if window_write is not None:
            os.close(window_write)
        os.close(window_read)


CLOSE_RESET = (
    b"\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1004l\x1b[<u\x1b[0m"
)


def run_closed_session(binary, control_dir, env, session_id, child_code, timeout, notice=None):
    """Starts `child_code` under the forwarder with a drained PTY as its window, sends Kill
    (with `notice` for the window, when given) over the control socket once the child printed
    "ready", and returns (returncode, seconds from Kill to exit, window bytes, closed marker
    written). The session file is in `run_closed_session.info`."""
    session_dir = control_dir / session_id
    closed_file = control_dir.parent / f"{session_id}-closed"
    window_master, window_slave = pty.openpty()
    window = bytearray()

    def read_window():
        while True:
            try:
                data = os.read(window_master, 65536)
            except OSError:
                return
            if not data:
                return
            window.extend(data)

    proc = subprocess.Popen(
        [binary, "--session-id", session_id, sys.executable, "-c", child_code],
        stdin=subprocess.DEVNULL,
        stdout=window_slave,
        stderr=subprocess.DEVNULL,
        env={**env, "UNTETHER_FWD_CLOSED_FILE": str(closed_file)},
    )
    os.close(window_slave)
    reader = threading.Thread(target=read_window, daemon=True)
    reader.start()
    client = None
    try:
        socket_path = session_dir / "ipc.sock"
        cast_path = session_dir / "stdout"
        wait_for(socket_path.exists, f"{session_id}: IPC socket")
        wait_for(
            lambda: cast_path.exists() and "ready" in cast_path.read_text(encoding="utf-8"),
            f"{session_id}: child ready",
        )
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.connect(str(socket_path))
        kill = {"cmd": "kill", "signal": "SIGTERM"}
        if notice is not None:
            kill["notice"] = notice
        client.sendall(frame(2, json.dumps(kill).encode()))
        killed_at = time.time()
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            raise AssertionError(f"{session_id}: forwarder did not exit after Kill") from None
        elapsed = time.time() - killed_at
        reader.join(timeout=3)
        info = json.loads((session_dir / "session.json").read_text())
        assert info["status"] == "exited" and info["exitCode"] == proc.returncode, info
        run_closed_session.info = info
        return proc.returncode, elapsed, bytes(window), closed_file.exists()
    finally:
        if client is not None:
            client.close()
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)
        os.close(window_master)


# User report (2026-10-14): Kill from Untether stopped the forwarder's PTY reader, so the
# program blocked writing its exit (final repaint, leaving the alternate screen) and the
# forwarder was SIGKILLed by the server ("Killed: 9" in the window, nothing restored).
def test_close_drains_program_exit(binary, control_dir, env):
    child_code = (
        "import os,signal,sys,time\n"
        "def bye(*_):\n"
        "    os.write(1, ('x'*1000 + '\\n').encode()*330)\n"
        "    os.write(1, b'\\x1b[?1049l' + b'derotser-tixe'[::-1] + b'\\n')\n"
        "    signal.signal(signal.SIGTERM, signal.SIG_DFL)\n"
        "    os.kill(os.getpid(), signal.SIGTERM)\n"
        "signal.signal(signal.SIGTERM, bye)\n"
        "os.write(1, b'\\x1b[?1049h\\x1b[?2004h\\x1b[?25lready\\n')\n"
        "time.sleep(30)\n"
    )
    code, elapsed, window, closed = run_closed_session(
        binary, control_dir, env, "close_drains", child_code, timeout=4
    )
    assert code == 143, code
    assert elapsed < 2.5, f"exit took {elapsed:.1f}s"
    assert b"exit-restored" in window, "the program's exit never reached the window"
    # The program left the alternate screen itself: the reset does not leave it again.
    assert window.endswith(CLOSE_RESET), window[-120:]
    assert closed, "Kill from Untether must write UNTETHER_FWD_CLOSED_FILE"


def test_close_kills_program_ignoring_sigterm(binary, control_dir, env):
    child_code = (
        "import os,signal,time\n"
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        "os.write(1, b'\\x1b[?1049h\\x1b[?1000hready\\n')\n"
        "time.sleep(30)\n"
    )
    code, elapsed, window, closed = run_closed_session(
        binary, control_dir, env, "close_escalates", child_code, timeout=8
    )
    assert code == 137, code
    assert 3.5 < elapsed < 6.5, f"SIGKILL after {elapsed:.1f}s"
    # Still in the alternate screen when killed: the forwarder leaves it.
    assert window.endswith(b"\x1b[?1049l" + CLOSE_RESET), window[-120:]
    assert closed


# Llevar a Untether (2026-10-25): the server wrote "this session continues in Untether" into
# the window's tty 700 ms after the Kill, when the user's zsh wrapper had already closed the
# tab on `ut`'s exit 166 ("notice not written, unavailable"). The Kill carries the notice and
# the forwarder writes it after the program's last frame, before it exits.
def test_close_writes_window_notice(binary, control_dir, env):
    child_code = (
        "import os,time\n"
        "os.write(1, b'\\x1b[?1049hready\\n')\n"
        "time.sleep(30)\n"
    )
    code, _elapsed, window, closed = run_closed_session(
        binary,
        control_dir,
        env,
        "close_notice",
        child_code,
        timeout=8,
        notice="Sigue en Untether \x1b[31m«Bakery»\n",
    )
    assert code == 143, code
    assert closed
    notice = "\r\n\x1b[1mSigue en Untether [31m«Bakery»\x1b[0m\r\n".encode()
    # The test's window is not in raw mode (stdin is not a tty): its ONLCR doubles each \r.
    window = window.replace(b"\r\r\n", b"\r\n")
    assert window.endswith(b"\x1b[?1049l" + CLOSE_RESET + notice), window[-160:]
    assert run_closed_session.info.get("windowNoticeWritten") is True, run_closed_session.info


if __name__ == "__main__":
    main()
