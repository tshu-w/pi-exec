# Background Commands

A `bash` command runs in the foreground or the background, locally, in a Docker container, or on an SSH host. In the background, the tool call returns at once, and the model gets the result in a notification when the command ends.

## 1. Model-facing tool

### `bash`

description:

Pi's `bash` description, followed by:

```text
When a background command ends, you receive a notification with the result.
```

promptGuidelines:

Pi's `bash` guidelines, followed by:

- Use `background=true` for servers, watchers, and other commands that do not exit on their own; do not poll a background command for its end.

parameters:

- `command` and `timeout`: as in Pi's `bash`.
- `background`: Whether to return at once and run the command in the background (default: false)

## 2. Moving to the background

A foreground command still running after `backgroundAfterSecs` seconds (under `"pi-exec"` in Pi's settings, default 120) moves to the background. With `background=true`, a command starts there. Its timeout still applies.

The results, for a moved and a started command, include no output; details are `{ pgid, fullOutputPath }`, with no `structuredContent`:

```text
Command moved to the background (process group 12345). Full output: /tmp/pi-bash-a1b2c3.log
Command started (process group 12345). Full output: /tmp/pi-bash-a1b2c3.log
```

In nested tool calls, such as from a `codemode` script, commands stay in the foreground, and `background` fails with:

```text
`background` is not available in nested tool calls.
```

## 3. Logs

Each command writes its output to `${TMPDIR:-/tmp}/pi-bash-XXXXXX.log` in its environment; it is the `Full output` file in results and notifications. A foreground command's log is deleted when the command ends untruncated, without waiting; a failed deletion keeps it. Background commands' logs are kept.

## 4. Notifications

When a background command ends, the model gets a steer message:

```text
<bash-result pgid="12345" status="failed">
Command: npm run build
Wall time 312.4 seconds
Output:

<output>

[Showing lines 1801-3800 of 3800. Full output: /tmp/pi-bash-a1b2c3.log]

Command exited with code 1
</bash-result>
```

`Command` is the first line, followed by ` …` if there are more. The output is truncated as in Pi's `bash`.

`status` and the last line:

- `completed`: none.
- `failed`: `Command exited with code N`, `Command timed out after N seconds`, or `Command terminated without an exit code`.
- `stopped`: `Command aborted` (stopped in `/jobs`) or `Command stopped because the environment changed` (§6).

Details: `{ pgid, command, status, seconds }`, plus `truncation` and `fullOutputPath` when the output was truncated.

## 5. User interface

A moved or started command's tool call shows `$ <command>` and, in place of the duration, a muted `Moved to the background · <log>` or `Started · <log>`.

A notification shows a header like `$ npm run build  failed  5m 12s`, then the last 5 output lines (`ctrl+o` expands), Pi's truncation warning when truncated, and the last line, as in Pi's `bash`.

While background commands run, a line shows above the editor:

```text
1 command running · /jobs to view
2 commands running · /jobs to view
```

`/jobs` opens a filterable list titled `Jobs` of the session's background commands, ended ones included, with rows `$ <command>  <state>  <time>`. Enter shows a command as its tool call would, live from the last 2000 lines or 50KB of its log. Esc stops it without confirmation (`Command aborted`); Ctrl+C goes back.

## 6. Environment switch and session end

`/env` stops the commands in the environment left; a foreground one ends with `Command stopped because the environment changed`. Leaving the session stops all background commands without notifications; commands in an unreachable environment keep running.

The session records each command moved to the background. When the session starts again, the commands of its branch without a notification in the session, stopped by a session end or left by a Pi process that exited, are reported in one notification that does not start a turn, and are then recorded as reported:

```
<bash-result pgid="<pgid>" status="stopped">
Command: <command>
The session ended before this command did.
Full output: <log>
</bash-result>
```

`Full output` appears while the log exists. Several commands are reported one after another in the same message, separated by blank lines.

While a background command runs, Pi Exec answers the `session:busy` event (`pi.events.emit("session:busy", query)` with `query = { busy: false }`) by setting `query.busy` to `true`, so a hosted Pi does not exit when idle.
