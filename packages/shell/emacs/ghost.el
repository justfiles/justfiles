;;; ghost.el --- Talk to the ghost from Emacs -*- lexical-binding: t; -*-

;; Package-Requires: ((emacs "29.1"))
;; Keywords: tools

;;; Commentary:

;; A thin wrapper over the `ghost' CLI.  Every ask is a `ghost ask --json'
;; process run from `default-directory', and `*ghost*' is drawn from one
;; `ghost watch --json'.  Starting the daemon, retrying a lost connection and
;; mapping the cwd to the Volume are the CLI's.
;;
;; There is one conversation per shell, shared with the CLI, so the buffer is
;; a view and the minibuffer is the input:
;;
;;   `ghost-ask'          ask from any buffer; with an active region, the ask
;;                        carries it.  With C-u, compose it in a buffer.
;;   `ghost-ask-insert'   the same, with the answer inserted at point.
;;   `ghost-steer'        send to the turn in progress instead of queueing.
;;   `ghost-abort'        stop the turn in progress.
;;   `ghost-new'          start a new session with a handoff.
;;   `ghost-transcript'   show or hide `*ghost*'.

;;; Code:

(require 'iso8601)
(require 'seq)
(require 'subr-x)

(defgroup ghost nil
  "The ghost, through its CLI."
  :group 'tools
  :prefix "ghost-")

(defcustom ghost-program "ghost"
  "The `ghost' program."
  :type 'string)

(defcustom ghost-ws-program "ws"
  "The `ws' program, whose `ws path' turns a task id into its file."
  :type 'string)

(defcustom ghost-root "~/files"
  "The root of the ghost's Volume on disk, which Volume paths are under."
  :type 'directory)

(defcustom ghost-watch-idle-time 300
  "Seconds `*ghost*' stays hidden and quiet before Emacs ends its watch.
The watch is a client and keeps the daemon up; once it ends, the daemon
exits after its own idle period, and the next ask starts both again."
  :type 'number)

(defcustom ghost-window-height 0.3
  "Height of the `*ghost*' side window."
  :type 'number)

(defcustom ghost-notify-functions nil
  "Functions called with an answer that arrived while `*ghost*' was hidden.
Each gets the transcript entry as an alist, with `text' holding the
answer; use it for a system notification."
  :type 'hook)

(defface ghost-time '((t :inherit shadow))
  "The time of a transcript entry.")

(defface ghost-you '((t :inherit font-lock-keyword-face :weight bold))
  "The `you ›' label.")

(defface ghost-label '((t :inherit font-lock-function-name-face :weight bold))
  "The `ghost ›' label.")

(defface ghost-mark '((t :inherit warning))
  "The mark on an entry that is not an answer to an ask.")

(defface ghost-call '((t :inherit shadow))
  "A folded tool call.")

(defface ghost-error '((t :inherit error))
  "A failed answer or tool call.")

(defface ghost-rule '((t :inherit shadow :strike-through t))
  "The rule where the session changed.")

(defface ghost-busy '((t :inherit warning))
  "The mode-line lighter while the ghost is busy.")

(defface ghost-unseen '((t :inherit success :weight bold))
  "The mode-line lighter when an answer arrived while `*ghost*' was hidden.")

(defvar ghost-history nil
  "Asks read in the minibuffer.")

(defvar ghost--watch nil
  "The `ghost watch --json' process.")

(defvar ghost--status nil
  "The latest status from the watch, an alist; nil without a watch.")

(defvar ghost--unseen nil
  "Non-nil when an answer arrived while `*ghost*' was hidden.")

(defvar ghost--idle-timer nil
  "Ends the watch once `*ghost*' was hidden for `ghost-watch-idle-time'.")

(defvar ghost--asks 0
  "How many `ghost ask' processes are running.")

(defvar ghost--partial nil
  "In `*ghost*', where the answer being written starts; nil when none is.")

(defvar ghost--calls (make-hash-table :test #'equal)
  "In `*ghost*', the overlay of each shown tool call's body, by call id.")

(defvar ghost--answering nil
  "Non-nil while the entries coming in answer an ask.")

(defvar ghost--last-answer nil
  "The text of the newest answer, for `ghost-copy-answer'.")

;;;; Asking

;;;###autoload
(defun ghost-ask (&optional compose)
  "Ask the ghost a line read in the minibuffer, from `default-directory'.
With an active region, the ask carries it under its file's Volume path
and lines.  With COMPOSE, write the ask in a buffer instead."
  (interactive "P")
  (ghost--start compose 'ask))

;;;###autoload
(defun ghost-ask-insert (&optional compose)
  "Ask as `ghost-ask' does, and insert the answer at point.
With COMPOSE, write the ask in a buffer instead."
  (interactive "P")
  (ghost--start compose (point-marker)))

;;;###autoload
(defun ghost-steer (&optional compose)
  "Ask as `ghost-ask' does, steering the turn in progress, not queueing.
With COMPOSE, write the ask in a buffer instead."
  (interactive "P")
  (ghost--start compose 'steer))

;;;###autoload
(defun ghost-abort ()
  "Stop the turn in progress."
  (interactive)
  (ghost--run '("abort") "aborted"))

;;;###autoload
(defun ghost-new (handoff)
  "Start a new session that opens with HANDOFF; empty lets the ghost write it."
  (interactive (list (read-string "Handoff (empty: the ghost writes it): ")))
  (ghost--run (if (string-blank-p handoff)
                  '("new")
                (list "new" (concat "--handoff=" handoff)))
              "new session"))

(defun ghost--start (compose how)
  "Read an ask, in a compose buffer when COMPOSE, and send it as HOW says.
HOW is `ask', `steer', or a marker to insert the answer at."
  (let ((context (and (use-region-p) (ghost--region-context)))
        (dir default-directory))
    (deactivate-mark)
    (ghost--ensure-watch)
    (if compose
        (ghost--compose (cdr context) dir how)
      (let ((text (read-string (ghost--prompt (car context) how)
                               nil 'ghost-history)))
        (when (string-blank-p text) (user-error "Nothing to ask"))
        (ghost--ask (ghost--join text (cdr context)) dir how)))))

(defun ghost--prompt (label how)
  "The minibuffer prompt for an ask sent as HOW, about LABEL when non-nil."
  (concat (if (eq how 'steer) "Steer ghost" "Ask ghost")
          (when (and (not (eq how 'steer))
                     (or (alist-get 'busy ghost--status)
                         (> (or (alist-get 'queued ghost--status) 0) 0)))
            " (busy: it will queue)")
          (when label (format " about %s" label))
          ": "))

(defun ghost--join (text context)
  "TEXT, followed by CONTEXT when there is one."
  (if context (concat (string-trim-right text) "\n\n" context) text))

(defun ghost--region-context ()
  "The active region as (LABEL . TEXT): a header line and a fenced block."
  (let* ((beg (region-beginning))
         (end (region-end))
         (file (buffer-file-name))
         (path (and file (ghost--volume-path file)))
         (name (cond (path path)
                     (file (abbreviate-file-name file))
                     (t (buffer-name))))
         (where (cond (path path)
                      (file (format "%s (on this machine, outside the Volume)"
                                    name))
                      (t (format "the buffer %s" name))))
         ;; Lines of the file, also in a narrowed buffer.
         (first (line-number-at-pos beg t))
         ;; A region that ends at the start of a line ends on the line before.
         (last (line-number-at-pos
                (if (and (> end beg)
                         (save-excursion (goto-char end) (bolp)))
                    (1- end)
                  end)
                t))
         (lines (if (= first last)
                    (format "line %d" first)
                  (format "lines %d-%d" first last)))
         (text (string-trim-right (buffer-substring-no-properties beg end)
                                  "\n"))
         (fence (ghost--fence text))
         (lang (or (and file (file-name-extension file)) "")))
    (cons (format "%s:%d-%d" name first last)
          (format "From %s, %s:\n\n%s%s\n%s\n%s\n"
                  where lines fence lang text fence))))

(defun ghost--fence (text)
  "A code fence longer than any run of backticks in TEXT."
  (let ((longest 2) (start 0))
    (while (string-match "`+" text start)
      (setq longest (max longest (- (match-end 0) (match-beginning 0)))
            start (match-end 0)))
    (make-string (1+ longest) ?`)))

(defun ghost--volume-path (file)
  "FILE as a Volume path, or nil when it is outside `ghost-root'."
  (let ((root (file-name-as-directory (file-truename ghost-root)))
        (true (file-truename file)))
    (cond ((equal (file-name-as-directory true) root) "/")
          ((string-prefix-p root true)
           (concat "/" (substring true (length root)))))))

(defun ghost--ask (text dir how)
  "Send TEXT from DIR as HOW says; see `ghost--start'.
Only the answer's `settled' and errors are read here: `*ghost*' draws the
rest from the watch, which may have ended while the ask was written."
  (ghost--ensure-watch)
  (unless (markerp how) (ghost--show))
  (let ((default-directory (ghost--local-dir dir)))
    (make-process
     :name "ghost-ask"
     :command `(,ghost-program "ask" "--json"
                               ,@(and (eq how 'steer) '("--steer"))
                               "--" ,text)
     :connection-type 'pipe
     :coding 'utf-8
     :noquery t
     :filter (lambda (proc chunk)
               (ghost--lines proc chunk
                             (lambda (line) (ghost--ask-line proc line how))))
     :sentinel #'ghost--ask-ended))
  (setq ghost--asks (1+ ghost--asks)))

(defun ghost--ask-ended (proc _event)
  "Count the ask PROC out, and say why it failed when nothing else did."
  (unless (process-live-p proc)
    (setq ghost--asks (max 0 (1- ghost--asks)))
    (ghost--arm-idle)
    (unless (or (process-get proc 'ghost-settled)
                (zerop (process-exit-status proc)))
      (message "ghost: %s"
               (or (process-get proc 'ghost-stderr) "the ask failed")))))

(defun ghost--ask-line (proc line how)
  "Handle one LINE of the ask PROC, sent as HOW."
  (cond
   ((string-prefix-p "{\"type\":\"settled\"" line)
    (process-put proc 'ghost-settled t)
    (let ((settled (ghost--parse line)))
      (if (equal (alist-get 'status settled) "done")
          (when (markerp how)
            (ghost--insert-answer how (alist-get 'text settled)))
        (let-alist (alist-get 'failure settled)
          (message "ghost: %s: %s%s" .kind .message
                   (if (equal .kind "auth")
                       "; sign in with `ghost login'"
                     ""))))))
   ((string-prefix-p "{\"type\":\"error\"" line)
    (process-put proc 'ghost-settled t)
    (message "ghost: %s" (alist-get 'message (ghost--parse line))))
   ((not (string-prefix-p "{" line))
    (process-put proc 'ghost-stderr (string-remove-prefix "ghost: " line)))))

(defun ghost--insert-answer (marker text)
  "Insert TEXT at MARKER, in its buffer."
  (when (buffer-live-p (marker-buffer marker))
    (with-current-buffer (marker-buffer marker)
      (save-excursion
        (goto-char marker)
        (insert text)))))

(defun ghost--local-dir (dir)
  "DIR when it is a local directory, else `ghost-root'."
  (if (and dir (not (file-remote-p dir)) (file-directory-p dir))
      dir
    (file-name-as-directory (expand-file-name ghost-root))))

(defun ghost--run (args done)
  "Run the CLI with ARGS, and say DONE when it succeeds."
  (let ((buffer (generate-new-buffer " *ghost-run*")))
    (make-process
     :name "ghost" :buffer buffer :command (cons ghost-program args)
     :connection-type 'pipe :coding 'utf-8 :noquery t
     :sentinel (lambda (proc _event)
                 (unless (process-live-p proc)
                   (let ((out (with-current-buffer buffer
                                (string-trim (buffer-string)))))
                     (kill-buffer buffer)
                     (message "%s" (if (zerop (process-exit-status proc))
                                       (concat "ghost: " done)
                                     out))))))))

(defun ghost--lines (proc chunk fn)
  "Call FN on each whole line PROC wrote, CHUNK being the newest part."
  (let ((pending (concat (process-get proc 'ghost-pending) chunk))
        (start 0))
    ;; FN may search, which changes the match data.
    (while-let ((end (string-search "\n" pending start)))
      (funcall fn (substring pending start end))
      (setq start (1+ end)))
    (process-put proc 'ghost-pending (substring pending start))))

(defun ghost--parse (line)
  "LINE as JSON: objects as alists, arrays as vectors, false and null nil."
  (json-parse-string line :object-type 'alist :array-type 'array
                     :null-object nil :false-object nil))

;;;; Composing

(defvar-local ghost--compose-args nil
  "In a compose buffer, the directory it asks from and how it sends.")

(defvar-keymap ghost-compose-mode-map
  "C-c C-c" #'ghost-compose-send
  "C-c C-k" #'ghost-compose-cancel)

(define-minor-mode ghost-compose-mode
  "Writing an ask for the ghost.
\\[ghost-compose-send] sends it, \\[ghost-compose-cancel] throws it away."
  :lighter " Ghost-Compose")

(defun ghost--compose (context dir how)
  "Open a buffer to write an ask in, with CONTEXT, sent from DIR as HOW says."
  (let ((buffer (generate-new-buffer "*ghost compose*")))
    (with-current-buffer buffer
      (if (fboundp 'markdown-mode) (markdown-mode) (text-mode))
      (ghost-compose-mode)
      (setq ghost--compose-args (list dir how))
      (setq header-line-format
            (substitute-command-keys
             (concat (if (eq how 'steer) "Steer the ghost" "Ask the ghost")
                     ": \\[ghost-compose-send] sends, "
                     "\\[ghost-compose-cancel] cancels")))
      (when context
        (insert "\n\n" context)
        (goto-char (point-min))))
    (pop-to-buffer buffer)))

(defun ghost-compose-send ()
  "Send the ask in this buffer."
  (interactive)
  (let ((text (string-trim (buffer-string)))
        (args ghost--compose-args))
    (when (string-empty-p text) (user-error "Nothing to ask"))
    (quit-window t)
    (ghost--ask text (nth 0 args) (nth 1 args))))

(defun ghost-compose-cancel ()
  "Throw away the ask in this buffer."
  (interactive)
  (quit-window t))

;;;; The watch

(defvar ghost-mode-line '(:eval (ghost--lighter))
  "The ghost's part of the mode line: idle, busy, or an unseen answer.")
(put 'ghost-mode-line 'risky-local-variable t)

(defun ghost--ensure-watch ()
  "Start the watch unless it runs."
  (unless (process-live-p ghost--watch)
    (unless (listp global-mode-string)
      (setq global-mode-string (list global-mode-string)))
    (add-to-list 'global-mode-string 'ghost-mode-line t)
    (add-hook 'window-buffer-change-functions #'ghost--windows-changed)
    (ghost--buffer)
    (setq ghost--watch
          (let ((default-directory (ghost--local-dir nil)))
            (make-process
             :name "ghost-watch"
             :command (list ghost-program "watch" "--json")
             :connection-type 'pipe
             :coding 'utf-8
             :noquery t
             :filter (lambda (proc chunk)
                       (ghost--lines proc chunk
                                     (lambda (line)
                                       (ghost--watch-line proc line))))
             :sentinel #'ghost--watch-ended)))
    (ghost--arm-idle)))

(defun ghost--stop-watch ()
  "End the watch, which lets the daemon go idle."
  (when (process-live-p ghost--watch)
    (process-put ghost--watch 'ghost-stopping t)
    (delete-process ghost--watch))
  (setq ghost--watch nil ghost--status nil)
  (force-mode-line-update t))

(defun ghost--watch-line (proc line)
  "Handle one LINE of the watch PROC."
  (if (not (string-prefix-p "{" line))
      (process-put proc 'ghost-stderr (string-remove-prefix "ghost: " line))
    (process-put proc 'ghost-connected t)
    (ghost--event (ghost--parse line))))

(defun ghost--watch-ended (proc _event)
  "Start the watch PROC again when it lost a daemon it was connected to."
  (unless (or (process-live-p proc) (process-get proc 'ghost-stopping))
    (when (eq proc ghost--watch)
      (setq ghost--watch nil ghost--status nil)
      (force-mode-line-update t))
    (if (process-get proc 'ghost-connected)
        ;; The daemon went away, killed or restarting after a login; the CLI
        ;; starts the next one.
        (run-at-time 1 nil #'ghost--ensure-watch)
      (message "ghost watch: %s"
               (or (process-get proc 'ghost-stderr) "exited")))))

(defun ghost--visible-p ()
  "Non-nil when `*ghost*' is shown in some window."
  (let ((buffer (get-buffer "*ghost*")))
    (and buffer (get-buffer-window buffer t))))

(defun ghost--windows-changed (_frame)
  "Clear the unseen mark when `*ghost*' shows; count idle time when hidden."
  (if (ghost--visible-p)
      (ghost--seen)
    (unless ghost--idle-timer (ghost--arm-idle))))

(defun ghost--seen ()
  "Clear the unseen mark, and stop counting idle time."
  (when ghost--unseen
    (setq ghost--unseen nil)
    (force-mode-line-update t))
  (when ghost--idle-timer
    (cancel-timer ghost--idle-timer)
    (setq ghost--idle-timer nil)))

(defun ghost--arm-idle ()
  "Count `ghost-watch-idle-time' from now, while `*ghost*' is hidden."
  (when ghost--idle-timer (cancel-timer ghost--idle-timer))
  (setq ghost--idle-timer
        (and (process-live-p ghost--watch)
             (not (ghost--visible-p))
             (run-at-time ghost-watch-idle-time nil #'ghost--idle))))

(defun ghost--idle ()
  "End the watch unless `*ghost*' shows or something is going on."
  (setq ghost--idle-timer nil)
  (cond ((ghost--visible-p))
        ((or (> ghost--asks 0) (alist-get 'busy ghost--status))
         (ghost--arm-idle))
        (t (ghost--stop-watch))))

(defun ghost--lighter ()
  "The mode-line lighter: idle, busy, or an unseen answer."
  (when (or ghost--watch ghost--unseen)
    (let ((busy (alist-get 'busy ghost--status)))
      (propertize (cond (ghost--unseen " ghost●")
                        (busy " ghost…")
                        (t " ghost"))
                  'face (cond (ghost--unseen 'ghost-unseen) (busy 'ghost-busy))
                  'help-echo "mouse-1: show or hide *ghost*"
                  'mouse-face 'mode-line-highlight
                  'local-map (make-mode-line-mouse-map
                              'mouse-1 #'ghost-transcript)))))

;;;; The transcript

(defvar-keymap ghost-transcript-mode-map
  :parent special-mode-map
  "n" #'ghost-next-turn
  "p" #'ghost-previous-turn
  "y" #'ghost-copy-answer
  "RET" #'ghost-ask
  "TAB" #'ghost-toggle-call)

(define-derived-mode ghost-transcript-mode special-mode "Ghost"
  "The ghost's conversation, drawn from `ghost watch'.
\\{ghost-transcript-mode-map}"
  (setq-local header-line-format '(:eval (ghost--header-line)))
  (add-hook 'kill-buffer-hook #'ghost--killed nil t)
  (visual-line-mode 1))

(defun ghost--killed ()
  "Forget what `*ghost*' showed, and end the watch that drew it.
The next watch starts with a snapshot, which draws a new `*ghost*'."
  (ghost--stop-watch)
  (when ghost--partial (set-marker ghost--partial nil))
  (setq ghost--partial nil ghost--answering nil ghost--last-answer nil)
  (clrhash ghost--calls))

;;;###autoload
(defun ghost-transcript ()
  "Show `*ghost*' in a side window, or hide it when it shows."
  (interactive)
  (let ((windows (and (get-buffer "*ghost*")
                      (get-buffer-window-list "*ghost*" nil t))))
    (if (null windows)
        (progn (ghost--ensure-watch)
               (ghost--show))
      (dolist (window windows) (quit-window nil window))
      (ghost--arm-idle))))

(defun ghost--buffer ()
  "The `*ghost*' buffer, made when there is none."
  (or (get-buffer "*ghost*")
      (with-current-buffer (get-buffer-create "*ghost*")
        (ghost-transcript-mode)
        (setq default-directory (ghost--local-dir nil))
        (current-buffer))))

(defun ghost--show ()
  "Show `*ghost*' in the bottom side window, without selecting it."
  (let ((buffer (ghost--buffer)))
    (unless (get-buffer-window buffer t)
      (display-buffer buffer
                      `((display-buffer-reuse-window
                         display-buffer-in-side-window)
                        (side . bottom)
                        (window-height . ,ghost-window-height))))
    (ghost--seen)))

(defun ghost--header-line ()
  "The status snapshot, for the header line of `*ghost*'."
  (if (null ghost--status)
      "not watching"
    (let-alist ghost--status
      (string-join
       (delq nil
             (list (if .busy "busy" "idle")
                   (and .queued (> .queued 0) (format "%d queued" .queued))
                   (and .consolidation
                        (if .consolidation.running
                            "consolidating memory"
                          (format "notes since %s to consolidate"
                                  .consolidation.from)))))
       " · "))))

(defun ghost--event (event)
  "Apply one watch EVENT to `*ghost*' and the status."
  (let-alist event
    (pcase .type
      ("snapshot"
       (setq ghost--status .status)
       (ghost--render-snapshot .transcript))
      ("entry"
       (ghost--write (lambda () (ghost--entry .entry)))
       (ghost--arrived .entry))
      ("text" (ghost--write (lambda () (ghost--delta .delta))))
      ("status"
       (setq ghost--status .status)
       (unless (ghost--visible-p) (ghost--arm-idle)))
      ("error" (message "ghost: %s" .message))))
  (force-mode-line-update t))

(defun ghost--arrived (entry)
  "Mark ENTRY and pass it to `ghost-notify-functions' if it is a hidden answer."
  (unless (ghost--visible-p)
    (let-alist entry
      (when (and (equal .kind "assistant")
                 (or (not (string-empty-p .text)) .error))
        (setq ghost--unseen t)
        (run-hook-with-args 'ghost-notify-functions entry)))
    (ghost--arm-idle)))

(defun ghost--write (fn)
  "Call FN in `*ghost*', writable; windows that showed its end follow it."
  (with-current-buffer (ghost--buffer)
    (let* ((inhibit-read-only t)
           (end (point-max))
           (follow (= (point) end))
           (windows (seq-filter (lambda (window)
                                  (= (window-point window) end))
                                (get-buffer-window-list nil nil t))))
      (save-excursion (funcall fn))
      (when follow (goto-char (point-max)))
      (dolist (window windows) (set-window-point window (point-max))))))

(defun ghost--render-snapshot (transcript)
  "Draw TRANSCRIPT in `*ghost*', replacing what was there."
  (ghost--write
   (lambda ()
     (remove-overlays)
     (erase-buffer)
     (clrhash ghost--calls)
     (when ghost--partial (set-marker ghost--partial nil))
     (setq ghost--partial nil ghost--answering nil ghost--last-answer nil)
     (let-alist transcript
       (seq-do #'ghost--entry .entries)
       (when .partial (ghost--delta .partial))))))

(defun ghost--entry (entry)
  "Insert ENTRY where entries go: at the end, before an answer being written."
  (let-alist entry
    ;; An answer replaces the text it was written as.
    (when (and (equal .kind "assistant") ghost--partial)
      (delete-region ghost--partial (point-max))
      (set-marker ghost--partial nil)
      (setq ghost--partial nil))
    (goto-char (or ghost--partial (point-max)))
    (pcase .kind
      ("user"
       (unless (bobp) (insert "\n"))
       (ghost--label .at "you" (not .askId))
       (ghost--text .text)
       (setq ghost--answering (and .askId t)))
      ("assistant"
       (unless (string-empty-p .text)
         (ghost--label .at "ghost" (not ghost--answering))
         (ghost--text .text)
         (setq ghost--last-answer .text))
       (when .error
         (insert (propertize (format "  %s\n" .error) 'face 'ghost-error)))
       (seq-do #'ghost--call .toolCalls))
      ("tool" (ghost--result entry))
      ("reset"
       (ghost--rule "new session")
       (when (and .handoff (not (string-empty-p .handoff)))
         (insert (propertize (string-trim-right .handoff) 'face 'shadow) "\n"))
       (setq ghost--answering nil))
      ("compaction" (ghost--rule "compacted")))))

(defun ghost--delta (delta)
  "Add DELTA to the answer being written, starting one when none is."
  (goto-char (point-max))
  (unless ghost--partial
    (let ((start (point)))
      (ghost--label nil "ghost" (not ghost--answering))
      ;; Entries that come in meanwhile go before it: the marker moves past.
      (setq ghost--partial (copy-marker start t))))
  (insert delta))

(defun ghost--label (at who mark)
  "Insert the time AT and the label of WHO, with the MARK of an unasked entry."
  (insert (propertize
           (concat (propertize (ghost--time at) 'face 'ghost-time) " "
                   (if mark (propertize "◆ " 'face 'ghost-mark) "")
                   (propertize (concat who " ›")
                               'face (if (equal who "you")
                                         'ghost-you
                                       'ghost-label))
                   " ")
           'ghost-turn t)))

(defun ghost--time (at)
  "The ISO time AT as HH:MM; now when there is none."
  (format-time-string
   "%H:%M" (and at (ignore-errors (encode-time (iso8601-parse at))))))

(defun ghost--text (text)
  "Insert TEXT and a newline, with buttons on its paths and task ids."
  (let ((start (point)))
    (insert (string-trim-right text) "\n")
    (ghost--buttonize start (point))))

(defun ghost--rule (label)
  "Insert a rule with LABEL, where the conversation changed."
  (unless (bobp) (insert "\n"))
  (insert (propertize (format "  %s  " label) 'face 'ghost-rule) "\n"))

(defun ghost--call (call)
  "Insert the tool CALL as one line, its arguments folded under it."
  (let-alist call
    (let ((args (ghost--json .args)))
      (insert (propertize
               (format "  ▸ %s %s\n" .name
                       (truncate-string-to-width
                        (string-replace "\n" " " args) 100 nil nil "…"))
               'face 'ghost-call 'ghost-call .id))
      (let ((start (point)))
        (insert (ghost--indent args))
        (let ((overlay (make-overlay start (point))))
          (overlay-put overlay 'invisible t)
          (overlay-put overlay 'ghost-body t)
          (puthash .id overlay ghost--calls))))))

(defun ghost--result (entry)
  "Fold the result ENTRY under its call; show the call too when it is gone."
  (let-alist entry
    (unless (gethash .callId ghost--calls)
      (ghost--call `((id . ,.callId) (name . ,.name) (args . nil))))
    (let ((overlay (gethash .callId ghost--calls)))
      (save-excursion
        (goto-char (overlay-end overlay))
        (insert (propertize (if .isError "    failed:\n" "    result:\n")
                            'face (if .isError 'ghost-error 'ghost-call))
                (ghost--indent
                 (truncate-string-to-width .text 4000 nil nil "…")))
        (move-overlay overlay (overlay-start overlay) (point)))
      (when .isError
        (save-excursion
          (goto-char (overlay-start overlay))
          (forward-line -1)
          (add-face-text-property (point) (line-end-position)
                                  'ghost-error))))))

(defun ghost--json (value)
  "VALUE as one line of JSON."
  (if value (json-serialize value) "{}"))

(defun ghost--indent (text)
  "TEXT with each line indented, ending in a newline."
  (concat (replace-regexp-in-string "^" "      " (string-trim-right text))
          "\n"))

(defun ghost-toggle-call ()
  "Unfold the tool call at point, or fold it again."
  (interactive)
  (let ((overlay
         (or (gethash (get-text-property (line-beginning-position) 'ghost-call)
                      ghost--calls)
             (seq-find (lambda (overlay) (overlay-get overlay 'ghost-body))
                       (overlays-at (point))))))
    (unless overlay (user-error "No tool call here"))
    (let ((inhibit-read-only t)
          (fold (not (overlay-get overlay 'invisible))))
      (overlay-put overlay 'invisible fold)
      (goto-char (overlay-start overlay))
      (forward-line -1)
      (save-excursion
        (when (looking-at "  [▸▾]")
          (goto-char (+ (point) 2))
          (let ((properties (text-properties-at (point))))
            (delete-char 1)
            (insert (apply #'propertize (if fold "▸" "▾") properties))))))))

(defun ghost-next-turn ()
  "Move to the next entry's label."
  (interactive)
  (let ((start (point)))
    (forward-line 1)
    (while (not (or (eobp) (get-text-property (point) 'ghost-turn)))
      (forward-line 1))
    (unless (get-text-property (point) 'ghost-turn)
      (goto-char start)
      (user-error "No later turn"))))

(defun ghost-previous-turn ()
  "Move to the previous entry's label."
  (interactive)
  (let ((start (point)))
    (forward-line 0)
    (when (= (point) start) (forward-line -1))
    (while (not (or (bobp) (get-text-property (point) 'ghost-turn)))
      (forward-line -1))
    (unless (get-text-property (point) 'ghost-turn)
      (goto-char start)
      (user-error "No earlier turn"))))

(defun ghost-copy-answer ()
  "Copy the newest answer."
  (interactive)
  (unless ghost--last-answer (user-error "No answer yet"))
  (kill-new ghost--last-answer)
  (message "Copied the last answer"))

;;;; Buttons

(define-button-type 'ghost-file
  'action (lambda (button)
            (ghost--open-file (button-get button 'ghost-file)
                              (button-get button 'ghost-line)))
  'help-echo "Open this file")

(define-button-type 'ghost-task
  'action (lambda (button) (ghost--open-task (button-get button 'ghost-task)))
  'help-echo "Open this task")

(defconst ghost--path-regexp
  (concat "\\(?:^\\|[[:space:]`'\"(\\[]\\)"
          "\\(\\(?:~/files\\)?/[^][[:space:]`'\"()<>,;]+\\)")
  "A Volume path or a path under ~/files, in group 1.")

(defun ghost--buttonize (start end)
  "Make buttons of the paths that exist and the task ids from START to END."
  (save-excursion
    (goto-char start)
    (while (re-search-forward ghost--path-regexp end t)
      (let* ((beg (match-beginning 1))
             (text (string-trim-right (match-string 1) "[.:!?]+"))
             (line (and (string-match ":\\([0-9]+\\)\\(?::[0-9]+\\)?\\'" text)
                        (string-to-number (match-string 1 text))))
             (path (if line (substring text 0 (match-beginning 0)) text))
             (file (ghost--real-path path)))
        (when (file-exists-p file)
          (make-text-button beg (+ beg (length text)) :type 'ghost-file
                            'ghost-file file 'ghost-line line))))
    (goto-char start)
    (while (re-search-forward "\\_<\\([0-9]\\{8\\}T[0-9]\\{6\\}\\)\\_>" end t)
      (unless (button-at (match-beginning 1))
        (make-text-button (match-beginning 1) (match-end 1) :type 'ghost-task
                          'ghost-task (match-string 1))))))

(defun ghost--real-path (path)
  "The file on disk for PATH, a Volume path or a path under ~/files."
  (if (string-prefix-p "~/" path)
      (expand-file-name path)
    (expand-file-name (substring path 1) ghost-root)))

(defun ghost--open-file (file line)
  "Open FILE, at LINE when there is one, outside the side window."
  (find-file-other-window file)
  (when line
    (goto-char (point-min))
    (forward-line (1- line))))

(defun ghost--open-task (id)
  "Open the file of the task ID, the first that `ws path' prints."
  (let ((file (car (ignore-errors (process-lines ghost-ws-program "path" id)))))
    (unless file (user-error "`%s path %s' found nothing" ghost-ws-program id))
    (find-file-other-window file)))

(provide 'ghost)
;;; ghost.el ends here
