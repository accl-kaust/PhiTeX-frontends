;;; phitex.el --- PhiTeX's live preview through eglot  -*- lexical-binding: t; -*-

;; `phitex watch --lsp' as the language server of TeX buffers (Emacs 29+,
;; eglot): the buffer is built as you type, TeX's errors are diagnostics,
;; a double-click on a page opens its source here (window/showDocument),
;; and the cursor's words are marked on the page (phitex/cursor, sent when
;; Emacs has been idle 0.15 s). The pages are in a browser tab the watch
;; serves (M-x phitex-open-viewer).
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
                 (when-let ((s (eglot-current-server)))
                   (jsonrpc-notify s :phitex/cursor (eglot--TextDocumentPositionParams))))))))))

(add-hook 'eglot-managed-mode-hook
          (lambda ()
            (if (eglot-managed-p)
                (add-hook 'post-command-hook #'phitex--cursor nil t)
              (remove-hook 'post-command-hook #'phitex--cursor t))))

(defun phitex-open-viewer ()
  "Open the pages the watch serves in a browser."
  (interactive)
  (if (fboundp 'eglot-execute)
      ;; (Emacs 30)
      (eglot-execute (eglot-current-server) '(:command "phitex.openViewer"))
    (eglot-execute-command (eglot-current-server) "phitex.openViewer" [])))

(provide 'phitex)
;;; phitex.el ends here
