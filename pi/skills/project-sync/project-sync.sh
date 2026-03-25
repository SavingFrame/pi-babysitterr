#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORKSPACE_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../../.." && pwd)
PROJECT_ROOT="${PROJECT_SYNC_ROOT:-$WORKSPACE_ROOT/projects}"

usage() {
	cat <<EOF
Usage:
  sh project-sync.sh list
  sh project-sync.sh sync <project|relative-path|absolute-path> [auto|fetch|pull-ff-only]
  sh project-sync.sh sync-all [auto|fetch|pull-ff-only]
EOF
}

require_git() {
	if ! command -v git >/dev/null 2>&1; then
		echo "error=git-not-installed"
		echo "hint=Install git in the runtime first, e.g. apk add git"
		exit 127
	fi
}

find_repos() {
	find "$PROJECT_ROOT" \( -type d -name .git -o -type f -name .git \) -print | sed 's#/.git$##' | sort
}

list_repos() {
	if [ ! -d "$PROJECT_ROOT" ]; then
		echo "projects_dir=$PROJECT_ROOT"
		echo "projects_found=0"
		echo "hint=Create $PROJECT_ROOT and clone repositories there"
		return 0
	fi

	repos="$(find_repos)"
	if [ -z "$repos" ]; then
		echo "projects_dir=$PROJECT_ROOT"
		echo "projects_found=0"
		echo "hint=No git repositories found under $PROJECT_ROOT"
		return 0
	fi

	printf '%s\n' "$repos" |
		while IFS= read -r repo; do
			[ -n "$repo" ] || continue
			relative="${repo#$PROJECT_ROOT/}"
			if [ "$repo" = "$PROJECT_ROOT" ]; then
				relative="."
			fi
			name="$(basename "$repo")"
			printf 'name=%s\trelative=%s\trepo=%s\n' "$name" "$relative" "$repo"
		done
}

