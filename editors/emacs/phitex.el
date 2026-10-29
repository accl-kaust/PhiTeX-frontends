;;; phitex.el --- PhiTeX's live preview through lsp-mode or eglot  -*- lexical-binding: t; -*-

;; `phitex watch --lsp' as the language server of TeX buffers (Emacs 29+,
;; through lsp-mode or eglot, whichever you use): the buffer is built as you
;; type, TeX's errors are diagnostics, a double-click on a page opens its
;; source here (window/showDocument), and the cursor's words are marked on
;; the page (phitex/cursor, sent when Emacs has been idle 0.15 s). The pages
;; are in a browser tab the watch serves (M-x phitex-open-viewer).
;;
;; What the engine is doing (phitex/status: building, the last build's
;; time, its problems) shows in the mode line ("⚡ 67 ms ✗2"); its progress
;; (fetching a package, typesetting) is the client's own. Commands:
;; phitex-open-viewer, phitex-stop, phitex-restart, phitex-rebuild,
;; phitex-save-pdf, phitex-caches, phitex-clear-cache.
;;
;; Settings (docs/spec-editor-protocol.md §3.5): `phitex-settings', set
;; before loading, e.g. (setq phitex-settings '(:threads 4 :follow
;; "selection")): threads (default: one per core), main ("paper.tex"),
;; follow ("cursor": the words at the cursor marked on the page;
;; "selection": only a selection's; "dblclick": nothing as you move).
;;
;; Load this file (e.g. (load "~/path/to/phitex.el")), then in a TeX
;; buffer M-x lsp or M-x eglot. lsp-mode runs PhiTeX beside your TeX
;; server (an add-on: texlab or digestif keeps completion and the rest,
;; PhiTeX the pages, unsaved edits, the cursor and the build's errors);
;; eglot runs one server a buffer, so there PhiTeX is the only one; `phitex' must be on PATH. A project with several .tex
;; files names its main one in phitex.toml (main = "paper.tex").

;;; Code:

(require 'cl-lib)
(require 'subr-x)

(defvar phitex-settings nil
  "The engine's settings, a plist (:threads :main :follow); set before loading.")

(defconst phitex--modes '(latex-mode LaTeX-mode tex-mode plain-tex-mode))
(defconst phitex--command '("phitex" "watch" "--lsp"))

;;; The client: lsp-mode or eglot, whichever manages the buffer

(declare-function eglot-current-server "eglot")
(declare-function eglot-managed-p "eglot")
(declare-function eglot--TextDocumentPositionParams "eglot")
(declare-function eglot-reconnect "eglot")
(declare-function jsonrpc-request "jsonrpc")
(declare-function jsonrpc-notify "jsonrpc")
(declare-function lsp-request "lsp-mode")
(declare-function lsp-notify "lsp-mode")
(declare-function lsp--text-document-position-params "lsp-mode")
(declare-function lsp-workspace-restart "lsp-mode")
(declare-function lsp-register-client "lsp-mode")
(declare-function make-lsp-client "lsp-mode")
(declare-function lsp-stdio-connection "lsp-mode")
(declare-function lsp-register-custom-settings "lsp-mode")
(defvar lsp-mode)
(defvar lsp-language-id-configuration)

(defun phitex--client ()
  "The buffer's client: `lsp', `eglot', or nil."
  (cond ((bound-and-true-p lsp-mode) 'lsp)
        ((and (fboundp 'eglot-managed-p) (eglot-managed-p)) 'eglot)))

(defun phitex--check ()
  (or (phitex--client) (user-error "PhiTeX: no watch for this buffer (M-x lsp, or M-x eglot)")))

(defun phitex--get (obj key)
  "KEY (a keyword) of OBJ.
OBJ: a plist (eglot, lsp-mode with plists) or a hash table (lsp-mode)."
  (if (hash-table-p obj) (gethash (substring (symbol-name key) 1) obj) (plist-get obj key)))

(defun phitex--exec (command &optional arg)
  "The watch's COMMAND (docs/spec-editor-protocol.md), with ARG; its answer."
  (let ((params (if arg `(:command ,command :arguments [,arg]) `(:command ,command))))
    (pcase (phitex--check)
      ('lsp (lsp-request "workspace/executeCommand" params))
      ('eglot (jsonrpc-request (eglot-current-server) :workspace/executeCommand params)))))

(defun phitex--notify-cursor ()
  (pcase (phitex--client)
    ('lsp (lsp-notify "phitex/cursor" (lsp--text-document-position-params)))
    ('eglot (when-let* ((s (eglot-current-server)))
              (jsonrpc-notify s :phitex/cursor (eglot--TextDocumentPositionParams))))))

;;; phitex/status: the mode line's "⚡ 67 ms ✗2"

(defvar phitex--status nil "The last phitex/status.")

(defun phitex--on-status (s)
  (setq phitex--status s)
  (force-mode-line-update t))

(defun phitex-mode-line ()
  "What the engine is doing, for the mode line."
  (when (and phitex--status (phitex--client))
    (let* ((s phitex--status) (state (phitex--get s :state))
           (errors (or (phitex--get s :errors) 0)) (warnings (or (phitex--get s :warnings) 0))
           (ms (phitex--get s :ms)) (pages (phitex--get s :pages))
           (problems (concat (if (> errors 0) (format " ✗%d" errors) "") (if (> warnings 0) (format " ⚠%d" warnings) ""))))
      (concat " "
              (pcase state
                ("ready" (format "⚡ %s%s" (if (and ms (> ms 0)) (format "%d ms" (round ms)) "ready") problems))
                ("fetching" (format "⚡ fetching %s" (or (phitex--get s :name) "packages")))
                ("typesetting" (format "⚡ typesetting%s" (if (and pages (> pages 0)) (format " p. %d" pages) "")))
                ("failed" (format "⚡ failed%s" problems))
                (_ (format "⚡ %s" state)))))))

(add-to-list 'mode-line-misc-info '(:eval (phitex-mode-line)))

;;; The servers' registration, each client's way

(with-eval-after-load 'lsp-mode
  (dolist (m phitex--modes) (add-to-list 'lsp-language-id-configuration (cons m "latex")))
  ;; (the settings, answered to workspace/configuration's "phitex" section)
  (lsp-register-custom-settings
   (cl-loop for (k v) on phitex-settings by #'cddr
            when v collect (list (concat "phitex." (substring (symbol-name k) 1)) v)))
  (lsp-register-client
   (make-lsp-client
    :new-connection (lsp-stdio-connection phitex--command)
    :major-modes phitex--modes
    :server-id 'phitex
    ;; (beside the buffer's own TeX server, texlab's or digestif's, not instead of it)
    :add-on? t
    :initialization-options (lambda () phitex-settings)
    :notification-handlers (let ((h (make-hash-table :test 'equal)))
                             (puthash "phitex/status" (lambda (_workspace s) (phitex--on-status s)) h)
                             h))))

(with-eval-after-load 'eglot
  (defvar eglot-server-programs)
  (defvar eglot-workspace-configuration)
  (add-to-list 'eglot-server-programs
               `(,phitex--modes . (,@phitex--command :initializationOptions ,phitex-settings)))
  (setq-default eglot-workspace-configuration
                (plist-put (default-value 'eglot-workspace-configuration) :phitex phitex-settings))
  (cl-defmethod eglot-handle-notification (_server (_method (eql phitex/status)) &rest s)
    (phitex--on-status s)))

;;; The cursor

(defvar-local phitex--timer nil)

(defun phitex--cursor ()
  "Tell the watch where the cursor is, once Emacs is idle.
As `phitex-settings' :follow says."
  (when phitex--timer (cancel-timer phitex--timer))
  (when (and (phitex--client)
             (pcase (or (plist-get phitex-settings :follow) "cursor")
               ("cursor" t)
               ("selection" (use-region-p))))
    (let ((buf (current-buffer)))
      (setq phitex--timer
            (run-with-idle-timer
             0.15 nil
             (lambda ()
               (when (buffer-live-p buf)
                 (with-current-buffer buf (phitex--notify-cursor)))))))))

(defun phitex--track ()
  (if (phitex--client)
      (add-hook 'post-command-hook #'phitex--cursor nil t)
    (remove-hook 'post-command-hook #'phitex--cursor t)))

(add-hook 'eglot-managed-mode-hook #'phitex--track)
(add-hook 'lsp-mode-hook #'phitex--track)

;;; Commands

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
  (pcase (phitex--check)
    ('lsp (lsp-workspace-restart (car (bound-and-true-p lsp--buffer-workspaces))))
    ('eglot (eglot-reconnect (eglot-current-server)))))

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
    (message "PhiTeX: %s cache cleared, %s freed" scope (phitex--size (or (phitex--get r :freed_bytes) 0)))))

(define-derived-mode phitex-caches-mode tabulated-list-mode "PhiTeX caches"
  "The watch's caches: c clears the one at point, g reads them again."
  (setq tabulated-list-format [("Cache" 10 t) ("Size" 9 t) ("Entries" 8 t) ("Last used" 22 t) ("Hits" 6 t) ("Misses" 7 t) ("Location" 0 t)])
  (tabulated-list-init-header))

(defvar-local phitex--caches-source nil "The TeX buffer whose watch the caches are.")

(defun phitex--caches-read ()
  (let* ((source phitex--caches-source)
         (r (with-current-buffer source (phitex--exec "phitex.cacheStats"))))
    (setq tabulated-list-entries
          (mapcar (lambda (c)
                    (let ((g (lambda (k) (phitex--get c k))))
                      (list (funcall g :scope)
                            (vector (funcall g :scope) (phitex--size (or (funcall g :bytes) 0))
                                    (format "%d" (or (funcall g :entries) 0)) (or (funcall g :last_used) "never")
                                    (format "%d" (or (funcall g :hits) 0)) (format "%d" (or (funcall g :misses) 0))
                                    (or (funcall g :location) "")))))
                  (append (phitex--get r :caches) nil)))
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
