;;; phitex.el --- PhiTeX's live preview through eglot  -*- lexical-binding: t; -*-

;; `phitex watch --lsp' as the language server of TeX buffers (Emacs 29+,
;; eglot): the buffer is built as you type, TeX's errors are diagnostics,
;; a double-click on a page opens its source here (window/showDocument),
;; and the cursor's words are marked on the page (phitex/cursor, sent when
;; Emacs has been idle 0.15 s). The pages are in a browser tab the watch
;; serves (M-x phitex-open-viewer).
;;
;; What the engine is doing (phitex/status: building, the last build's
;; time, its problems) shows in the mode line ("⚡ 67 ms ✗2"); its progress
;; (fetching a package, typesetting) is eglot's own. Commands:
;; phitex-open-viewer, phitex-stop, phitex-restart, phitex-rebuild,
;; phitex-save-pdf, phitex-caches, phitex-clear-cache.
;;
;; Load this file (e.g. (load "~/path/to/phitex.el")) and turn eglot on
;; in a TeX buffer (M-x eglot); `phitex' must be on PATH. A project with
;; several .tex files names its main one in phitex.toml (main = "paper.tex").

;;; Code:

(require 'eglot)

(add-to-list 'eglot-server-programs
             '((latex-mode LaTeX-mode tex-mode plain-tex-mode) . ("phitex" "watch" "--lsp")))

(defvar-local phitex--timer nil)

(defun phitex--cursor ()
  "Tell the watch where the cursor is, once Emacs is idle."
  (when phitex--timer (cancel-timer phitex--timer))
  (let ((buf (current-buffer)))
    (setq phitex--timer
          (run-with-idle-timer
           0.15 nil
           (lambda ()
             (when (buffer-live-p buf)
               (with-current-buffer buf
                 (when-let* ((s (eglot-current-server)))
                   (jsonrpc-notify s :phitex/cursor (eglot--TextDocumentPositionParams))))))))))

(add-hook 'eglot-managed-mode-hook
          (lambda ()
            (if (eglot-managed-p)
                (add-hook 'post-command-hook #'phitex--cursor nil t)
              (remove-hook 'post-command-hook #'phitex--cursor t))))

(defun phitex--server ()
  (or (eglot-current-server) (user-error "PhiTeX: no watch for this buffer (M-x eglot)")))

(defun phitex--exec (command &optional arg server)
  "The watch's COMMAND (docs/spec-editor-protocol.md), with ARG; its answer.
SERVER: this buffer's by default."
  (jsonrpc-request (or server (phitex--server)) :workspace/executeCommand
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
  (eglot-reconnect (phitex--server)))

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

(defun phitex-clear-cache (scope &optional server)
  "Clear the SCOPE cache: build, packages or all (of SERVER's watch)."
  (interactive (list (completing-read "Clear which cache: " '("build" "packages" "all") nil t nil nil "build")))
  (let ((r (phitex--exec "phitex.clearCache" `(:scope ,scope) server)))
    (message "PhiTeX: %s cache cleared, %s freed" scope (phitex--size (or (plist-get r :freed_bytes) 0)))))

(define-derived-mode phitex-caches-mode tabulated-list-mode "PhiTeX caches"
  "The watch's caches: c clears the one at point, g reads them again."
  (setq tabulated-list-format [("Cache" 10 t) ("Size" 9 t) ("Entries" 8 t) ("Last used" 22 t) ("Hits" 6 t) ("Misses" 7 t) ("Location" 0 t)])
  (tabulated-list-init-header))

(defvar phitex--caches-server nil)

(defun phitex--caches-read ()
  (let ((r (phitex--exec "phitex.cacheStats" nil phitex--caches-server)))
    (setq tabulated-list-entries
          (mapcar (lambda (c)
                    (list (plist-get c :scope)
                          (vector (plist-get c :scope) (phitex--size (or (plist-get c :bytes) 0))
                                  (format "%d" (or (plist-get c :entries) 0)) (or (plist-get c :last_used) "never")
                                  (format "%d" (or (plist-get c :hits) 0)) (format "%d" (or (plist-get c :misses) 0))
                                  (or (plist-get c :location) ""))))
                  (plist-get r :caches)))
    (tabulated-list-print t)))

(defun phitex-caches ()
  "Show the watch's caches.
Their sizes, entries and last use, and this session's hits and misses."
  (interactive)
  (let ((server (phitex--server)))
    (with-current-buffer (get-buffer-create "*PhiTeX caches*")
      (phitex-caches-mode)
      (setq-local phitex--caches-server server)
      (setq-local revert-buffer-function (lambda (&rest _) (phitex--caches-read)))
      (local-set-key (kbd "c") (lambda () (interactive)
                                 (let ((scope (tabulated-list-get-id)))
                                   (when (and scope (yes-or-no-p (format "Clear the %s cache? " scope)))
                                     (phitex-clear-cache scope phitex--caches-server)
                                     (phitex--caches-read)))))
      (phitex--caches-read)
      (pop-to-buffer (current-buffer)))))

;;; phitex/status: the mode line's "⚡ 67 ms ✗2"

(defvar phitex--status nil "The last phitex/status, a plist.")

(cl-defmethod eglot-handle-notification (_server (_method (eql phitex/status)) &rest s)
  (setq phitex--status s)
  (force-mode-line-update t))

(defun phitex-mode-line ()
  "What the engine is doing, for the mode line."
  (when (and phitex--status (eglot-managed-p))
    (let* ((s phitex--status) (state (plist-get s :state))
           (errors (or (plist-get s :errors) 0)) (warnings (or (plist-get s :warnings) 0))
           (problems (concat (if (> errors 0) (format " ✗%d" errors) "") (if (> warnings 0) (format " ⚠%d" warnings) ""))))
      (concat " "
              (pcase state
                ("ready" (format "⚡ %s%s" (if (plist-get s :ms) (format "%d ms" (round (plist-get s :ms))) "ready") problems))
                ("fetching" (format "⚡ fetching %s" (or (plist-get s :name) "packages")))
                ("typesetting" (format "⚡ typesetting%s" (if (plist-get s :pages) (format " p. %d" (plist-get s :pages)) "")))
                ("failed" (format "⚡ failed%s" problems))
                (_ (format "⚡ %s" state)))))))

(add-to-list 'mode-line-misc-info '(:eval (phitex-mode-line)))

(provide 'phitex)
;;; phitex.el ends here
