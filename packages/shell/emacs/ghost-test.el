;;; ghost-test.el --- Tests for ghost.el -*- lexical-binding: t; -*-

;; Run from this directory:
;;   emacs -Q --batch -L . -l ghost-test.el -f ert-run-tests-batch-and-exit

;;; Code:

(require 'cl-lib)
(require 'ert)
(require 'ghost)

(defun ghost-test--entry (&rest fields)
  "A transcript entry alist from FIELDS, a plist."
  (let (entry)
    (while fields
      (push (cons (intern (substring (symbol-name (pop fields)) 1)) (pop fields))
            entry))
    (nreverse entry)))

(defmacro ghost-test--with-transcript (&rest body)
  "Run BODY with a fresh `*ghost*' and no watch."
  `(let ((ghost--watch nil) (ghost--status nil) (ghost--unseen nil)
         (ghost--idle-timer nil) (ghost--restart-timer nil) (ghost--asks 0) (ghost--partial nil)
         (ghost--answering nil) (ghost--last-answer nil)
         (ghost--calls (make-hash-table :test #'equal))
         (ghost--sending nil) (ghost--running nil) (ghost--activity nil)
         (ghost--activity-overlay nil) (ghost--activity-timer nil))
     (when (get-buffer "*ghost*") (kill-buffer "*ghost*"))
     (unwind-protect (progn ,@body)
       (ghost--stop-watch)
       (when ghost--activity-timer (cancel-timer ghost--activity-timer))
       (when ghost--idle-timer (cancel-timer ghost--idle-timer))
       (when (get-buffer "*ghost*") (kill-buffer "*ghost*")))))

(defun ghost-test--text ()
  "The visible text of `*ghost*'."
  (with-current-buffer "*ghost*"
    (let ((text "") (pos (point-min)))
      (while (< pos (point-max))
        (let ((next (next-char-property-change pos)))
          (unless (invisible-p pos)
            (setq text (concat text (buffer-substring-no-properties pos next))))
          (setq pos next)))
      text)))

(defun ghost-test--snapshot (&rest entries)
  "A snapshot event of ENTRIES, idle."
  `((type . "snapshot")
    (transcript (entries . ,(vconcat entries)))
    (status (busy) (queued . 0))))

(ert-deftest ghost-test-renders-a-turn-with-folded-tool-calls ()
  (ghost-test--with-transcript
   (ghost--event
    (ghost-test--snapshot
     (ghost-test--entry :id 1 :kind "user" :text "Read it." :askId "a"
                        :at "2026-10-21T09:05:00Z")
     (ghost-test--entry :id 2 :kind "assistant" :text ""
                        :toolCalls `[((id . "c1") (name . "read")
                                      (args (path . "/notes.md")))])
     (ghost-test--entry :id 3 :kind "tool" :callId "c1" :name "read"
                        :text "the notes" :isError nil)
     (ghost-test--entry :id 4 :kind "assistant" :text "Done." :toolCalls [])))
   (let ((text (ghost-test--text)))
     (should (string-match-p "you › Read it\\." text))
     (should (string-match-p "  ▸ read {\"path\":\"/notes.md\"}\n.*ghost › Done\\."
                             text))
     (should-not (string-match-p "the notes" text))
     (should-not (string-match-p "◆" text)))
   (with-current-buffer "*ghost*"
     ;; The ask, label to newline, is set off; the answer is not.
     (goto-char (point-min))
     (should (memq 'ghost-ask (ensure-list (get-text-property (point) 'face))))
     (search-forward "Read it.")
     (should (memq 'ghost-ask (ensure-list (get-text-property (point) 'face))))
     (search-forward "Done")
     (should-not (memq 'ghost-ask (ensure-list (get-text-property (point) 'face))))
     (goto-char (point-min))
     (search-forward "▸ read")
     (ghost-toggle-call)
     (should (string-match-p "▾ read .*\n.*\n    result:\n      the notes"
                             (ghost-test--text)))
     (ghost-toggle-call)
     (should-not (string-match-p "the notes" (ghost-test--text))))
   (should (equal ghost--last-answer "Done."))))