resolve_repo() {
	input="$1"

	case "$input" in
		"")
			return 1
			;;
		"$PROJECT_ROOT"/*)
			candidate="$input"
			;;
		/*)
			candidate="$input"
			;;
		*)
			candidate="$PROJECT_ROOT/$input"
			;;
	esac

	if [ -e "$candidate/.git" ]; then
		printf '%s\n' "$candidate"
		return 0
	fi

	if [ -d "$candidate" ] && git -C "$candidate" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
		printf '%s\n' "$candidate"
		return 0
	fi

	return 1
}

current_branch() {
	git -C "$1" branch --show-current 2>/dev/null || true
}

current_upstream() {
	git -C "$1" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true
}

short_head() {
	git -C "$1" rev-parse --short HEAD 2>/dev/null || true
}

sync_repo() {
	repo="$1"
	mode="${2:-auto}"

	if ! git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
		echo "error=not-a-git-repo"
		echo "repo=$repo"
		return 1
	fi

	relative="${repo#$PROJECT_ROOT/}"
	if [ "$repo" = "$PROJECT_ROOT" ]; then
		relative="."
	fi

	branch="$(current_branch "$repo")"
	upstream_before="$(current_upstream "$repo")"
	head_before="$(short_head "$repo")"
	dirty_paths="$(git -C "$repo" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
	is_dirty="no"
	if [ "$dirty_paths" -ne 0 ]; then
		is_dirty="yes"
	fi

	if ! git -C "$repo" fetch --all --prune >/dev/null 2>&1; then
		echo "repo=$repo"
		echo "relative=$relative"
		echo "branch=$branch"
		echo "upstream=$upstream_before"
		echo "dirty=$is_dirty"
		echo "dirty_paths=$dirty_paths"
		echo "head_before=$head_before"
		echo "head_after=$head_before"
		echo "strategy=fetch-failed"
		echo "reason=git fetch --all --prune failed"
		echo "updated=no"
		echo "ahead="
		echo "behind="
		echo "latest_tree=worktree"
		echo "hint=Check git remotes, credentials, or network access"
		return 1
	fi

	strategy="fetch-only"
	reason="requested fetch-only"
	updated="no"

	case "$mode" in
		auto)
			if [ "$is_dirty" = "yes" ]; then
				reason="dirty worktree, kept files unchanged"
			elif [ -z "$branch" ] || [ -z "$upstream_before" ]; then
				reason="no branch or upstream, kept files unchanged"
			elif git -C "$repo" pull --ff-only --no-rebase >/dev/null 2>&1; then
				strategy="pull-ff-only"
				reason="fast-forwarded clean tracked branch"
			else
				reason="pull --ff-only failed, kept files unchanged"
			fi
			;;
		fetch)
			reason="requested fetch-only"
			;;
		pull-ff-only)
			if [ "$is_dirty" = "yes" ]; then
				reason="dirty worktree, skipped requested pull"
			elif [ -z "$branch" ] || [ -z "$upstream_before" ]; then
				reason="no branch or upstream, skipped requested pull"
			elif git -C "$repo" pull --ff-only --no-rebase >/dev/null 2>&1; then
				strategy="pull-ff-only"
				reason="fast-forwarded requested branch"
			else
				reason="pull --ff-only failed, kept files unchanged"
			fi
			;;
		*)
			echo "error=invalid-mode"
			echo "mode=$mode"
			return 1
			;;
	esac

	head_after="$(short_head "$repo")"
	upstream_after="$(current_upstream "$repo")"
	if [ -n "$head_before" ] && [ -n "$head_after" ] && [ "$head_before" != "$head_after" ]; then
		updated="yes"
	fi

	ahead=""
	behind=""
	if [ -n "$upstream_after" ]; then
		counts="$(git -C "$repo" rev-list --left-right --count HEAD...@{u} 2>/dev/null || true)"
		if [ -n "$counts" ]; then
			set -- $counts
			ahead="$1"
			behind="$2"
		fi
	fi

	echo "repo=$repo"
	echo "relative=$relative"
	echo "branch=$branch"
	echo "upstream=$upstream_after"
	echo "dirty=$is_dirty"
	echo "dirty_paths=$dirty_paths"
	echo "head_before=$head_before"
	echo "head_after=$head_after"
	echo "strategy=$strategy"
	echo "reason=$reason"
	echo "updated=$updated"
	echo "ahead=$ahead"
	echo "behind=$behind"

	if [ "$strategy" = "pull-ff-only" ]; then
		echo "latest_tree=worktree"
		echo "hint=Latest files are available directly under $repo"
	elif [ -n "$upstream_after" ]; then
		echo "latest_tree=remote-ref"
		echo "hint=Working tree unchanged; inspect upstream with: git -C $repo show $upstream_after:path/to/file"
	else
		echo "latest_tree=worktree"
		echo "hint=Working tree unchanged and no upstream is configured"
	fi
}

sync_all() {
	if [ ! -d "$PROJECT_ROOT" ]; then
		echo "projects_dir=$PROJECT_ROOT"
		echo "projects_found=0"
		echo "hint=Create $PROJECT_ROOT and clone repositories there"
		return 0
	fi

	repos="$(find_repos)"
	if [ -z "$repos" ]; then
		echo "projects_dir=$PROJECT_ROOT"
		echo "projects_found=0"
		echo "hint=No git repositories found under $PROJECT_ROOT"
		return 0
	fi

	first=1
	printf '%s\n' "$repos" |
		while IFS= read -r repo; do
			[ -n "$repo" ] || continue
			if [ "$first" -eq 0 ]; then
				echo "---"
			fi
			first=0
			sync_repo "$repo" "$1" || true
		done
}

require_git

command_name="${1:-}"
case "$command_name" in
	list)
		list_repos
		;;
	sync)
		project="${2:-}"
		mode="${3:-auto}"
		if [ -z "$project" ]; then
			usage
			exit 1
		fi
		repo="$(resolve_repo "$project" || true)"
		if [ -z "$repo" ]; then
			echo "error=project-not-found"
			echo "project=$project"
			echo "hint=Run: sh ./project-sync.sh list"
			exit 1
		fi
		sync_repo "$repo" "$mode"
		;;
	sync-all)
		mode="${2:-auto}"
		sync_all "$mode"
		;;
	""|-h|--help|help)
		usage
		;;
	*)
		usage
		exit 1
		;;
esac
