---
name: pr-feedback
description: Read the review feedback on the current PR, judge each finding through three gates (is it correct, does it move the design, is it worth the effort now), then fix, push back, or stop and ask. Use when the user says there is feedback on the PR, points at a codex or reviewer comment, or asks to address review findings.
---

# PR feedback

Judge every finding before you touch code. A review is evidence, not an order.
Three gates, in order. A finding that fails a gate stops there.

## Find the feedback

Inline review comments do NOT show up in `gh pr view --json comments`. That
field holds only top-level comments, and a codex review body is usually an empty
shell. Always read the inline comments through the API:

```sh
# gh fills in {owner} and {repo} on its own. The PR number it does not, so read
# it from the branch you are on.
gh api "repos/{owner}/{repo}/pulls/$(gh pr view --json number --jq .number)/comments" \
  --jq '.[] | "=== \(.path):\(.line // .original_line) [\(.user.login)] id=\(.id)\n\(.body)\n"'
```

Keep each comment's `id`. You reply to that thread with it. Read your own
earlier replies in that list too — a second review answers the first one, and a
finding you already argued may be back with new evidence, or may be new.

## Gate 1 — is it correct?

Check the claim yourself, in the code. Never take it on faith, and never take it
on the badge: `P1` is the reviewer's guess at severity, not a verdict.

A finding usually rests on a premise about some OTHER file — "T7 selects
subscribe whenever it exists", "this path is only called from X". **Open that
file and confirm the premise.** Half of judging a finding is checking the part
the reviewer did not show you.

- **Wrong** → push back. Reply with the evidence that disproves it: the file and
  line that show otherwise. Do not change code to satisfy a wrong review, and do
  not soften a correct design to end an argument.
- **Right, or right in part** → say which part, and go to gate 2.

## Gate 2 — does it move the design?

**Stop and ask the user. Do not implement.** This gate is not yours to pass
alone, even when the finding is plainly correct and the fix is small.

Signals that a fix moves the design:

- it widens a seam: a new exported name, a new method or option on an interface,
  a new field on a shared type
- it adds a dependency between modules that did not know about each other
- it contradicts a design doc, a task file, or a decision already agreed
- it asks for a workaround where a doc named a constraint
- it trades a stated principle (keep the surface minimal) for a local win

Bring the user the choice, not the change: what the finding is, the options you
see, what each one costs, and which one you would pick. Then wait.

Removing surface is not this gate. Deleting a method the backend cannot honour
is a fix, not a design change — that goes to gate 3.

## Gate 3 — is it worth fixing now?

Weigh the work against how rare the case is.

- **Worth it** → fix it, then: run the focused test, then the package tests, then
  `pnpm typecheck`. Commit, push, reply to the thread, tag codex.
- **Not worth it now** → say so in the reply, with the reason: how rare the case
  is, and what the fix would cost. Then write it where the next reader will look
  — the task file or an issue. A finding you drop silently comes back as a bug.

Fix the cause, not the symptom. If the finding shows a test that cannot fail,
mutate the code to prove the new test does fail without the fix.

## Reply and re-review

Reply on the thread the finding came from, so the answer sits with the question:

```sh
gh api "repos/{owner}/{repo}/pulls/$(gh pr view --json number --jq .number)/comments/<id>/replies" \
  -f body="..."
```

State the verdict first: agreed and fixed (with the commit), disagreed (with the
evidence), or deferred (with the reason). Say what you checked. End every reply
that follows a change with `@codex review`, per CLAUDE.md.

## Report back

One line per finding, so the user can see the whole review at a glance:

| Finding | Gate | Verdict |
| --- | --- | --- |
| connection-local `subscribe` | 3 | agreed — removed, pinned by a test |
| rename `decode` | 1 | pushed back — the name is the one the design uses |

Say plainly what you changed, what you refused, and what waits on the user.
