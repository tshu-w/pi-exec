# Pi Exec

Pi Exec runs Pi's tools in a Docker container or on an SSH host, while Pi
itself stays local, and runs long commands in the background.

```bash
pi install git:github.com/tshu-w/pi-exec
```

## Usage

```bash
pi --env docker:[user@]container[:/path]
pi --env ssh:[user@]host[:/path]
```

Without a path, the working directory is the user's home. In a session,
`/env` shows the current environment, `/env <environment>` switches, and
`/env off` returns to local execution.

Built-in tools and user `!` commands run in the environment, and paths are
paths there. Project context files such as `AGENTS.md` are read from the
environment. The environment is saved with the session. If `--env` cannot be
reached, tools fail instead of running locally. Agents that
[pi-agents](https://github.com/tshu-w/pi-agents) creates run in the same
environment, with their `cwd` a path there, and cannot be disowned.

A `bash` command still running after `backgroundAfterSecs` moves to the
background, and the model is notified when it ends. `/jobs` lists them. See
[docs/BACKGROUND.md](docs/BACKGROUND.md).

## Configuration

In Pi's `settings.json`:

```json
"pi-exec": { "backgroundAfterSecs": 120 }
```

## Requirements

The environment needs POSIX `sh`, and `setsid` or `perl`; grep also needs
`rg`. Locally, `docker` or `ssh`.

## Development

```bash
npm install
npm run typecheck
npm test
```

Use Node.js >= 22.19.0 for Pi 1.6. With a Homebrew or global npm Pi on PATH,
`npm install` installs the development tooling. If Node declarations are not
available in the Pi installation, install them locally with
`npm install --no-save --package-lock=false @types/node@22`.

For a project-local npm Pi instead:

```bash
npm install --no-save --package-lock=false --legacy-peer-deps=false @earendil-works/pi-coding-agent@1.6.0 @earendil-works/pi-tui@1.6.0 @types/node@22
npm run typecheck
npm test
````

Tests and type checking prefer the project-local Pi and otherwise discover Pi
from its executable on PATH (npm or Homebrew). The typecheck script resolves
Pi's declarations and Node types from the installation without machine-specific
paths in tsconfig.json. The default tests use local commands and simulated
remote failures; real Docker and SSH tests are opt-in:

```bash
npm run test:docker  # requires an available alpine:3 image (PI_EXEC_TEST_IMAGE overrides)
npm run test:ssh     # connects to localhost (PI_EXEC_TEST_SSH overrides)
```

## License

[AGPL-3.0](LICENSE)
