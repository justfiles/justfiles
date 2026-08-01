#!/usr/bin/env bash
# Gather completion evidence for every non-primary worktree. Read-only.
set -uo pipefail

ROOT="$(git rev-parse --path-format=absolute --git-common-dir)"; ROOT="$(dirname "$ROOT")"
cd "$ROOT" || exit 1

git fetch origin --prune -q || echo "!! fetch failed — evidence may be stale"
if [ -z "$(git status --porcelain)" ] && [ "$(git branch --show-current)" = main ]; then
	git merge --ff-only origin/main -q || echo "!! main is not fast-forwardable to origin/main"
else
	echo "!! primary worktree dirty or not on main — comparing against origin/main directly"
fi
echo "origin/main = $(git rev-parse --short origin/main) $(git log -1 --format=%s origin/main)"
MAIN_TREE="$(git rev-parse origin/main^{tree})"

git worktree list --porcelain |
	awk '/^worktree /{d=$2} /^branch /{print d"\t"$2} /^detached/{print d"\tDETACHED"}' |
while IFS=$'\t' read -r dir ref; do
	[ "$dir" = "$ROOT" ] && continue
	[ "$ref" = DETACHED ] && { echo; echo "### $(basename "$dir")  branch=DETACHED — inspect by hand"; continue; }
	branch="${ref#refs/heads/}"
	echo
	echo "### $(basename "$dir")  branch=$branch"
	echo "dir=$dir"
	echo "head=$(git -C "$dir" rev-parse --short HEAD) $(git -C "$dir" log -1 --format='%s (%cr)')"
	echo "dirty=$(git -C "$dir" status --porcelain | wc -l | tr -d ' ')"

	read -r behind ahead < <(git rev-list --left-right --count "origin/main...$branch" | tr '\t' ' ')
	echo "ahead=$ahead behind=$behind unmerged-patches=$(git cherry origin/main "$branch" 2>/dev/null | grep -c '^+')"

	if git merge-base --is-ancestor "$branch" origin/main; then
		echo "contained=ancestor"
	elif tree="$(git merge-tree --write-tree origin/main "$branch" 2>/dev/null | head -1)" && [ "$tree" = "$MAIN_TREE" ]; then
		echo "contained=merge-is-noop"
	else
		# Do the files this branch touched still differ from main?
		touched="$(mktemp)"
		git diff -z --name-only "$(git merge-base origin/main "$branch")" "$branch" >"$touched"
		differ="$(xargs -0 git diff --name-only origin/main "$branch" -- <"$touched")"
		echo "contained=no (touched=$(tr -cd '\0' <"$touched" | wc -c | tr -d ' ') still-differ=$(printf '%s' "$differ" | grep -c .))"
		[ -n "$differ" ] && echo "  differs: $(echo "$differ" | head -10 | tr '\n' ' ')"
		rm -f "$touched"
	fi

	git rev-parse -q --verify "refs/remotes/origin/$branch" >/dev/null &&
		echo "remote=origin/$branch (local-ahead=$(git rev-list --count "origin/$branch..$branch"))" ||
		echo "remote=none"

	gh pr list --head "$branch" --state all --limit 5 \
		--json number,state,title,url,mergedAt --jq '.[]|"pr=#\(.number) \(.state) merged=\(.mergedAt//"-") \(.url) — \(.title)"' 2>/dev/null |
		grep . || echo "pr=none"

	session="$(tmux ls -F '#{session_name} #{session_path}' 2>/dev/null | awk -v d="$dir" '$2==d{print $1}')"
	echo "tmux=${session:-none}"

	echo "commits-not-in-main:"
	git log --oneline --no-decorate -8 "origin/main..$branch" | sed 's/^/  /'
done
