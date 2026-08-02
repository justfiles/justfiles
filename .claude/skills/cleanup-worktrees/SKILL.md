---
name: cleanup-worktrees
description: Audit every git worktree against origin/main, decide which branches are actually done (merged, already in main, or PR closed), delete those worktrees and their local/remote branches, and report. Use when the user wants to clean up worktrees/stale branches or asks which worktrees are still live.
allowed-tools: Bash(git *), Bash(gh *), Bash(tmux *)
---

# Cleanup worktrees

Sweep all worktrees, keep anything unfinished, delete what is provably done.
**Bias to keeping.** Deleting a worktree with unmerged work loses it — when the
evidence is not conclusive, leave it and say why in the report.

## Step 1 — Gather evidence

```bash
bash .agents/skills/cleanup-worktrees/scan.sh
```

One `git fetch` plus one `gh pr list` for the whole repo, then pure local git —
about ten seconds for thirty worktrees. (Per-branch `gh` calls get throttled into
30s stalls; don't reintroduce them.) It fast-forwards `main` (falling back to
comparing against `origin/main`) and prints one block per non-primary worktree:

| field | meaning |
| --- | --- |
| `dirty=N` | uncommitted files in the worktree — anything but `0` blocks cleanup |
| `ahead/behind` | commits vs `origin/main` |
| `unmerged-patches` | `git cherry` count: commits whose patch-id is not in main |
| `contained=ancestor` | branch is an ancestor of `origin/main` — fully merged |
| `contained=merge-is-noop` | merging the branch into main would change nothing — work is in main (covers squash merges) |
| `contained=no (touched=T still-differ=D)` | `D` of the `T` files the branch touched still differ from main |
| `remote=` | remote branch, unpushed commits (`local-ahead`), commits only on the remote (`remote-ahead`), and its full tip SHA for the delete lease |
| `remote-contained=` | printed when `remote-ahead>0`: the same containment verdict for `origin/<branch>`, because the remote tip is what `--delete` destroys |
| `pr=` | every PR for that branch head, with state, merge time and the head SHA GitHub last saw |
| `tip-beyond-prs=N` | commits on the branch that no PR head reaches — work GitHub never saw (local-only or pushed after the PR). `unknown` when the PR head is not in the local object store |
| `pr=unknown` | `gh` failed — the header says so too, and no verdict can rest on PR state |
| `tmux=` | a live agent session rooted in that worktree |

## Step 2 — Verdict per worktree

Containment is the only authority on "the work is in main". A PR's state never
overrides it: a branch can gain commits *after* its PR merged or closed, and those
commits are unreviewed work that deleting the branch would destroy.

**DONE** — needs `dirty=0`, `tmux=none`, no remote-only work (`remote-ahead=0`, or
`remote-contained=ancestor`/`merge-is-noop`), and one of:

1. `contained=ancestor` or `contained=merge-is-noop` — the work is in main, whatever the PR says.
2. Every PR for the branch is `CLOSED` and unmerged, **and** `tip-beyond-prs=0`, **and**
   no unpushed commits (`local-ahead=0`, or `remote=none` with `tip-beyond-prs=0`) — the
   tip is exactly what was abandoned. Say so loudly in the report: this deletes work that
   was never merged.

**KEEP** — everything else, especially: `dirty>0`, a live `tmux` session, `pr=OPEN`, `pr=unknown`,
`pr=none` with commits not in main, `tip-beyond-prs>0` or `unknown`, unpushed commits
(`local-ahead>0`) that are not contained, `remote-ahead>0` with `remote-contained=no`
(another clone pushed work this worktree has never seen).

A `MERGED` PR with `contained=no` is **not** a DONE verdict — the branch usually grew
commits after the squash merge. It may only be upgraded to DONE after inspecting what
the difference actually is:

```bash
SQUASH=$(git log --oneline origin/main --grep "(#<pr>)" | head -1)   # the squash commit in main
git log --oneline <squash-sha>..<branch>                             # what came after it
git diff origin/main <branch> -- <a differing file>                  # main moving on, or lost work?
```

If those extra commits are real work that never landed: KEEP. If they only look
different because main moved past the branch (branch is far `behind`, its version
of the files is the older one): DONE.

## Step 3 — Confirm, then clean

List the DONE set with a one-line reason each and ask the user for a single
go-ahead. Then, per approved worktree:

```bash
git worktree remove "<dir>"                  # never --force: a refusal means unexpected state — re-check
git branch -D "<branch>"
# Only when the scan reported a remote branch. The lease is the tip the scan saw, so a
# push that landed since then aborts the delete instead of destroying it.
git push origin --force-with-lease="refs/heads/<branch>:<remote-tip-from-scan>" ":refs/heads/<branch>"
git worktree prune
```

A `stale info` rejection means the remote moved: re-run the scan for that branch and
re-judge. Never fall back to a plain `--delete`.

If a step fails, stop on that worktree, keep it, and note the failure in the report.

## Step 4 — Report

```markdown
# Worktree cleanup — <date>
main @ <sha> <subject>   ·   scanned N worktrees   ·   removed X, kept Y

## Removed
| worktree | branch | why | remote branch |
|---|---|---|---|
| issue-300 | issue-300 | PR #301 merged (squash), merge is a no-op | deleted |

## Kept
| worktree | branch | why | next step |
|---|---|---|---|
| issue-357 | issue-357 | PR #358 open, 4 commits ahead | land or close #358 |
| fs-0x | chore/fs-0x-versioning | 3 uncommitted files, no PR | review the diff |

## Needs a human
- <worktree>: <what was ambiguous and the command to settle it>
```

Keep the report in the chat unless the user asks for a file.
