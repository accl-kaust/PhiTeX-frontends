;;; phitex.el --- PhiTeX's live preview: a minor mode on its own language server  -*- lexical-binding: t; -*-

;; `phitex-mode': `phitex watch --lsp' as a TeX buffer's preview server,
;; spoken to directly through jsonrpc.el (Emacs 29+: the protocol layer
;; eglot itself is built on), so it runs beside whatever else serves the
;; buffer, eglot or lsp-mode with texlab or digestif (their completion, and
;; the rest), or nothing. The buffer is built as you type (its unsaved
;; edits sent as they are made), TeX's errors are flymake diagnostics, a
;; double-click on a page opens its source here (window/showDocument), and
;; the cursor's word and line, and the region's text, are marked on the page
;; as you move (phitex/cursor with its range). The pages are in a browser tab the watch serves
;; (M-x phitex-open-viewer).
;;
;; What the engine is doing (phitex/status: fetching a package,
;; typesetting, the last build's time, its problems) shows in the mode line
;; ("⚡ 67 ms ✗2"). Commands: phitex-open-viewer, phitex-stop,
;; phitex-restart, phitex-rebuild, phitex-save-pdf, phitex-caches,
;; phitex-clear-cache.
;;
;; Settings (docs/spec-editor-protocol.md §3.5): `phitex-settings', e.g.
;; (setq phitex-settings '(:threads 4 :follow "selection")): threads
;; (default: one per core), main ("paper.tex"), follow ("cursor": the words
;; at the cursor marked on the page; "selection": only a selection's;
;; "dblclick": nothing as you move).
;;
;; Load this file and turn the mode on in TeX buffers:
;;   (load "~/path/to/phitex.el")
;;   (add-hook 'LaTeX-mode-hook #'phitex-mode) ; and/or latex-mode-hook
;; `phitex' must be on PATH. A project is its phitex.toml's folder, else
;; the file's own; one with several .tex files names its main one in
;; phitex.toml (main = "paper.tex").

;;; Code:

(require 'cl-lib)
(require 'subr-x)
(require 'jsonrpc)
(require 'map)
(require 'flymake)
(require 'url-util)

(defvar phitex-settings nil
  "The engine's settings, a plist (:threads :main :follow).")

(defvar phitex-command '("phitex" "watch" "--lsp")
  "How the language server is started.")

(defconst phitex--client '(:name "phitex.el" :version "0.1.0")
  "This file, as the server is told (initializationOptions.client).
See docs/spec-editor-protocol.md §1.")

(defconst phitex--protocol 1
  "The editor protocol this file speaks: an older server's is said.")

;;; The servers: one a project

(defvar phitex--servers (make-hash-table :test 'equal) "Project root to its connection.")
(defvar phitex--status nil "The last phitex/status, a plist.")
(defvar-local phitex--server nil)
(defvar-local phitex--version 0)
(defvar-local phitex--change nil "The change under way: its LSP start and end, before it was made.")
(defvar-local phitex--diags nil "The server's last diagnostics for this buffer.")
(defvar-local phitex--report nil "Flymake's report function, for diagnostics that arrive later.")
(defvar-local phitex--timer nil)

(defun phitex--root ()
  (expand-file-name (or (locate-dominating-file default-directory "phitex.toml") default-directory)))

(defun phitex--uri (&optional file)
  (concat "file://" (url-hexify-string (expand-file-name (or file buffer-file-name)) url-path-allowed-chars)))

(defun phitex--file (uri)
  (decode-coding-string (url-unhex-string (string-remove-prefix "file://" uri)) 'utf-8))

(defun phitex--buffers (server)
  (cl-remove-if-not (lambda (b) (eq (buffer-local-value 'phitex--server b) server)) (buffer-list)))

(defun phitex--connect (root)
  "The server of the project at ROOT, started if none."
  (or (let ((s (gethash root phitex--servers))) (and s (jsonrpc-running-p s) s))
      (let* ((default-directory root)
             (proc (make-process :name "phitex" :command phitex-command :connection-type 'pipe
                                 :coding 'utf-8-emacs-unix :noquery t
                                 :stderr (get-buffer-create "*phitex stderr*")))
             (s (make-instance 'jsonrpc-process-connection :name (format "phitex %s" root) :process proc
                               :request-dispatcher #'phitex--request
                               :notification-dispatcher #'phitex--notification
                               :on-shutdown (lambda (s) (phitex--ended s root)))))
        (puthash root s phitex--servers)
        (let* ((init (jsonrpc-request s :initialize
                                      (list :processId (emacs-pid) :rootUri (phitex--uri root)
                                            :capabilities '(:window (:showDocument (:support t) :workDoneProgress t)
                                                            :workspace (:configuration t)
                                                            :general (:positionEncodings ["utf-16"]))
                                            :initializationOptions (append phitex-settings (list :client phitex--client)))))
               (protocol (map-nested-elt init '(:capabilities :experimental :phitex :protocol))))
          ;; (a phitex older than this file's protocol: said, the watch kept)
          (unless (and (numberp protocol) (>= protocol phitex--protocol))
            (display-warning 'phitex
                             (format "PhiTeX %s is older than this phitex.el needs: update phitex"
                                     (or (map-nested-elt init '(:serverInfo :version)) "(of an unknown version)"))
                             :error)))
        (jsonrpc-notify s :initialized (make-hash-table))
        s)))

(defun phitex--ended (server root)
  "SERVER exited: its buffers told; said unless it was asked to stop."
  (remhash root phitex--servers)
  (dolist (b (phitex--buffers server))
    (with-current-buffer b (setq phitex--server nil)))
  (unless (equal (plist-get phitex--status :state) "stopped")
    (message "PhiTeX: phitex watch exited (M-x phitex-restart starts it again)"))
  (setq phitex--status nil)
  (force-mode-line-update t))

;;; Positions: LSP's lines and UTF-16 columns

(defun phitex--pos (&optional point)
  "POINT (default: point) as an LSP position."
  (save-excursion
    (when point (goto-char point))
    (let ((s (buffer-substring-no-properties (line-beginning-position) (point))))
      (list :line (1- (line-number-at-pos nil t))
            :character (+ (length s) (cl-count-if (lambda (c) (> c #xFFFF)) s))))))

(defun phitex--point (pos)
  "LSP position POS as a point."
  (save-excursion
    (goto-char (point-min))
    (forward-line (plist-get pos :line))
    (let ((col (plist-get pos :character)))
      (while (and (> col 0) (not (eolp)))
        (setq col (- col (if (> (char-after) #xFFFF) 2 1)))
        (forward-char)))
    (point)))

;;; The buffer: opened, changed, closed

(defun phitex--open ()
  (setq phitex--version 0)
  (jsonrpc-notify phitex--server :textDocument/didOpen
                  (list :textDocument (list :uri (phitex--uri) :languageId "latex" :version 0
                                            :text (buffer-substring-no-properties (point-min) (point-max))))))

(defun phitex--before-change (beg end)
  (when phitex--server
    (setq phitex--change (list (phitex--pos beg) (phitex--pos end)))))

(defun phitex--after-change (beg end _len)
  (when (and phitex--server phitex--change)
    (cl-incf phitex--version)
    (jsonrpc-notify phitex--server :textDocument/didChange
                    (list :textDocument (list :uri (phitex--uri) :version phitex--version)
                          :contentChanges (vector (list :range (list :start (car phitex--change) :end (cadr phitex--change))
                                                        :text (buffer-substring-no-properties beg end)))))
    (setq phitex--change nil)))

(defun phitex--close ()
  (when (and phitex--server (jsonrpc-running-p phitex--server))
    (jsonrpc-notify phitex--server :textDocument/didClose (list :textDocument (list :uri (phitex--uri)))))
  (setq phitex--server nil))

(defvar-local phitex--selected nil
  "Whether the last cursor sent had a region (its end clears the page's marks).")

(defun phitex--cursor ()
  "Tell the watch where the cursor and its region are, once Emacs pauses.
The latest after 0.03 s idle: the cursor's word marked on the page, the
region's text too (an empty range clearing it); as `phitex-settings'
:follow says (\"cursor\": every move; \"selection\": only a region's,
and as it ends; \"dblclick\": never)."
  (when phitex--timer (cancel-timer phitex--timer))
  (let* ((region (use-region-p))
         (ended (and phitex--selected (not region))))
    (when (and phitex--server
               (pcase (or (plist-get phitex-settings :follow) "cursor")
                 ("cursor" t)
                 ("selection" (or region ended))))
      (let ((buf (current-buffer)))
        (setq phitex--timer
              (run-with-idle-timer
               0.03 nil
               (lambda ()
                 (when (buffer-live-p buf)
                   (with-current-buffer buf
                     (when phitex--server
                       (let ((region (use-region-p)))
                         (setq phitex--selected region)
                         (jsonrpc-notify phitex--server :phitex/cursor
                                         (list :textDocument (list :uri (phitex--uri))
                                               :position (phitex--pos)
                                               :range (list :start (phitex--pos (if region (mark) (point)))
                                                            :end (phitex--pos)))))))))))))))

;;;###autoload
(define-minor-mode phitex-mode
  "PhiTeX's live preview of this TeX buffer.
Its own language server, beside any other the buffer has."
  :lighter nil
  (if phitex-mode
      (if (not buffer-file-name)
          (progn (setq phitex-mode nil) (message "PhiTeX: the buffer has no file"))
        (setq phitex--server (phitex--connect (phitex--root)))
        (phitex--open)
        (add-hook 'before-change-functions #'phitex--before-change nil t)
        (add-hook 'after-change-functions #'phitex--after-change nil t)
        (add-hook 'post-command-hook #'phitex--cursor nil t)
        (add-hook 'kill-buffer-hook #'phitex--close nil t)
        (add-hook 'flymake-diagnostic-functions #'phitex--flymake nil t)
        (flymake-mode 1))
    (remove-hook 'before-change-functions #'phitex--before-change t)
    (remove-hook 'after-change-functions #'phitex--after-change t)
    (remove-hook 'post-command-hook #'phitex--cursor t)
    (remove-hook 'kill-buffer-hook #'phitex--close t)
    (remove-hook 'flymake-diagnostic-functions #'phitex--flymake t)
    (phitex--close)))

;;; What the server says and asks

(defun phitex--notification (_server method params)
  (pcase method
    ('textDocument/publishDiagnostics
     (when-let* ((b (find-buffer-visiting (phitex--file (plist-get params :uri)))))
       (with-current-buffer b
         (setq phitex--diags (append (plist-get params :diagnostics) nil))
         (when phitex--report (phitex--flymake phitex--report)))))
    ('phitex/status (setq phitex--status params) (force-mode-line-update t))
    ('window/showMessage (message "PhiTeX: %s" (plist-get params :message)))
    ('window/logMessage
     (with-current-buffer (get-buffer-create "*phitex log*")
       (goto-char (point-max))
       (insert (plist-get params :message) "\n")))))

(defun phitex--request (_server method params)
  (pcase method
    ('window/showDocument
     (let ((sel (plist-get params :selection)))
       (if (eq (plist-get params :external) t)
           (browse-url (plist-get params :uri))
         (pop-to-buffer (find-file-noselect (phitex--file (plist-get params :uri))))
         (when sel (goto-char (phitex--point (plist-get sel :start)))))
       (list :success t)))
    ('workspace/configuration (vector (or phitex-settings :json-false)))
    ((or 'window/workDoneProgress/create 'client/registerCapability) nil)
    (_ (jsonrpc-error :code -32601 :message (format "%s: not handled" method)))))

(defun phitex--flymake (report &rest _)
  "Flymake's backend: the server's diagnostics, now and as they come (REPORT)."
  (setq phitex--report report)
  (funcall report
           (mapcar (lambda (d)
                     (let* ((r (plist-get d :range))
                            (beg (phitex--point (plist-get r :start)))
                            (end (max (1+ beg) (phitex--point (plist-get r :end)))))
                       (flymake-make-diagnostic (current-buffer) beg (min end (point-max))
                                                (pcase (plist-get d :severity) (1 :error) (2 :warning) (_ :note))
                                                (plist-get d :message))))
                   phitex--diags)))

;;; phitex/status: the mode line's "⚡ 67 ms ✗2"

(defun phitex-mode-line ()
  "What the engine is doing, for the mode line."
  (when (and phitex-mode phitex--status)
    (let* ((s phitex--status) (state (plist-get s :state))
           (errors (or (plist-get s :errors) 0)) (warnings (or (plist-get s :warnings) 0))
           (ms (plist-get s :ms)) (pages (plist-get s :pages))
           (problems (concat (if (> errors 0) (format " ✗%d" errors) "") (if (> warnings 0) (format " ⚠%d" warnings) ""))))
      (concat " "
              (pcase state
                ("ready" (format "⚡ %s%s" (if (and ms (> ms 0)) (format "%d ms" (round ms)) "ready") problems))
                ("fetching" (format "⚡ fetching %s" (or (plist-get s :name) "packages")))
                ("typesetting" (format "⚡ typesetting%s" (if (and pages (> pages 0)) (format " p. %d" pages) "")))
                ("failed" (format "⚡ failed%s" problems))
                (_ (format "⚡ %s" state)))))))

(add-to-list 'mode-line-misc-info '(:eval (phitex-mode-line)))

;;; Commands

(defun phitex--check ()
  (or phitex--server (user-error "PhiTeX: no watch for this buffer (M-x phitex-mode)")))

(defun phitex--exec (command &optional arg)
  "The watch's COMMAND (docs/spec-editor-protocol.md), with ARG; its answer."
  (jsonrpc-request (phitex--check) :workspace/executeCommand
                   (if arg `(:command ,command :arguments [,arg]) `(:command ,command))))

(defun phitex-open-viewer ()
  "Open the pages the watch serves in a browser."
  (interactive)
  (phitex--exec "phitex.openViewer"))

(defun phitex-stop ()
  "Stop the watch."
  (interactive)
  (phitex--exec "phitex.stop"))

(defun phitex-restart ()
  "Start the watch again."
  (interactive)
  (let ((buffers (if phitex--server (phitex--buffers phitex--server) (list (current-buffer)))))
    (when (and phitex--server (jsonrpc-running-p phitex--server))
      (jsonrpc-shutdown phitex--server))
    (dolist (b buffers)
      (with-current-buffer b
        (phitex-mode -1)
        (phitex-mode 1)))))

(defun phitex-rebuild ()
  "Build the document again from scratch."
  (interactive)
  (phitex--exec "phitex.rebuild"))

(defun phitex-save-pdf (file)
  "Save the PDF to FILE."
  (interactive "FSave the PDF to: ")
  (phitex--exec "phitex.savePdf" `(:path ,(expand-file-name file)))
  (message "PhiTeX: PDF saved to %s" file))

(defun phitex--size (b)
  (cond ((>= b 1073741824) (format "%.1f GB" (/ b 1073741824.0)))
        ((>= b 1048576) (format "%.0f MB" (/ b 1048576.0)))
        (t (format "%.0f kB" (/ b 1024.0)))))

(defun phitex-clear-cache (scope)
  "Clear the SCOPE cache: build, packages or all."
  (interactive (list (completing-read "Clear which cache: " '("build" "packages" "all") nil t nil nil "build")))
  (let ((r (phitex--exec "phitex.clearCache" `(:scope ,scope))))
    (message "PhiTeX: %s cache cleared, %s freed" scope (phitex--size (or (plist-get r :freed_bytes) 0)))))

(define-derived-mode phitex-caches-mode tabulated-list-mode "PhiTeX caches"
  "The watch's caches: c clears the one at point, g reads them again."
  (setq tabulated-list-format [("Cache" 10 t) ("Size" 9 t) ("Entries" 8 t) ("Last used" 22 t) ("Hits" 6 t) ("Misses" 7 t) ("Location" 0 t)])
  (tabulated-list-init-header))

(defvar-local phitex--caches-source nil "The TeX buffer whose watch the caches are.")

(defun phitex--caches-read ()
  (let ((r (with-current-buffer phitex--caches-source (phitex--exec "phitex.cacheStats"))))
    (setq tabulated-list-entries
          (mapcar (lambda (c)
                    (list (plist-get c :scope)
                          (vector (plist-get c :scope) (phitex--size (or (plist-get c :bytes) 0))
                                  (format "%d" (or (plist-get c :entries) 0)) (or (plist-get c :last_used) "never")
                                  (format "%d" (or (plist-get c :hits) 0)) (format "%d" (or (plist-get c :misses) 0))
                                  (or (plist-get c :location) ""))))
                  (append (plist-get r :caches) nil)))
    (tabulated-list-print t)))

(defun phitex-caches ()
  "Show the watch's caches.
Their sizes, entries and last use, and this session's hits and misses."
  (interactive)
  (phitex--check)
  (let ((source (current-buffer)))
    (with-current-buffer (get-buffer-create "*PhiTeX caches*")
      (phitex-caches-mode)
      (setq phitex--caches-source source)
      (setq-local revert-buffer-function (lambda (&rest _) (phitex--caches-read)))
      (local-set-key (kbd "c") (lambda () (interactive)
                                 (let ((scope (tabulated-list-get-id)))
                                   (when (and scope (yes-or-no-p (format "Clear the %s cache? " scope)))
                                     (with-current-buffer phitex--caches-source (phitex-clear-cache scope))
                                     (phitex--caches-read)))))
      (phitex--caches-read)
      (pop-to-buffer (current-buffer)))))

(provide 'phitex)
;;; phitex.el ends here
