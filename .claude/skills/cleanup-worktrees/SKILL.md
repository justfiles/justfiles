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
| `tip-beyond-prs=N` | commits on the branch that no PR head reaches. `unknown` when the PR head is not in the local object store. Context only, never proof: GitHub's `headRefOid` tracks the live branch, so a push after a PR closed advances it too |
| `pr=unknown` | `gh` failed — the header says so too, and no verdict can rest on PR state |
| `tmux=` | a live agent session rooted in that worktree |

## Step 2 — Verdict per worktree

Three buckets. Only containment can say "the work is in main" — a PR's state never
overrides it, because a branch can gain commits after its PR merged or closed, and
those commits are work that deleting the branch would destroy.

**DONE** — safe to delete without further thought. Needs `dirty=0`, `tmux=none`, no
remote-only work (`remote-ahead=0`, or `remote-contained=ancestor`/`merge-is-noop`), and
`contained=ancestor` or `contained=merge-is-noop`. That is the whole rule: the work is in
main, so nothing can be lost.

**ABANDONED?** — every PR for the branch is `CLOSED` and unmerged, and the branch is
clean. The work is *not* in main, so this is a judgement call, not a verdict. Nothing here
is deleted on the batch go-ahead: report each one with the commits that would die
(`git log --oneline origin/main..<branch>`) and get a per-worktree yes.

Do not try to prove the tip "is only what was abandoned". `tip-beyond-prs=0` cannot show
it (GitHub advances `headRefOid` on any push, including after closure), and neither can
commit dates (a committer date is not a push time, and can predate a close on work pushed
after it). Establishing the head at closure needs the PR timeline, which is not worth a
round trip for a decision a human is making anyway — so show the losses and ask.

**KEEP** — everything else, silently safe: `dirty>0`, a live `tmux` session, `pr=OPEN`,
`pr=unknown`, `pr=none` with commits not in main, `local-ahead>0` on a branch that is not
contained, `remote-ahead>0` with `remote-contained=no` (another clone pushed work this
worktree has never seen).

A `MERGED` PR with `contained=no` is **not** DONE — the branch usually grew commits after
the squash merge. It may only be moved to DONE after inspecting what the difference is:

```bash
SQUASH=$(git log --oneline origin/main --grep "(#<pr>)" | head -1)   # the squash commit in main
git log --oneline <squash-sha>..<branch>                             # what came after it
git diff origin/main <branch> -- <a differing file>                  # main moving on, or lost work?
```

If those extra commits are real work that never landed: KEEP. If they only look
different because main moved past the branch (branch is far `behind`, its version
of the files is the older one): DONE.

## Step 3 — Confirm, then clean

List the DONE set with a one-line reason each and take a single go-ahead for it. List the
ABANDONED? set separately, each with its dying commits, and take a yes or no per worktree.
Then, per approved worktree:

```bash
# The remote first: it is the only step that can fail on new information, and a stale
# lease must find the worktree and branch still intact so the branch can be re-judged.
# Only when the scan reported a remote branch.
git push origin --force-with-lease="refs/heads/<branch>:<remote-tip-from-scan>" ":refs/heads/<branch>"
git worktree remove "<dir>"                   # never --force: a refusal means unexpected state — re-check
git branch -D "<branch>"                      # only works once the worktree is gone
git worktree prune
```

A `stale info` rejection means the remote moved: stop, keep the worktree, re-run the scan
for that branch and re-judge. Never fall back to a plain `--delete`.

If a step fails, stop on that worktree, keep it, and note the failure in the report.

## Step 4 — Report

```markdown
# Worktree cleanup — <date>
main @ <sha> <subject>   ·   scanned N worktrees   ·   removed X, kept Y

## Removed — work is in main
| worktree | branch | why | remote branch |
|---|---|---|---|
| issue-300 | issue-300 | PR #301 merged (squash), merge is a no-op | deleted |

## Abandoned? — not in main, needs your call
| worktree | branch | closed PR | commits that would be lost |
|---|---|---|---|
| fs-sync-convergence | fix/fs-sync-convergence | #243 closed 2026-07-24 | 9 — anti-entropy convergence work, `git log --oneline origin/main..fix/fs-sync-convergence` |

## Kept
| worktree | branch | why | next step |
|---|---|---|---|
| issue-357 | issue-357 | PR #358 open, 4 commits ahead | land or close #358 |
| fs-0x | chore/fs-0x-versioning | 3 uncommitted files, no PR | review the diff |

## Needs a human
- <worktree>: <what was ambiguous and the command to settle it>
```

Keep the report in the chat unless the user asks for a file.
