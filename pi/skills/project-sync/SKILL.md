---
name: project-sync
description: List and sync git repositories stored under the workspace projects directory. Use when a user asks about code in one of those repos and you need fresh upstream state before reading files or answering.
---

# Project Sync

Use this skill for repositories stored under `<workspace>/projects`.

## What this skill does

- lists available git repositories under the workspace `projects/` directory
- safely syncs one repository before you inspect it
- uses a safe default strategy:
  - `auto`: `git fetch --all --prune`, then `git pull --ff-only` only for clean repos with an upstream branch
  - dirty repos stay unchanged and fall back to fetch-only

## Before first use

If `git` is missing in the runtime environment, install it first.

```sh
apk add git
```

On non-Alpine systems, use the appropriate package manager available in your container or runtime.

## Workflow

1. List projects:

```sh
sh ./project-sync.sh list
```

2. Pick the matching repo.

3. Sync that repo before answering questions about it:

```sh
sh ./project-sync.sh sync <project-or-relative-path>
```

Examples:

```sh
sh ./project-sync.sh sync api
sh ./project-sync.sh sync platform/api
sh ./project-sync.sh sync api auto
sh ./project-sync.sh sync api fetch
sh ./project-sync.sh sync api pull-ff-only
```

4. Then inspect the repo with normal tools.

## Output fields

The script prints key/value lines like:

- `repo=` absolute repo path
- `relative=` path relative to the workspace `projects/` directory
- `branch=` current branch
- `upstream=` upstream branch if configured
- `strategy=` `pull-ff-only` or `fetch-only`
- `updated=` `yes` when the working tree moved to a newer commit
- `ahead=` / `behind=` relative to upstream after fetch
- `hint=` next step

## Important behavior

- Prefer syncing only the repo relevant to the question.
- Do **not** sync all repos unless the user asked for that, or you are doing scheduled maintenance.
- If the output says `strategy=fetch-only`, the working tree was left unchanged.
- In that case, for the latest upstream content use remote refs, for example:

```sh
git -C <workspace>/projects/api show origin/main:path/to/file
```

Or inspect commits/logs first:

```sh
git -C <workspace>/projects/api log --oneline HEAD..origin/main
```

## Sync all repos

Only when explicitly needed:

```sh
sh ./project-sync.sh sync-all
```