(ert-deftest ghost-test-streams-an-answer-and-replaces-it-with-the-entry ()
  (ghost-test--with-transcript
   (ghost--event (ghost-test--snapshot
                  (ghost-test--entry :id 1 :kind "user" :text "Hi" :askId "a")))
   (ghost--event '((type . "text") (delta . "Hel")))
   (ghost--event '((type . "text") (delta . "lo")))
   (should (string-suffix-p "ghost › Hello" (ghost-test--text)))
   ;; An input that arrives meanwhile goes above the answer being written.
   (ghost--event `((type . "entry")
                   (entry . ,(ghost-test--entry :id 2 :kind "user"
                                                :text "And?" :askId "b"))))
   (should (string-match-p "you › And\\?\n.*ghost › Hello\\'" (ghost-test--text)))
   (ghost--event `((type . "entry")
                   (entry . ,(ghost-test--entry :id 3 :kind "assistant"
                                                :text "Hello there."
                                                :toolCalls []))))
   (let ((text (ghost-test--text)))
     (should (string-suffix-p "ghost › Hello there.\n" text))
     (should-not (string-match-p "Hello\\(\n\\|\\'\\)" text)))
   (should-not ghost--partial)))

(defun ghost-test--activity ()
  "The activity line at the end of `*ghost*', nil when there is none."
  (with-current-buffer "*ghost*"
    (seq-some (lambda (overlay) (overlay-get overlay 'after-string))
              (overlays-in (point-max) (point-max)))))

(ert-deftest ghost-test-shows-what-the-ghost-is-doing-at-the-end ()
  (ghost-test--with-transcript
   (let ((ghost-spinner nil))
     (ghost--event (ghost-test--snapshot))
     (should-not (ghost-test--activity))
     ;; Sent, before the ghost takes it up.
     (setq ghost--sending t)
     (ghost--update-activity)
     (should (equal (ghost-test--activity) "  … sending · 0s\n"))
     (ghost--event '((type . "status") (status (busy . t) (queued . 0))))
     (ghost--event `((type . "entry")
                     (entry . ,(ghost-test--entry :id 1 :kind "user" :text "Hi"
                                                  :askId "a"))))
     (should-not ghost--sending)
     (should (equal (ghost-test--activity) "  … thinking · 0s\n"))
     (setcdr ghost--activity (time-subtract nil 75))
     (ghost--draw-activity)
     (should (equal (ghost-test--activity) "  … thinking · 1m 15s\n"))
     ;; While it writes, a cursor after the text.
     (ghost--event '((type . "text") (delta . "Let me look")))
     (should (equal (ghost-test--activity) "▍"))
     (ghost--event `((type . "entry")
                     (entry . ,(ghost-test--entry
                                :id 2 :kind "assistant" :text "Let me look."
                                :toolCalls [((id . "c1") (name . "bash") (args))
                                            ((id . "c2") (name . "read") (args))]))))
     (ghost--event '((type . "tool") (callId . "c1") (name . "bash")))
     (ghost--event '((type . "tool") (callId . "c2") (name . "read")))
     (should (equal (ghost-test--activity) "  … running bash, read · 0s\n"))
     (ghost--event `((type . "entry")
                     (entry . ,(ghost-test--entry :id 3 :kind "tool" :callId "c1"
                                                  :name "bash" :text "ok"))))
     (should (equal (ghost-test--activity) "  … running read · 0s\n"))
     ;; A snapshot drops the overlay, and the next draw makes it again.
     (ghost--event `((type . "snapshot") (transcript (entries . []))
                     (status (busy . t) (queued . 0))))
     (should (equal (ghost-test--activity) "  … thinking · 0s\n"))
     (ghost--event '((type . "status") (status (busy) (queued . 0))))
     (should-not (ghost-test--activity))
     (should-not ghost--activity-timer))))

(ert-deftest ghost-test-forgets-the-transcript-when-its-buffer-is-killed ()
  (ghost-test--with-transcript
   (ghost--event
    (ghost-test--snapshot
     (ghost-test--entry :id 1 :kind "assistant" :text ""
                        :toolCalls [((id . "c1") (name . "read") (args))])))
   (ghost--event '((type . "text") (delta . "Hal")))
   (let ((proc (make-pipe-process :name "ghost-test" :noquery t)))
     (setq ghost--watch proc)
     (kill-buffer "*ghost*")
     (should-not (process-live-p proc)))
   (should-not ghost--watch)
   (should-not ghost--partial)
   (should (zerop (hash-table-count ghost--calls)))
   ;; What comes after draws into a new buffer.
   (ghost--event
    `((type . "entry")
      (entry . ,(ghost-test--entry :id 2 :kind "tool" :callId "c1"
                                   :name "read" :text "x" :isError nil))))
   (ghost--event `((type . "entry")
                   (entry . ,(ghost-test--entry :id 3 :kind "assistant"
                                                :text "Hallo." :toolCalls []))))
   (should (string-match-p "▸ read {}\n.*ghost › Hallo\\.\n\\'"
                           (ghost-test--text)))))

(ert-deftest ghost-test-does-not-restart-a-watch-stopped-while-it-waits ()
  (ghost-test--with-transcript
   (let ((proc (make-pipe-process :name "ghost-test" :noquery t)))
     (setq ghost--watch proc)
     (process-put proc 'ghost-connected t)
     (delete-process proc)
     (ghost--watch-ended proc "deleted")
     (should (timerp ghost--restart-timer))
     (let ((timer ghost--restart-timer))
       (ghost--buffer)
       (kill-buffer "*ghost*")
       (should-not ghost--restart-timer)
       (should-not (memq timer timer-list))))))

(ert-deftest ghost-test-marks-entries-that-answer-no-ask ()
  (ghost-test--with-transcript
   (ghost--event
    (ghost-test--snapshot
     (ghost-test--entry :id 1 :kind "reset" :handoff "Carry on.")
     (ghost-test--entry :id 2 :kind "assistant" :text "On my own."
                        :toolCalls [])))
   (let ((text (ghost-test--text)))
     (should (string-match-p "new session" text))
     (should (string-match-p "Carry on\\." text))
     (should (string-match-p "◆ ghost › On my own\\." text)))))

(ert-deftest ghost-test-moves-between-turns ()
  (ghost-test--with-transcript
   (ghost--event
    (ghost-test--snapshot
     (ghost-test--entry :id 1 :kind "user" :text "One" :askId "a")
     (ghost-test--entry :id 2 :kind "assistant" :text "Two\nlines"
                        :toolCalls [])))
   (with-current-buffer "*ghost*"
     (goto-char (point-min))
     (ghost-next-turn)
     (should (looking-at ".* ghost › Two"))
     (should-error (ghost-next-turn) :type 'user-error)
     (ghost-previous-turn)
     (should (looking-at ".* you › One")))))

(ert-deftest ghost-test-makes-buttons-of-paths-and-task-ids ()
  (let* ((root (make-temp-file "ghost-root" t))
         (ghost-root root))
    (unwind-protect
        (ghost-test--with-transcript
         (make-directory (expand-file-name "system" root))
         (write-region "" nil (expand-file-name "system/core.md" root))
         (ghost--event
          (ghost-test--snapshot
           (ghost-test--entry
            :id 1 :kind "assistant" :toolCalls []
            :text "See /system/core.md:3, not /missing.md, and 20261020T151948.")))
         (with-current-buffer "*ghost*"
           (goto-char (point-min))
           (search-forward "/system")
           (let ((button (button-at (point))))
             (should button)
             (should (equal (button-label button) "/system/core.md:3"))
             (should (equal (button-get button 'ghost-file)
                            (expand-file-name "system/core.md" root)))
             (should (equal (button-get button 'ghost-line) 3)))
           (search-forward "/missing")
           (should-not (button-at (point)))
           (search-forward "20261020")
           (should (equal (button-get (button-at (point)) 'ghost-task)
                          "20261020T151948"))))
      (delete-directory root t))))

(ert-deftest ghost-test-draws-an-answer-from-its-html ()
  (ghost-test--with-transcript
   (ghost--event
    (ghost-test--snapshot
     (ghost-test--entry
      :id 1 :kind "assistant" :toolCalls [] :text "# Plan…"
      :html (concat "<h1>Plan</h1>\n"
                    "<p>Use <strong>bold</strong> and "
                    "<a href=\"https://example.com/a\">docs</a>.</p>\n"
                    "<table><thead><tr><th>Name</th><th>Size</th></tr></thead>"
                    "<tbody><tr><td>a</td><td>10</td></tr></tbody></table>\n"
                    "<pre><code class=\"language-emacs-lisp\">(defun f () 1)\n"
                    "</code></pre>"))))
   (should (equal ghost--last-answer "# Plan…"))
   (let ((text (ghost-test--text)))
     (should (string-match-p "ghost › \nPlan\n" text))
     (should (string-match-p "Use bold and docs\\." text))
     (should (string-match-p "Name +Size" text))
     (should (string-match-p "^(defun f () 1)\n\\'" text))
     (should-not (string-match-p "[<*#]" (substring text (string-search "\n" text)))))
   (with-current-buffer "*ghost*"
     (goto-char (point-min))
     (search-forward "Use")
     ;; The default font, as the rest of the transcript, not shr's own.
     (should-not (get-text-property (point) 'face))
     (search-forward "doc")
     (should (equal (get-text-property (point) 'shr-url) "https://example.com/a"))
     (search-forward "defun")
     (should (memq 'font-lock-keyword-face
                   (ensure-list (get-text-property (1- (point)) 'face)))))))

(ert-deftest ghost-test-fits-tables-to-the-window-and-leaves-prose-unfilled ()
  (ghost-test--with-transcript
   (with-current-buffer (ghost--buffer)
     (let* ((prose (concat "A paragraph that stays on one line at any width, "
                           "for visual-line-mode to wrap."))
            (html (concat "<p>" prose "</p>"
                          "<table><tr><td>aaaa aaaa aaaa aaaa</td>"
                          "<td>bbbb bbbb bbbb bbbb</td></tr></table>"))
            (ghost-window-size 30)
            (narrow (ghost--shr html))
            (wide (let ((ghost-window-size 100)) (ghost--shr html))))
       ;; Hidden, `*ghost*' draws for the sidebar it will show in.
       (should (= (ghost--shr-width) 28))
       (should (string-prefix-p (concat prose "\n") narrow))
       (should (string-match-p "aaaa aaaa  bbbb bbbb" wide))
       (should-not (string-match-p "aaaa aaaa aaaa aaaa" narrow))
       (should (> (length (split-string narrow "\n")) 3))))))

(ert-deftest ghost-test-draws-a-table-in-place-while-the-transcript-shows ()
  (ghost-test--with-transcript
   (ghost--show)
   (let ((window (get-buffer-window "*ghost*")))
     ;; A snapshot leaves the window's point at the start; shr lays table
     ;; cells out in the selected window, which is another.
     (ghost--event
      (ghost-test--snapshot
       (ghost-test--entry :id 1 :kind "user" :text "Compare" :askId "a")
       (ghost-test--entry :id 2 :kind "assistant" :toolCalls [] :text "| a |"
                          :html "<table><tr><td>cell</td></tr></table>")))
     (should (string-match-p "\\`[0-9:]+ you › Compare\n[0-9:]+ ghost › \n *cell"
                             (ghost-test--text)))
     (delete-window window))))

(ert-deftest ghost-test-shows-the-transcript-on-its-side ()
  (ghost-test--with-transcript
   (let ((ghost-window-side 'right))
     (ghost--show)
     (let ((window (get-buffer-window "*ghost*")))
       (should (eq (window-parameter window 'window-side) 'right))
       (should (window-parameter window 'no-delete-other-windows))
       (delete-other-windows (frame-first-window))
       (should (window-live-p window))
       (delete-window window)))
   (let ((ghost-window-side 'bottom))
     (ghost--show)
     (let ((window (get-buffer-window "*ghost*")))
       (should (eq (window-parameter window 'window-side) 'bottom))
       (delete-window window)))))

(ert-deftest ghost-test-draws-code-only-in-a-mode-auto-mode-alist-names ()
  (should (eq (ghost--lang-mode "Python") 'python-mode))
  (should (eq (ghost--lang-mode "sh") 'sh-mode))
  ;; A fence naming a global minor mode draws plain code and leaves it off.
  (should-not (ghost--lang-mode "global-auto-revert"))
  (should (equal (ghost--shr (concat "<pre><code class=\"language-global-auto-revert\">"
                                     "x\n</code></pre>"))
                 "x"))
  (should-not (bound-and-true-p global-auto-revert-mode)))

(ert-deftest ghost-test-draws-an-image-as-its-alt-text ()
  (cl-letf (((symbol-function 'url-queue-retrieve)
             (lambda (&rest _) (ert-fail "fetched the image"))))
    (should (equal (ghost--shr
                    "<p><img src=\"https://example.com/a.png\" alt=\"photo\"></p>")
                   "photo"))))

(ert-deftest ghost-test-keeps-a-paragraph-answer-on-its-label-line ()
  (ghost-test--with-transcript
   (ghost--event
    (ghost-test--snapshot
     (ghost-test--entry :id 1 :kind "assistant" :toolCalls [] :text "*Done*."
                        :html "<p><em>Done</em>.</p>\n")))
   (should (string-match-p "ghost › Done\\.\n\\'" (ghost-test--text)))))

(ert-deftest ghost-test-marks-an-answer-that-arrives-hidden ()
  (ghost-test--with-transcript
   (let* ((notified nil)
          (ghost-notify-functions (list (lambda (entry) (push entry notified)))))
     (ghost--event (ghost-test--snapshot))
     (ghost--event `((type . "entry")
                     (entry . ,(ghost-test--entry :id 1 :kind "assistant"
                                                  :text "" :toolCalls []))))
     (should-not ghost--unseen)
     (ghost--event `((type . "entry")
                     (entry . ,(ghost-test--entry :id 2 :kind "assistant"
                                                  :text "Here." :toolCalls []))))
     (should ghost--unseen)
     (should (equal (alist-get 'text (car notified)) "Here."))
     (let ((ghost--watch t))
       (should (string-match-p "●" (ghost--lighter))))
     (ghost--seen)
     (should-not ghost--unseen))))

(ert-deftest ghost-test-shows-the-status-in-the-header-line ()
  (let ((ghost--status '((busy . t) (queued . 2)
                         (consolidation (from . "2026-10-20") (running)))))
    (should (equal (ghost--header-line)
                   "busy · 2 queued · notes since 2026-10-20 to consolidate"))
    (should (equal (ghost--prompt nil 'ask) "Ask ghost (busy: it will queue): "))
    (should (equal (ghost--prompt "/a.md:1-2" 'steer)
                   "Steer ghost about /a.md:1-2: "))))

(ert-deftest ghost-test-carries-the-region-with-its-volume-path ()
  (let* ((root (make-temp-file "ghost-root" t))
         (ghost-root root)
         (file (expand-file-name "code/x.ts" root)))
    (unwind-protect
        (progn
          (make-directory (file-name-directory file))
          (write-region "one\ntwo ```\nthree\nfour\n" nil file)
          (with-current-buffer (find-file-noselect file)
            (goto-char (point-min))
            (forward-line 1)
            (set-mark (point))
            (forward-line 2)
            (activate-mark)
            (let ((context (ghost--region-context)))
              (should (equal (car context) "/code/x.ts:2-3"))
              (should (equal (cdr context)
                             (concat "From /code/x.ts, lines 2-3:\n\n"
                                     "````ts\ntwo ```\nthree\n````\n"))))
            (kill-buffer)))
      (delete-directory root t))))

(ert-deftest ghost-test-counts-region-lines-from-the-top-of-a-narrowed-file ()
  (with-temp-buffer
    (insert "one\ntwo\nthree\nfour\n")
    (narrow-to-region (line-beginning-position -1) (point-max))
    (set-mark (point-min))
    (goto-char (point-max))
    (activate-mark)
    (should (string-match-p ", lines 3-4:" (cdr (ghost--region-context))))))

(ert-deftest ghost-test-names-a-file-outside-the-volume ()
  (let ((ghost-root (make-temp-file "ghost-root" t))
        (file (make-temp-file "ghost-outside" nil ".el" "(one)\n")))
    (unwind-protect
        (with-current-buffer (find-file-noselect file)
          (set-mark (point-min))
          (goto-char (point-max))
          (activate-mark)
          (should (string-match-p
                   "\\`From .*ghost-outside.*\\.el (on this machine, outside the Volume), line 1:"
                   (cdr (ghost--region-context))))
          (kill-buffer))
      (delete-file file)
      (delete-directory ghost-root t))))

(ert-deftest ghost-test-reads-every-line-of-a-chunk-that-makes-buttons ()
  (let* ((root (make-temp-file "ghost-root" t))
         (ghost-root root)
         (proc (make-pipe-process :name "ghost-test" :noquery t)))
    (unwind-protect
        (ghost-test--with-transcript
         (write-region "" nil (expand-file-name "core.md" root))
         (ghost--lines
          proc
          (concat "{\"type\":\"snapshot\",\"transcript\":{\"entries\":[]},"
                  "\"status\":{\"busy\":false,\"queued\":0}}\n"
                  "{\"type\":\"entry\",\"entry\":{\"id\":1,\"kind\":\"user\","
                  "\"text\":\"See /core.md and 20261020T151948\",\"askId\":\"a\"}}\n"
                  "{\"type\":\"entry\",\"entry\":{\"id\":2,\"kind\":\"assistant\","
                  "\"text\":\"Seen.\",\"toolCalls\":[]}}\n{\"type\":")
          (lambda (line) (ghost--watch-line proc line)))
         (should (string-match-p
                  "\\`[0-9:]+ you › See /core.md and 20261020T151948\n[0-9:]+ ghost › Seen\\.\n\\'"
                  (ghost-test--text)))
         (should-not (process-get proc 'ghost-stderr))
         (should (equal (process-get proc 'ghost-pending) "{\"type\":")))
      (delete-process proc)
      (delete-directory root t))))

(ert-deftest ghost-test-reads-on-past-a-line-that-fails ()
  (let ((proc (make-pipe-process :name "ghost-test" :noquery t))
        (debug-on-error nil)
        (inhibit-message t)
        (read nil))
    (unwind-protect
        (let ((fn (lambda (line)
                    (when (equal line "bad") (error "Bad line"))
                    (push line read))))
          (ghost--lines proc "bad\nok\n{\"a\"" fn)
          (ghost--lines proc ":1}\n" fn)
          (should (equal (reverse read) '("ok" "{\"a\":1}")))
          (should (equal (process-get proc 'ghost-pending) "")))
      (delete-process proc))))

(defun ghost-test--program (dir)
  "Write a fake `ghost' into DIR that logs its arguments and cwd per command."
  (let ((program (expand-file-name "ghost" dir)))
    (write-region
     (concat "#!/bin/sh\n"
             "printf '%s\\n' \"$(pwd -P)\" \"$@\" > \"$(dirname \"$0\")/$1.args\"\n"
             "echo '{\"type\":\"snapshot\",\"transcript\":{\"entries\":[]},"
             "\"status\":{\"busy\":true,\"queued\":0}}'\n"
             "echo 'ghost: a line on stderr' >&2\n"
             "echo '{\"type\":\"settled\",\"id\":\"x\",\"status\":\"done\","
             "\"text\":\"the answer\"}'\n"
             "[ \"$1\" = quick ] && echo '{\"type\":\"quick\","
             "\"text\":\"the quick answer\"}'\n"
             "[ \"$1\" = watch ] && exec sleep 30\n")
     nil program)
    (set-file-modes program #o755)
    program))

(ert-deftest ghost-test-asks-from-the-directory-and-inserts-the-answer ()
  (let* ((dir (file-name-as-directory (make-temp-file "ghost-bin" t)))
         (ghost-program (ghost-test--program dir))
         (ghost-root dir))
    (unwind-protect
        (ghost-test--with-transcript
         (with-temp-buffer
           (insert "before:")
           (let ((marker (point-marker)))
             (ghost--ask "-not an option" dir
                         (lambda (text) (ghost--insert-answer marker text)))
             (should (= ghost--asks 1))
             ;; The watch may have ended while the ask was written.
             (should (process-live-p ghost--watch))
             (while (> ghost--asks 0) (accept-process-output nil 0.05))
             (should (equal (buffer-string) "before:the answer"))))
         (should (equal (with-temp-buffer
                          (insert-file-contents (expand-file-name "ask.args" dir))
                          (split-string (buffer-string) "\n" t))
                        (list (directory-file-name (file-truename dir))
                              "ask" "--json" "--" "-not an option"))))
      (delete-directory dir t))))

(defun ghost-test--args (dir command)
  "The arguments the fake `ghost' in DIR logged for COMMAND, one per line."
  (with-temp-buffer
    (insert-file-contents (expand-file-name (concat command ".args") dir))
    (goto-char (point-min))
    (forward-line 1)
    (string-trim-right (buffer-substring (point) (point-max)) "\n")))

(ert-deftest ghost-test-defines-a-command-that-asks-quick-or-the-ghost ()
  (let* ((dir (file-name-as-directory (make-temp-file "ghost-bin" t)))
         (ghost-program (ghost-test--program dir))
         (ghost-root dir)
         (ghost-quick-effort "low")
         (transient-mark-mode t)
         (messages nil))
    (ghost-define-command ghost-test-explain "Explain it." :model "mini")
    (unwind-protect
        (ghost-test--with-transcript
         (cl-letf (((symbol-function 'message)
                    (lambda (format &rest args)
                      (push (apply #'format-message format args) messages)))
                   ((symbol-function 'read-string)
                    (lambda (_prompt &optional _initial _history default)
                      default)))
           (should (string-match-p "Ask the model: Explain it\\."
                                   (documentation 'ghost-test-explain)))
           (with-temp-buffer
             (setq default-directory dir)
             (insert " an apple ")
             (set-mark (point-min))
             (ghost-test-explain)
             (with-timeout (5 (ert-fail "no quick answer"))
               (while (not (member "the quick answer" messages))
                 (accept-process-output nil 0.05)))
             (should (equal (ghost-test--args dir "quick")
                            (concat "quick\n--json\n--system\nExplain it.\n"
                                    "--model\nmini\n--effort\nlow\n--html\n--\nan apple")))
             ;; Without a region, the symbol at point is the default.
             (deactivate-mark)
             (goto-char 4)
             (ghost-test-explain t)
             (while (> ghost--asks 0) (accept-process-output nil 0.05))
             (should (equal (ghost-test--args dir "ask")
                            "ask\n--json\n--\nExplain it.\n\nan")))))
      (fmakunbound 'ghost-test-explain)
      (when (get-buffer "*ghost quick*") (kill-buffer "*ghost quick*"))
      (delete-directory dir t))))

(ert-deftest ghost-test-logs-quick-answers-and-shows-long-ones ()
  (let ((messages nil) (ghost--quick-answer nil) (kill-ring nil))
    (when (get-buffer "*ghost quick*") (kill-buffer "*ghost quick*"))
    (unwind-protect
        (cl-letf (((symbol-function 'message)
                   (lambda (format &rest args)
                     (push (apply #'format-message format args) messages))))
          (ghost--quick-answer "apple" "A *fruit*." "<p>A <em>fruit</em>.</p>")
          (should (member "A fruit." messages))
          (should-not (get-buffer-window "*ghost quick*" t))
          (ghost-quick-copy)
          (should (equal (current-kill 0) "A *fruit*."))
          ;; A long answer shows the log at its entry instead.
          (let ((long (mapconcat #'number-to-string (number-sequence 1 80) "\n")))
            (ghost--quick-answer "count" long)
            (should-not (member long messages))
            (let ((window (get-buffer-window "*ghost quick*" t)))
              (should window)
              (should (= (window-start window) ghost--quick-entry))
              (with-current-buffer "*ghost quick*"
                (should (eq major-mode 'ghost-quick-mode))
                (should (string-match-p
                         "\\`[0-9:]+ you › apple\n[0-9:]+ ghost › A fruit\\.\n\n[0-9:]+ you › count\n[0-9:]+ ghost › 1\n2\n"
                         (buffer-string)))
                (should (= ghost--quick-entry
                           (save-excursion (goto-char (point-max))
                                           (search-backward "you › count")
                                           (line-beginning-position)))))))
          (ghost-quick-show)
          (should-not (get-buffer-window "*ghost quick*" t)))
      (when (get-buffer "*ghost quick*") (kill-buffer "*ghost quick*")))))

(ert-deftest ghost-test-ends-the-watch-when-idle-and-hidden ()
  (let* ((dir (file-name-as-directory (make-temp-file "ghost-bin" t)))
         (ghost-root dir)
         (ghost-program (expand-file-name "ghost" dir)))
    (write-region (concat "#!/bin/sh\n"
                          "echo '{\"type\":\"snapshot\","
                          "\"transcript\":{\"entries\":[]},"
                          "\"status\":{\"busy\":false,\"queued\":0}}'\n"
                          "exec sleep 30\n")
                  nil ghost-program)
    (set-file-modes ghost-program #o755)
    (unwind-protect
        (ghost-test--with-transcript
         (ghost--ensure-watch)
         (should ghost--idle-timer)
         (while (not ghost--status) (accept-process-output ghost--watch 0.05))
         (should (equal (ghost--header-line) "idle"))
         (let ((watch ghost--watch))
           (setq ghost--status '((busy . t)))
           (ghost--idle)
           (should (process-live-p watch))
           (should ghost--idle-timer)
           (setq ghost--status '((busy)))
           (ghost--idle)
           (should-not (process-live-p watch))
           (should-not ghost--watch)
           (should (equal (ghost--header-line) "not watching")))
         (when ghost--idle-timer (cancel-timer ghost--idle-timer)))
      (delete-directory dir t))))

(provide 'ghost-test)
;;; ghost-test.el ends here
