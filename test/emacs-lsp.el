;;; emacs-lsp.el --- editors/emacs/phitex.el against phitex watch --lsp  -*- lexical-binding: t; -*-
;;; In batch (Emacs 29+):
;;;   DOC=/path/doc.tex emacs --batch -Q -l editors/emacs/phitex.el -l test/emacs-lsp.el
;;; (phitex on PATH, DOC in a folder of its own): eglot connects, an unsaved
;;; error is a flymake diagnostic, its fix clears it.
(require 'flymake)
(require 'eglot)
(defun phitex-test--diags ()
  "What the server last pushed for this buffer: flymake's, else eglot's own."
  (or (flymake-diagnostics)
      (and (boundp 'eglot--diagnostics) (car-safe eglot--diagnostics))))
(defun phitex-test--send ()
  "Send the edit now: eglot sends changes from an idle timer, and batch is never idle."
  (eglot--signal-textDocument/didChange))
(defun phitex-test--wait (pred secs)
  (let ((end (+ (float-time) secs)))
    (while (and (not (funcall pred)) (< (float-time) end))
      (accept-process-output nil 0.2)
      (when flymake-mode (flymake-start)))
    (funcall pred)))
(find-file (getenv "DOC"))
(latex-mode)
(apply #'eglot (eglot--guess-contact))
(princ (format "mode %s, server: %s\n" major-mode
               (and (phitex-test--wait #'eglot-current-server 20) "connected")))
;; (the first build makes the format)
(phitex-test--wait (lambda () nil) 25)
(goto-char (point-min))
(search-forward "Some text")
(beginning-of-line)
(insert "\\undefinedmacro ")
(phitex-test--send)
(let ((got (phitex-test--wait #'phitex-test--diags 30)))
  (princ (format "unsaved error -> diagnostic: %s (flymake-mode %s) %S\n" (and got t) flymake-mode
                 (and got (truncate-string-to-width (format "%S" got) 160)))))
(beginning-of-line)
(delete-char 16)
(phitex-test--send)
(princ (format "fixed -> cleared: %s\n" (phitex-test--wait (lambda () (null (phitex-test--diags))) 30)))
(kill-emacs 0)
