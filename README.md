# pi-git-safe-write

A [pi](https://pi.dev) extension that stops the agent from editing **existing, untracked files** in a git repo without asking. Everything else is allowed through.

## Why

pi's `write` and `edit` tools will happily modify any file the agent decides to touch. If a file already exists on disk, is inside a git repo, but isn't tracked, that's usually something you care about — a `.env`, a local config, a scratch file, a vendored blob — and you probably don't want the model rewriting it silently. This extension gates exactly that case and asks first.

## Decision matrix

The gate is simple: **any existing file that git does not track gets a prompt.**

| File state                                  | Behavior   |
|---------------------------------------------|------------|
| Git-tracked                                 | allow      |
| New file (doesn't exist yet)                | allow      |
| Temp file (`/tmp`, `os.tmpdir()`, ...)      | allow      |
| `.gitignore`-d (explicitly excluded)        | allow      |
| **Existing + untracked, inside a repo**     | **prompt** |
| **Existing + outside any git repo**         | **prompt** |

On the prompt you can pick:

- **Yes (this time only)** — allow once.
- **Yes (remember for session)** — allow and remember the path until `/new` or `/fork`.
- **No** — block the tool call.

If pi has no UI (print/JSON mode) and the file is untracked, the call is blocked with a hint to use `/unsafe`.

## Commands

| Command  | Effect                                                                |
|----------|----------------------------------------------------------------------|
| `/unsafe`| Disable the untracked-file gate for the rest of the session. Persists across `/reload`; resets on `/new` / `/fork`. |
| `/safe`  | Re-enable full protection.                                           |
| `/nosafe`| Disable the entire extension until restart (not persisted).          |

## Install

### As a pi package

```bash
pi install git:github.com/keen99/pi-git-safe-write
# or once it's on npm:
pi install npm:pi-git-safe-write
```

### Manual / project-local

Drop `index.ts` into `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project-local) and `/reload`.

## Requirements

- The `git` binary on `$PATH`. If git isn't available or the path isn't in a repo, the extension silently allows writes (it never accidentally blocks work).

## State

Approvals and the `/unsafe` bypass are stored as custom session entries, so they survive `/reload`. They reset on `/new` and `/fork` because those start fresh sessions.

## License

MIT
