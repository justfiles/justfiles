# Learn — user flows

Use the [mockups](mockups.html) for appearance and these flows for behavior. Sheets, selections, and expanded threads are local GUI state.

## Library and setup

The gallery shows each workspace's title, goal excerpt, existing lesson count, and useful saved facts such as unfinished practice or a review due. Selecting an item reveals its goal and Resume action. Search starts with titles and mission text.

| Action | Behavior |
| --- | --- |
| New topic | Open a conversation with an editable brief beside it. Save this private draft before any learning folder exists. |
| Clarify | Ask about the practical goal, prior knowledge, constraints, and useful examples. Update the proposed mission and first step. Each exchange is a fresh agent call with the saved brief/history. |
| Create topic | Confirm the brief, create the workspace, transfer setup history, and prepare the first lesson. There is one mission confirmation; ordinary subsequent lessons need no repeated approval. |
| Open / Resume | Open the workspace or its last study checkpoint. |
| Rename | Change the displayed title; retain directory and IDs by default. |
| Archive / Restore | Update archive metadata without moving or losing materials. |
| Remove | Use recoverable removal and make clear that the workspace's materials and notes are included. |

Lesson preparation shows a local working indicator and Stop control. The API returns a final result, so do not invent streamed text or detailed tool progress. Validated material appears in the lesson list; open it automatically only if the learner is still waiting in the initiating flow. Failure leaves the confirmed workspace and useful drafts available for an explicit retry.

## Reading, practice, and the margin

Use three resizable areas: accumulated lessons/references on the left, one material in the centre, and its notes/questions on the right. Collapse navigation and use a margin sheet at narrow widths. All actions and exercises remain keyboard accessible, including entry and exit from the material frame.

Exercise drafts autosave. Submit records the answer before requesting feedback; Hint records assistance; Finish lesson records completion. These are distinct from evidence of understanding. Opening a reference does not replace the unfinished tutorial's study checkpoint.

Selecting text offers Highlight, Note, and Ask, with keyboard alternatives:

| Action | Saved result |
| --- | --- |
| Highlight | Material annotation with quoted context and an empty body. |
| Note | Learner-authored Markdown attached to that passage. |
| Ask | Submitted question with its material, quote or exercise target, followed by the completed reply. |

Questions may also concern the whole material. Follow-ups include relevant messages from that material; switching materials switches available conversations. A late reply stays with its original material without changing navigation. An All notes view links each result back to its material.

After a passage changes, retain unmatched annotations and their original quotes with “Passage changed.” Let the learner reattach them. Tutor updates never rewrite learner notes.

## Finish, review, and inspect memory

After a lesson, show what was practised and one suggested next step with its reason. The learner can start it, review, change direction, or leave. Starting the suggestion generates material using current evidence; the suggestion itself is saved information, not queued work.

The tutor may also propose reference updates, learning records, observations, or reviews. After validation, show links to inspect/correct these updates. Mission changes still require confirmation.

References are repeat lookup aids, such as an ownership rules table; tutorials teach those ideas through examples and practice. Reviews present a short prompt, reason, evidence, and due date. Save the response and assistance before rescheduling. Show due reviews while the app is in use; a date passing never starts an agent.

The memory inspector reads mission, tutor notes, learning records, and reviews directly. Label uncertain assumptions and link observations to attempts/messages. Learners can correct preferences or contest a claim; later evidence can supersede an earlier learning record.

## Stop, close, and return

| Saved situation | On return |
| --- | --- |
| Material open | Restore its saved location, exercise inputs, and notes. |
| Setup or composer draft | Offer the saved text with its original context. |
| Generation interrupted | Show existing materials and recoverable draft files; no spinner or automatic restart. |
| Question lacks a reply | Show the question and offer an explicit retry. |
| Material missing | Open its workspace overview. |
| Workspace missing | Open the library and clear stale paths. |

Autosave during editing and flush before app-controlled navigation. Show Saved only after acknowledgement; a process kill restores the last successful write. Popup placement, selections, and expanded threads need not return. Pause is optional.

Stop requests cancellation and invalidates the local request. Closing attempts cancellation, but abrupt disconnects may leave partial agent output. The [draft publication boundary](material-rendering.md#research-and-file-authoring) keeps that output separate from current materials; reopening does not resume execution.
