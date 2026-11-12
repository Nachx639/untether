# Event log (`ut events`)

Untether keeps a durable log of what happens to your tasks and agent sessions, so scripts and
other tools can react to it: "task X needs you", "session Y is waiting", "the doctor found
something". Every event has an id one above the previous one; a reader that resumes from the
last id it saw gets every later event once, in order, also across server restarts.

## What is recorded

| Type | When | Fields besides `id`, `at`, `type` |
| --- | --- | --- |
| `task.state` | A task is created, changes state, or what holds it changes | `taskId`, `project`, `dir`, `branch`, `agent`, `sessionId`, `state`, `from`, `reason` (blocker kind), `message` |
| `session.state` | An agent session goes `busy` / `waiting` / `idle`, or `exited` | `sessionId`, `agent` (`claude`, `codex`, `gemini`), `name`, `dir`, `project` (its repository, also for a worktree elsewhere), `state`, `from`, `reason` (`permission`, `question`, `halted`), `background` (busy only with background work) |
| `doctor.finding` | The doctor finds (or heals) a problem | `key`, `check`, `severity`, `message`, `healed` |
| `doctor.cleared` | A problem it found is gone | `key` |
| `push` | A push notification is raised (bells excepted), sent or not | `pushType`, `title`, `sessionId`, `taskId` |

Where session states come from: Claude's own status (the same one its pushes use), Codex's
rollout (`waiting` on a permission or a question, `idle` with reason `halted` at a usage limit or
API error), Gemini's chat file (`busy` or `idle` only). A state is told when it changes; after a
server restart only what changed since is told again.

Task states: `scheduled`, `queued`, `preparing`, `working`, `needs_you`, `paused`, `verifying`,
`merging`, `ready`, `merged`, `done`, `failed`, `discarded`, `missed`.

No prompts, task titles, push bodies or agent replies are kept, only the fields above; every text
goes through Untether's secret redaction and is cut to 300 characters. The `message` of a
`needs_you` task is what holds it (for example the agent's question).

The log lives in `~/.untether/control/events/` as JSONL segments: a segment closes at 4 MB or
after a day, closed segments go after 14 days or past 64 MB in all (the newest always stays,
so ids never start over).

## CLI

```bash
ut events                          # everything kept, then "resume: ut events --after N" on stderr
ut events --after 1200             # only what came after event 1200
ut events --follow                 # and keep printing new events until Ctrl-C
ut events --type task --type session.state --project ~/Projects/app
ut events --follow --json | jq -c 'select(.state == "needs_you")'
```

- `--type`: `task`, `session`, `doctor`, `push` (a family) or a full type; repeat it or use commas.
- `--project DIR`: that repository's tasks and agent sessions, its worktrees included wherever
  they are (DIR may be a subfolder or a worktree of it).
- `--json`: one JSON object per line on stdout; notes (log restarted, events rotated away) and
  the resume line go to stderr.
- `--follow` waits through a server restart and goes on from the same id.

## HTTP

With a signed-in session (the same authentication as the web app):

```
GET /api/events?after=<id>&types=task,session&project=<dir>&limit=<1..1000>
→ { "events": [...], "cursor": 1234, "lastId": 1240, "oldestId": 1, "gap": false, "reset": false }

GET /api/events/stream?after=<id>&types=…&project=…        (text/event-stream)
```

- Resume a page read with `after=<cursor>`: the cursor also moves past events the filters skipped.
- The stream sends each event as `id: <id>`, `event: <type>`, `data: <json>`. `EventSource`
  reconnects with `Last-Event-ID`, which takes precedence over `after`.
- `gap: true` (or an `event: gap`) means events after your id were rotated away before you
  read them; `reset: true` (or `event: reset`) that your id is past the log's last one (the
  log folder was removed), so it reads from the start.

## Example: Telegram when something needs you

```bash
#!/bin/bash
# ~/bin/untether-telegram: TELEGRAM_TOKEN and TELEGRAM_CHAT in the environment.
set -euo pipefail
state="$HOME/.untether-telegram-last-id"
after=$(cat "$state" 2>/dev/null || echo 0)

ut events --follow --json --after "$after" --type task.state --type session.state |
while IFS= read -r line; do
  id=$(jq -r .id <<<"$line")
  text=$(jq -r '
    if .type == "task.state" and (.state == "needs_you" or .state == "failed" or .state == "ready")
      then "Task \(.branch // .taskId) is \(.state)\(if .message then ": \(.message)" else "" end)"
    elif .type == "session.state" and .state == "waiting"
      then "\(.name // .sessionId) is waiting for you"
    else empty end' <<<"$line")
  if [ -n "$text" ]; then
    curl -fsS "https://api.telegram.org/bot$TELEGRAM_TOKEN/sendMessage" \
      --data-urlencode "chat_id=$TELEGRAM_CHAT" --data-urlencode "text=$text" >/dev/null
  fi
  echo "$id" > "$state"   # after it was handled: a restart of this script misses nothing
done
```

Run it under `launchd` or in a shielded Untether session; after a crash it starts again from the
last id it handled.
