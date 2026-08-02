#!/usr/bin/env bash
# Gather completion evidence for every non-primary worktree. Read-only.
# One network fetch + one gh call up front; everything else is local.
set -uo pipefail

ROOT="$(git rev-parse --path-format=absolute --git-common-dir)"; ROOT="$(dirname "$ROOT")"
cd "$ROOT" || exit 1

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

git fetch origin --prune -q </dev/null || echo "!! fetch failed — evidence may be stale"
if [ -z "$(git status --porcelain)" ] && [ "$(git branch --show-current)" = main ]; then
	git merge --ff-only origin/main -q || echo "!! main is not fast-forwardable to origin/main"
else
	echo "!! primary worktree dirty or not on main — comparing against origin/main directly"
fi
echo "origin/main = $(git rev-parse --short origin/main) $(git log -1 --format=%s origin/main)"
MAIN_TREE="$(git rev-parse origin/main^{tree})"

# ancestor | merge-is-noop (covers squash merges) | no
contained_kind() {
	if git merge-base --is-ancestor "$1" origin/main; then
		echo ancestor
	elif [ "$(git merge-tree --write-tree origin/main "$1" 2>/dev/null | head -1)" = "$MAIN_TREE" ]; then
		echo merge-is-noop
	else
		echo no
	fi
}

# Every PR in one shot: per-branch `gh pr list` calls get throttled into 30s stalls.
PR_STATE=ok
gh pr list --state all --limit 1000 --json headRefName,headRefOid,number,state,title,url,mergedAt,closedAt \
	--jq '.[]|[.headRefName,.headRefOid,"pr=#\(.number) \(.state) merged=\(.mergedAt//"-") closed=\(.closedAt//"-") head=\(.headRefOid[0:8]) \(.url) — \(.title)"]|@tsv' \
	>"$TMP/prs" </dev/null || { PR_STATE=failed; echo "!! gh pr list failed — PR state unknown"; }
echo "prs-known=$(wc -l <"$TMP/prs" | tr -d ' ')"

tmux ls -F '#{session_name} #{session_path}' >"$TMP/tmux" 2>/dev/null || : >"$TMP/tmux"
git worktree list --porcelain |
	awk '/^worktree /{d=$2} /^branch /{print d"\t"$2} /^detached/{print d"\tDETACHED"}' >"$TMP/wts"

while IFS=$'\t' read -r dir ref; do
	[ "$dir" = "$ROOT" ] && continue
	echo
	echo "### $(basename "$dir")  branch=${ref#refs/heads/}"
	[ "$ref" = DETACHED ] && { echo "detached HEAD — inspect by hand"; continue; }
	branch="${ref#refs/heads/}"
	echo "dir=$dir"
	echo "head=$(git -C "$dir" rev-parse --short HEAD) $(git -C "$dir" log -1 --format='%s (committed %cs)')"
	echo "dirty=$(git -C "$dir" status --porcelain | wc -l | tr -d ' ')"

	read -r behind ahead < <(git rev-list --left-right --count "origin/main...$branch" | tr '\t' ' ')
	echo "ahead=$ahead behind=$behind unmerged-patches=$(git cherry origin/main "$branch" | grep -c '^+')"

	if [ "$(contained_kind "$branch")" = no ]; then
		# Do the files this branch touched still differ from main?
		git diff -z --name-only "$(git merge-base origin/main "$branch")" "$branch" >"$TMP/touched"
		differ="$(xargs -0 git diff --name-only origin/main "$branch" -- <"$TMP/touched")"
		echo "contained=no (touched=$(tr -cd '\0' <"$TMP/touched" | wc -c | tr -d ' ') still-differ=$(printf '%s' "$differ" | grep -c .))"
		[ -n "$differ" ] && echo "  differs: $(echo "$differ" | head -10 | tr '\n' ' ')"
	else
		echo "contained=$(contained_kind "$branch")"
	fi

	if git rev-parse -q --verify "refs/remotes/origin/$branch" >/dev/null; then
		# Another clone may have pushed commits this worktree has never seen.
		remote_ahead="$(git rev-list --count "$branch..origin/$branch")"
		echo "remote=origin/$branch (local-ahead=$(git rev-list --count "origin/$branch..$branch") remote-ahead=$remote_ahead tip=$(git rev-parse origin/"$branch"))"
		[ "$remote_ahead" -gt 0 ] && echo "remote-contained=$(contained_kind "origin/$branch")"
	else
		echo "remote=none"
	fi

	if [ "$PR_STATE" = ok ]; then
		awk -F'\t' -v b="$branch" '$1==b{print $3; f=1} END{if(!f) print "pr=none"}' "$TMP/prs"
		# Commits the branch grew beyond every PR head. GitHub's headRefOid tracks the live
		# branch, so 0 never proves a tip was abandoned: context, not evidence.
		heads=""; missing=0
		for sha in $(awk -F'\t' -v b="$branch" '$1==b{print $2}' "$TMP/prs"); do
			git cat-file -e "$sha^{commit}" 2>/dev/null && heads="$heads $sha" || missing=1
		done
		if [ -n "$heads" ]; then
			echo "tip-beyond-prs=$(git rev-list --count "$branch" --not $heads)$([ $missing = 1 ] && echo ' (a PR head is missing locally)')"
		elif [ $missing = 1 ]; then
			echo "tip-beyond-prs=unknown (PR heads missing locally)"
		fi
	else
		echo "pr=unknown (gh failed)"
	fi

	echo "tmux=$(awk -v d="$dir" '$2==d{print $1}' "$TMP/tmux" | tr '\n' ' ' | grep . || echo none)"
	echo "commits-not-in-main:"
	git log --oneline --no-decorate -8 "origin/main..$branch" | sed 's/^/  /'
done <"$TMP/wts"
