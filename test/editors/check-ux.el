;;; check-ux.el --- phitex.el on a new user's paths  -*- lexical-binding: t; -*-
;;; Run by test/editors/run-ux.sh: PROJECT (main.tex); each line "ok NAME" or
;;; "FAIL NAME: why"; exit 1 on a failure.  `phitex-setup' turns the mode on in
;;; Emacs's own latex-mode (no AUCTeX); a problem typed at the end of a long
;;; line is Flymake's at its column; the doctor's report ends with the issue
;;; link and is copied by w.
(require 'cl-lib)
(setq flymake-diagnostic-functions nil)
(defvar check-failed nil)
(defun check (name ok &optional why)
  (princ (if ok (format "ok %s\n" name) (format "FAIL %s: %s\n" name why)))
  (unless ok (setq check-failed t)))
(defun check-wait (pred secs)
  (let ((end (+ (float-time) secs)))
    (while (and (not (funcall pred)) (< (float-time) end)) (accept-process-output nil 0.1))
    (funcall pred)))
(defun check-ours () (cl-remove-if-not (lambda (d) (eq (flymake-diagnostic-backend d) #'phitex--flymake)) (flymake-diagnostics)))
(phitex-setup)
(add-hook 'latex-mode-hook (lambda () (remove-hook 'flymake-diagnostic-functions 'tex-chktex t)) 90)
(let ((main (concat (file-name-as-directory (getenv "PROJECT")) "main.tex")))
  (find-file main)
  (unless (derived-mode-p 'latex-mode) (latex-mode))
  (check "phitex-setup turns the mode on in latex-mode" (bound-and-true-p phitex-mode) major-mode)
  (check-wait (lambda () (equal (plist-get phitex--status :state) "ready")) 180)
  (goto-char (point-min))
  (search-forward "so the paragraph is real.")
  (insert " \\undefinedmacrohere")
  (let ((col (- (point) (line-beginning-position) (length "\\undefinedmacrohere"))))
    (check "an error typed is Flymake's"
           (check-wait (lambda () (flymake-start) (check-ours)) 90) (format "%S" phitex--diags))
    (let ((d (car (check-ours))))
      (check "at its column, not the line's start"
             (and d (= (save-excursion (goto-char (flymake-diagnostic-beg d)) (current-column)) col))
             (and d (save-excursion (goto-char (flymake-diagnostic-beg d)) (current-column))))))
  (phitex-doctor)
  (with-current-buffer "*phitex-doctor*"
    (let ((all (buffer-string)))
      (check "the doctor ends with the issue link"
             (string-match-p "https://github.com/accl-kaust/PhiTeX/issues/new/choose" all) all)
      (check "the doctor holds no document text" (not (string-match-p "motivation" all)) all)))
  (phitex-doctor-copy)
  (check "w copies the report" (string-prefix-p "PhiTeX doctor" (current-kill 0)) (current-kill 0))
  (with-current-buffer (find-buffer-visiting main)
    (set-buffer-modified-p nil)
    (kill-buffer)))
(kill-emacs (if check-failed 1 0))
