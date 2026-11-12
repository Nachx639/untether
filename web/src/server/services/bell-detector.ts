/**
 * Finds real terminal bells in PTY output. BEL (0x07) also terminates OSC/DCS/APC/PM
 * strings: Claude Code, Codex and shells end every window-title update with it, so a
 * plain `includes('\x07')` fired a "Terminal Bell" push on each title change (2026-10-02).
 * Keeps state between chunks, since a sequence can be split across reads.
 */
export class BellDetector {
  private escape = false;
  private inString = false;

  /** True if `data` contains at least one BEL outside an escape string. */
  feed(data: string): boolean {
    let bell = false;
    for (let i = 0; i < data.length; i++) {
      const ch = data.charCodeAt(i);
      if (this.inString) {
        if (ch === 0x07) {
          this.inString = false;
        } else if (this.escape && ch === 0x5c) {
          this.inString = false; // ESC \ (string terminator)
        }
        this.escape = ch === 0x1b;
        continue;
      }
      if (this.escape) {
        this.escape = false;
        // OSC ], DCS P, SOS X, PM ^, APC _ open a string ended by BEL or ESC \
        if (ch === 0x5d || ch === 0x50 || ch === 0x58 || ch === 0x5e || ch === 0x5f) {
          this.inString = true;
          continue;
        }
      }
      if (ch === 0x1b) {
        this.escape = true;
      } else if (ch === 0x9d) {
        this.inString = true; // 8-bit OSC
      } else if (ch === 0x07) {
        bell = true;
      }
    }
    return bell;
  }
}
