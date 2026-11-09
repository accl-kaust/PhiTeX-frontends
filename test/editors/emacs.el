;;; emacs.el --- Emacs smoke test for phitex.el  -*- lexical-binding: t; -*-
;; CI: .github/workflows/editors.yml. phitex.el byte-compiles with no warning,
;; loads, and its mode and commands are defined.
;;   emacs --batch -Q -l test/editors/emacs.el
(setq byte-compile-error-on-warn t)
(let ((src (expand-file-name "apps/editors/emacs/phitex.el")))
  (unless (byte-compile-file src) (error "phitex.el did not byte-compile"))
  (load (concat src "c") nil t))
(dolist (f '(phitex-mode phitex-attach))
  (unless (fboundp f) (error "%s is not defined" f)))
(message "phitex.el loads on Emacs %s" emacs-version)
