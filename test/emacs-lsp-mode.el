;;; emacs-lsp-mode.el --- editors/emacs/phitex.el through lsp-mode  -*- lexical-binding: t; -*-
;;; In batch (Emacs 29+, lsp-mode installed in PKG_DIR):
;;;   PKG_DIR=~/.emacs.d/elpa DOC=/path/doc.tex emacs --batch -Q -l test/emacs-lsp-mode.el
;;; (phitex on PATH, DOC in a folder of its own): lsp-mode starts PhiTeX's
;;; client (an add-on, beside a TeX server if one is installed), an unsaved error is a diagnostic, its fix
;;; clears it, and phitex/status reaches the mode line.
(require 'package)
(setq package-user-dir (getenv "PKG_DIR"))
(package-initialize)
(load (expand-file-name "editors/emacs/phitex.el"))
(require 'lsp-mode)
(setq lsp-auto-guess-root t lsp-enable-file-watchers nil lsp-diagnostics-provider :none
      lsp-restart 'ignore lsp-enable-snippet nil lsp-headerline-breadcrumb-enable nil)
(defun phitex-test--wait (pred secs)
  (let ((end (+ (float-time) secs)))
    (while (and (not (funcall pred)) (< (float-time) end))
      (accept-process-output nil 0.2))
    (funcall pred)))
(defun phitex-test--diags ()
  (gethash (lsp--fix-path-casing (buffer-file-name)) (lsp-diagnostics t)))
(find-file (getenv "DOC"))
(latex-mode)
(lsp)
(princ (format "mode %s, clients: %s\n" major-mode
               (and (phitex-test--wait (lambda () (lsp-workspaces)) 20)
                    (mapcar (lambda (w) (lsp--client-server-id (lsp--workspace-client w))) (lsp-workspaces)))))
;; (the first build makes the format)
(phitex-test--wait (lambda () nil) 25)
(goto-char (point-min))
(search-forward "Some text")
(beginning-of-line)
(insert "\\undefinedmacro ")
(let ((got (phitex-test--wait #'phitex-test--diags 30)))
  (princ (format "unsaved error -> diagnostic: %s %s\n" (and got t)
                 (and got (lsp:diagnostic-message (car got))))))
(beginning-of-line)
(delete-char 16)
(princ (format "fixed -> cleared: %s\n" (phitex-test--wait (lambda () (null (phitex-test--diags))) 30)))
(princ (format "mode line: %S\n" (phitex-mode-line)))
(kill-emacs 0)
