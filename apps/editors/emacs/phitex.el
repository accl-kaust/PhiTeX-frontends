;;; phitex.el --- PhiTeX's live preview: a minor mode on its own language server  -*- lexical-binding: t; -*-

;; Version: 0.1.0
;; Package-Requires: ((emacs "29.1"))
;; URL: https://github.com/accl-kaust/PhiTeX-frontends

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
;; phitex-clear-cache, phitex-doctor (checks the setup for this buffer).
;;
;; The engine's settings (docs/spec-editor-protocol.md §3.5), sent to the
;; watch: `phitex-settings', e.g. (setq phitex-settings '(:threads 4 :follow "selection")):
;;   :threads  the engine's threads (default: one)
;;   :main     the main file, from the project's folder ("paper.tex"; default:
;;             phitex.toml's, else the one .tex with a \documentclass)
;;   :follow   when the page shows where you are: "cursor" (default: the word
;;             at the cursor, and the region's text, as you move), "selection"
;;             (only a region's), "dblclick" (nothing as you move)
;;   :files    where TeX's files come from: "texlive" (default: your TeX
;;             installation's) or "shelf" (PhiTeX's own, fetched as needed)
;; This Emacs's own (M-x customize-group RET phitex):
;;   `phitex-attach'             a watch already running (in a terminal) used:
;;                               auto (default), always, never
;;   `phitex-mark-selection'     text selected on the page marked here, face
;;                               `phitex-selection' (default: t)
;;   `phitex-dblclick-focus'     a double-click on the page selects the source's
;;                               window (default: t; nil: shown, focus kept)
;;   `phitex-follow-delay'       idle seconds before the cursor is sent (0.03)
;;   `phitex-diagnostics-delay'  idle seconds before Flymake shows a build's
;;                               problems (0.2)
;;   `phitex-command'            how the watch is started (phitex watch --lsp)
;; and for the download: `phitex-channel' ("stable" or "nightly"),
;; `phitex-release-base', `phitex-release-key', `phitex-install-prefix'.
;;
;; Load this file and turn the mode on in TeX buffers:
;;   (load "~/path/to/phitex.el")
;;   (add-hook 'LaTeX-mode-hook #'phitex-mode) ; and/or latex-mode-hook
;; or with use-package, Emacs 30's :vc:
;;   (use-package phitex
;;     :vc (:url "https://github.com/accl-kaust/PhiTeX-frontends"
;;          :lisp-dir "apps/editors/emacs" :rev :newest)
;;     :hook ((LaTeX-mode latex-mode) . phitex-mode)
;;     :custom (phitex-settings '(:follow "selection")))
;; or with straight.el (with straight as use-package's default, this, not :vc;
;; :nonrecursive t skips the repository's PhiTeX submodule, which this file
;; doesn't need):
;;   (use-package phitex
;;     :straight (phitex :type git :host github :repo "accl-kaust/PhiTeX-frontends"
;;                       :files ("apps/editors/emacs/*.el") :depth 1 :nonrecursive t)
;;     :hook ((LaTeX-mode latex-mode) . phitex-mode)
;;     :custom (phitex-settings '(:follow "selection")))
;; With no `phitex' on PATH, the mode asks before downloading the latest
;; release into ~/.local/bin (M-x phitex-install does the same). It needs
;; minisign and curl: the release's SHA256SUMS must verify against the
;; release key below, and the download must match it, or nothing is installed.
;; A project is its phitex.toml's folder, else
;; the file's own; one with several .tex files names its main one in
;; phitex.toml (main = "paper.tex").

;;; Code:

(require 'cl-lib)
(require 'subr-x)
(require 'jsonrpc)
(require 'map)
(require 'flymake)
(require 'url-util)

(defgroup phitex nil
  "PhiTeX's live preview."
  :group 'tex
  :prefix "phitex-")

(defvar phitex-settings nil
  "The engine's settings, a plist (:threads :main :follow :files).")

(defcustom phitex-mark-selection t
  "Whether text selected on the page is marked in its buffer.
Face `phitex-selection'.  The mark goes with the next selection, or
once the cursor moves."
  :type 'boolean
  :group 'phitex)

(defcustom phitex-dblclick-focus t
  "Whether a double-click on the page selects the source's window.
nil: the place is shown in a window, the focus left where it is."
  :type 'boolean
  :group 'phitex)

(defcustom phitex-follow-delay 0.03
  "Seconds Emacs is idle before the cursor's place is sent to the page."
  :type 'number
  :group 'phitex)

(defcustom phitex-diagnostics-delay 0.2
  "Seconds Emacs is idle before Flymake shows a build's problems.
Never between keystrokes."
  :type 'number
  :group 'phitex)

(defface phitex-selection '((t :inherit region))
  "Text selected on the page, marked in its buffer."
  :group 'phitex)

(defvar phitex-command '("phitex" "watch" "--lsp")
  "How the language server is started.")

(defvar phitex-channel "stable"
  "Which releases `phitex-install' downloads, as install.sh's PHITEX_CHANNEL:
\"stable\" (the latest release) or \"nightly\" (dev's, rebuilt each night).")

(defvar phitex-release-base nil
  "Where `phitex-install' downloads from; nil: `phitex-channel''s releases.")

(defun phitex--release-base ()
  "The download's base URL: `phitex-release-base', else the channel's."
  (or phitex-release-base
      (pcase phitex-channel
        ("stable" "https://github.com/accl-kaust/PhiTeX/releases/latest/download")
        ("nightly" "https://github.com/accl-kaust/PhiTeX/releases/download/nightly")
        (c (user-error "PhiTeX: phitex-channel is \"stable\" or \"nightly\", not %S" c)))))

(defvar phitex-release-key nil
  "The minisign public key the download is checked against; nil: the channel's
\(the releases' PhiTeX's ci/minisign.pub, the nightly's its own ci/nightly.pub,
as install.sh: a nightly is never checked against the releases' key).")

(defun phitex--release-key ()
  "The key the download's SHA256SUMS signature is checked against."
  (or phitex-release-key
      (if (equal phitex-channel "nightly")
          "RWT5jA+G82gT+bMpGqolUeaWPm6OYkLC4m6lI8G5HbUnyL3yY5UpGCYD"
        "RWS/tPWBRVVf0Y9h/ODPiO2EgZi1labeCog3siaCfIdaC9HJkDJZ8k4u")))

(defvar phitex-install-prefix "~/.local"
  "`phitex-install' puts the binary in this folder's bin/.")

;; (never from a project's file or directory variables: what runs, and what is trusted)
(dolist (v '(phitex-command phitex-channel phitex-release-base phitex-release-key phitex-install-prefix))
  (put v 'risky-local-variable t))

(defconst phitex--install-script "set -eu
base=$1 key=$2 prefix=$3 channel=$4
command -v minisign >/dev/null || { echo \"minisign is not installed: the download could not be checked\"; exit 1; }
case \"$(uname -s)\" in Linux) os=linux;; Darwin) os=macos;; *) echo \"no build for $(uname -s)\"; exit 1;; esac
case \"$(uname -m)\" in x86_64|amd64) arch=x86_64;; aarch64|arm64) arch=aarch64;; *) echo \"no build for $(uname -m)\"; exit 1;; esac
asset=phitex-$arch-$os.tar.gz
tmp=$(mktemp -d); trap 'rm -rf \"$tmp\"' EXIT
for f in SHA256SUMS SHA256SUMS.minisig \"$asset\"; do
  curl -fsSL --proto-redir '=https' -o \"$tmp/$f\" \"$base/$f\" || { echo \"could not download $base/$f\"; exit 1; }
done
minisign -Vqm \"$tmp/SHA256SUMS\" -x \"$tmp/SHA256SUMS.minisig\" -P \"$key\" || { echo \"the signature does not verify: nothing installed\"; exit 1; }
want=$(awk -v f=\"$asset\" '$2 == f || $2 == \"*\" f {print $1}' \"$tmp/SHA256SUMS\")
if command -v sha256sum >/dev/null; then got=$(sha256sum \"$tmp/$asset\" | cut -d\" \" -f1); else got=$(shasum -a 256 \"$tmp/$asset\" | cut -d\" \" -f1); fi
[ -n \"$want\" ] && [ \"$want\" = \"$got\" ] || { echo \"$asset does not match SHA256SUMS: nothing installed\"; exit 1; }
tar -xzf \"$tmp/$asset\" -C \"$tmp\"
[ -f \"$tmp/phitex\" ] || { echo \"$asset has no phitex binary\"; exit 1; }
mkdir -p \"$prefix/bin\"
cp \"$tmp/phitex\" \"$prefix/bin/.phitex.new\"; chmod 755 \"$prefix/bin/.phitex.new\"; mv -f \"$prefix/bin/.phitex.new\" \"$prefix/bin/phitex\"
data=${XDG_DATA_HOME:-$HOME/.local/share}/phitex; mkdir -p \"$data\"
printf '{\"method\": \"script\", \"prefix\": \"%s\", \"asset\": \"%s\", \"channel\": \"%s\"}\\n' \"$prefix\" \"$asset\" \"$channel\" > \"$data/install.json\"
"
  "Downloads and checks a release.
Its arguments are the base, the key, the prefix and the channel.")

(defvar phitex--install-declined nil "The download was declined in this Emacs: not asked again.")

(defun phitex-install ()
  "Ask, then download the latest phitex release, checked against its signature."
  (interactive)
  (unless (executable-find "minisign")
    (user-error "PhiTeX: installing needs minisign, to check the download's signature: install it, or phitex itself (https://phitex.org)"))
  (let ((prefix (expand-file-name phitex-install-prefix))
        (base (phitex--release-base)))
    (unless (yes-or-no-p (format "Download PhiTeX (%s) from %s into %s/bin, checked against its signature? " phitex-channel base prefix))
      (setq phitex--install-declined t)
      (user-error "PhiTeX: not downloaded"))
    (message "PhiTeX: downloading...")
    (with-temp-buffer
      (unless (eql 0 (call-process "sh" nil t nil "-c" phitex--install-script "sh" base (phitex--release-key) prefix phitex-channel))
        (user-error "PhiTeX: not installed from the %s channel (%s): %s" phitex-channel base (string-trim (buffer-string)))))
    (add-to-list 'exec-path (concat prefix "/bin"))
    (message "PhiTeX: installed in %s/bin" prefix)))

(defun phitex--ensure-binary ()
  "A `phitex' to run.
On `exec-path', in the install folder, or downloaded when the user agrees."
  (let ((name (car phitex-command))
        (bin (expand-file-name "bin" phitex-install-prefix)))
    (unless (executable-find name)
      (if (file-executable-p (expand-file-name name bin))
          (add-to-list 'exec-path bin)
        (when phitex--install-declined
          (user-error "PhiTeX: no phitex on PATH (M-x phitex-install downloads it)"))
        (phitex-install)))))

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
(defvar phitex--shown nil "The source of the text last selected on the pages, an overlay.")
(defvar phitex--shown-at nil "Where the cursor was put with `phitex--shown': moved from, the mark goes.")

(defun phitex--root ()
  (expand-file-name (or (locate-dominating-file default-directory "phitex.toml") default-directory)))

(defvar-local phitex--last-uri nil
  "This buffer's URI when it last had a file name.
`revert-buffer' clears `buffer-file-name' while it reads the file back in,
and the changes it makes then are this file's all the same.")

(defun phitex--uri (&optional file)
  (if (or file buffer-file-name)
      (let ((uri (concat "file://" (url-hexify-string (expand-file-name (or file buffer-file-name)) url-path-allowed-chars))))
        (unless file (setq phitex--last-uri uri))
        uri)
    phitex--last-uri))

(defun phitex--file (uri)
  (decode-coding-string (url-unhex-string (string-remove-prefix "file://" uri)) 'utf-8))

(defun phitex--buffers (server)
  (cl-remove-if-not (lambda (b) (eq (buffer-local-value 'phitex--server b) server)) (buffer-list)))

(defvar phitex--roots (make-hash-table :test 'eq)
  "Each server's folder, as its phitex/status says: where its watch runs.")

(defun phitex--serving (file)
  "A running server whose watch runs in a folder holding FILE (the deepest).
Compared resolved (`file-truename'), as the watch names its folder: a
file opened through a symlink is that watch's, never a second one's."
  (let ((file (file-truename (expand-file-name file))) best len)
    (maphash (lambda (s root)
               (when (and (jsonrpc-running-p s) (stringp root) (> (length root) 0)
                          (string-prefix-p (file-name-as-directory (file-truename root)) file)
                          (or (null len) (> (length root) len)))
                 (setq best s len (length root))))
             phitex--roots)
    best))

(defcustom phitex-attach 'auto
  "Whether `phitex-mode' uses a `phitex watch' already running.
`auto': the watch whose folder holds the file (as `phitex session list'
lists them: one started in a terminal), else one started here.
`always': only a running watch.  `never': always one started here."
  :type '(choice (const auto) (const always) (const never))
  :group 'phitex)

(defvar phitex--attached (make-hash-table :test #'eq)
  "The servers attached to a watch this Emacs did not start.")

(defun phitex--sessions ()
  "The running watches, as `phitex session list --json' lists them.
A phitex from before that command lists them as `phitex sessions --json'.
None with no phitex, or one too old to list them."
  (when (executable-find (car phitex-command))
    (with-temp-buffer
      (when (cl-some (lambda (args)
                       (erase-buffer)
                       (eq 0 (ignore-errors (apply #'call-process (car phitex-command) nil '(t nil) nil args))))
                     '(("session" "list" "--json") ("sessions" "--json")))
        (goto-char (point-min))
        (ignore-errors (json-parse-buffer :object-type 'plist :array-type 'list :null-object nil))))))

(defun phitex--session-for (file)
  "The running watch for FILE.
The one whose main file it is, else the deepest folder holding it.
Paths are compared resolved (`file-truename'): a file opened through a
symlink (~/Documents → ~/Seafile/Documents) is the watch's all the same."
  (let ((file (file-truename (expand-file-name file))) best)
    (dolist (s (phitex--sessions))
      (let ((root (and (stringp (plist-get s :root)) (file-truename (plist-get s :root))))
            (main (and (stringp (plist-get s :main)) (file-truename (plist-get s :main)))))
        (when (and (stringp root) (plist-get s :lsp)
                   (or (equal main file) (string-prefix-p (file-name-as-directory root) file))
                   (not (and best (equal (file-truename (plist-get best :main)) file)))
                   (or (null best) (equal main file) (> (length root) (length (file-truename (plist-get best :root))))))
          (setq best s))))
    best))

(defun phitex--connect (root &optional mode)
  "The server of the project at ROOT, started if none.
A watch already running for the folder of this buffer's file is used:
one started for a chapter that found its main file a folder up, or (by
`phitex-attach', or MODE) one started in a terminal (`phitex session list')."
  (or (let ((s (gethash root phitex--servers))) (and s (jsonrpc-running-p s) s))
      (and buffer-file-name (phitex--serving buffer-file-name))
      (let* ((mode (or mode phitex-attach))
             (session (and (not (eq mode 'never)) buffer-file-name (phitex--session-for buffer-file-name)))
             (_ (when (and (eq mode 'always) (not session))
                  (user-error "PhiTeX: no phitex watch is running for this file (phitex session list lists them)")))
             (root (if session (plist-get session :root) root))
             (lsp (plist-get session :lsp))
             (proc (if session
                       ;; (a watch started elsewhere: its language server on 127.0.0.1, by its token)
                       (make-network-process :name "phitex" :host (plist-get lsp :host) :service (plist-get lsp :port)
                                             :coding 'utf-8-emacs-unix :noquery t)
                     (let ((default-directory root))
                       (phitex--ensure-binary)
                       (make-process :name "phitex" :command phitex-command :connection-type 'pipe
                                     :coding 'utf-8-emacs-unix :noquery t
                                     :stderr (get-buffer-create "*phitex stderr*")))))
             (s (make-instance 'jsonrpc-process-connection :name (format "phitex %s" root) :process proc
                               :request-dispatcher #'phitex--request
                               :notification-dispatcher #'phitex--notification
                               :on-shutdown (lambda (s) (phitex--ended s root)))))
        (puthash root s phitex--servers)
        ;; (attached: its folder known now, before its first phitex/status,
        ;; so the project's other buffers join this connection)
        (when session (puthash s t phitex--attached) (puthash s root phitex--roots))
        (let* ((init (jsonrpc-request s :initialize
                                      (list :processId (emacs-pid) :rootUri (phitex--uri root)
                                            :capabilities '(:window (:showDocument (:support t) :workDoneProgress t)
                                                            :workspace (:configuration t)
                                                            :general (:positionEncodings ["utf-16"]))
                                            ;; (:phitexCursor: phitex/cursor is sent here, so lsp-mode's or
                                            ;; Eglot's documentHighlight makes no second forward search)
                                            :initializationOptions (append phitex-settings (list :client phitex--client :phitexCursor t)
                                                                           (and lsp (list :token (plist-get lsp :token)))))))
               (protocol (map-nested-elt init '(:capabilities :experimental :phitex :protocol))))
          ;; (a phitex older than this file's protocol: said, the watch kept)
          (unless (and (numberp protocol) (>= protocol phitex--protocol))
            (display-warning 'phitex
                             (format "phitex %s is too old for this phitex.el.  Run `phitex upgrade' in a terminal, then M-x phitex-restart"
                                     (or (map-nested-elt init '(:serverInfo :version)) "(of an unknown version)"))
                             :error)))
        (jsonrpc-notify s :initialized (make-hash-table))
        (when session (message "PhiTeX: attached to the watch of %s (pid %s)" (plist-get session :main) (plist-get session :pid)))
        s)))

(defun phitex--ended (server root)
  "SERVER exited: its buffers told; said unless it was asked to stop."
  (remhash root phitex--servers)
  (remhash server phitex--roots)
  (dolist (b (phitex--buffers server))
    (with-current-buffer b (setq phitex--server nil)))
  (cond ((gethash server phitex--attached)
         (remhash server phitex--attached)
         (message "PhiTeX: detached from the watch in %s (it keeps running where it was started)" root))
        ((not (equal (plist-get phitex--status :state) "stopped"))
         (message "PhiTeX: phitex watch exited (M-x phitex-restart starts it again)")))
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
  "This buffer closed for its watch; the watch stopped with its last buffer."
  (let ((s phitex--server))
    (when (and s (jsonrpc-running-p s))
      (jsonrpc-notify s :textDocument/didClose (list :textDocument (list :uri (phitex--uri))))
      (setq phitex--server nil)
      ;; (no buffer left on it, the mode off or the buffer killed: the
      ;; watch ends, as phitex-stop ends it)
      (unless (cl-remove (current-buffer) (phitex--buffers s))
        (setq phitex--status (list :state "stopped"))
        (ignore-errors (jsonrpc-shutdown s)))))
  (setq phitex--server nil))

(defvar-local phitex--selected nil
  "Whether the last cursor sent had a region (its end clears the page's marks).")

(defun phitex--cursor ()
  "Tell the watch where the cursor and its region are, once Emacs pauses.
The latest after `phitex-follow-delay' idle: the cursor's word marked
on the page, the region's text too (an empty range clearing it); as
`phitex-settings' :follow says (\"cursor\": every move; \"selection\":
only a region's, and as it ends; \"dblclick\": never)."
  (when phitex--timer (cancel-timer phitex--timer))
  ;; (the page's selection marked here goes once the cursor moves)
  (when (and phitex--shown (eq (overlay-buffer phitex--shown) (current-buffer))
             (not (eql (point) phitex--shown-at)))
    (delete-overlay phitex--shown)
    (setq phitex--shown nil))
  (let* ((region (use-region-p))
         (ended (and phitex--selected (not region))))
    (when (and phitex--server
               (pcase (or (plist-get phitex-settings :follow) "cursor")
                 ("cursor" t)
                 ("selection" (or region ended))))
      (let ((buf (current-buffer)))
        (setq phitex--timer
              (run-with-idle-timer
               phitex-follow-delay nil
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
        ;; (`phitex-attach' connected it already: the same connection, never a
        ;; second one to the same watch)
        (unless (and phitex--server (jsonrpc-running-p phitex--server))
          (setq phitex--server (phitex--connect (phitex--root))))
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

(defun phitex--notification (server method params)
  (pcase method
    ('textDocument/publishDiagnostics
     (when-let* ((b (find-buffer-visiting (phitex--file (plist-get params :uri)))))
       (with-current-buffer b
         (setq phitex--diags (append (plist-get params :diagnostics) nil))
         (phitex--diags-soon))))
    ('phitex/status
     (when (plist-get params :root) (puthash server (plist-get params :root) phitex--roots))
     (setq phitex--status params) (force-mode-line-update t))
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
         ;; (a double-click takes the focus; text selected on the pages
         ;; (takeFocus false) is shown, marked, in the window it is in)
         ;; (the watch names the file resolved: the buffer visiting it
         ;; through a symlink is the one shown, without a warning each time)
         (let* ((buf (let ((find-file-suppress-same-file-warnings t))
                       (find-file-noselect (phitex--file (plist-get params :uri)))))
                (win (if (and (eq (plist-get params :takeFocus) t) phitex-dblclick-focus)
                         (progn (pop-to-buffer buf) (selected-window))
                       (display-buffer buf))))
           (when sel
             (with-current-buffer buf
               (let ((beg (phitex--point (plist-get sel :start)))
                     (end (phitex--point (plist-get sel :end))))
                 (set-window-point win beg)
                 (when (eq win (selected-window)) (goto-char beg))
                 (when phitex--shown (delete-overlay phitex--shown) (setq phitex--shown nil))
                 (when (and phitex-mark-selection (< beg end))
                   (setq phitex--shown (make-overlay beg end) phitex--shown-at beg)
                   (overlay-put phitex--shown 'face 'phitex-selection)))))))
       (list :success t)))
    ('workspace/configuration (vector (or phitex-settings :json-false)))
    ((or 'window/workDoneProgress/create 'client/registerCapability) nil)
    (_ (jsonrpc-error :code -32601 :message (format "%s: not handled" method)))))

(defun phitex--line-starts (lines)
  "Each of LINES (LSP, from 0) mapped to its start.
Found in one pass down the buffer."
  (let ((starts (make-hash-table)) (at 0))
    (save-excursion
      (goto-char (point-min))
      (dolist (l (sort (delete-dups (copy-sequence lines)) #'<))
        (forward-line (- l at))
        (setq at l)
        (puthash l (point) starts)))
    starts))

(defun phitex--point-from (starts pos)
  "LSP position POS as a point, its line's start from STARTS."
  (save-excursion
    (goto-char (gethash (plist-get pos :line) starts (point-max)))
    (let ((col (plist-get pos :character)))
      (while (and (> col 0) (not (eolp)))
        (setq col (- col (if (> (char-after) #xFFFF) 2 1)))
        (forward-char)))
    (point)))

(defun phitex--flymake (report &rest _)
  "Flymake's backend: the server's diagnostics, now and as they come (REPORT).
Their places found in one pass down the buffer (one walk from the top for
each cost ~13 ms a build for 50 of them in a long paper)."
  (setq phitex--report report)
  (let* ((ranges (mapcar (lambda (d) (plist-get d :range)) phitex--diags))
         (starts (phitex--line-starts
                  (mapcan (lambda (r) (list (plist-get (plist-get r :start) :line) (plist-get (plist-get r :end) :line))) ranges))))
    (funcall report
             (cl-mapcar (lambda (d r)
                          (let* ((beg (phitex--point-from starts (plist-get r :start)))
                                 (end (max (1+ beg) (phitex--point-from starts (plist-get r :end)))))
                            (flymake-make-diagnostic (current-buffer) beg (min end (point-max))
                                                     (pcase (plist-get d :severity) (1 :error) (2 :warning) (_ :note))
                                                     (plist-get d :message))))
                        phitex--diags ranges))))

(defvar-local phitex--diags-timer nil
  "The pending Flymake update: diagnostics shown once typing pauses.")

(defun phitex--diags-soon ()
  "Show the diagnostics once Emacs is idle, never between keystrokes.
After `phitex-diagnostics-delay' seconds."
  (when phitex--diags-timer (cancel-timer phitex--diags-timer))
  (let ((buf (current-buffer)))
    (setq phitex--diags-timer
          (run-with-idle-timer phitex-diagnostics-delay nil
                               (lambda ()
                                 (when (buffer-live-p buf)
                                   (with-current-buffer buf
                                     (setq phitex--diags-timer nil)
                                     (when phitex--report (phitex--flymake phitex--report)))))))))

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

(defun phitex-attach ()
  "Attach this buffer to a `phitex watch' already running for its file.
One started in a terminal, as `phitex session list' lists them."
  (interactive)
  (when (and phitex--server (jsonrpc-running-p phitex--server))
    (jsonrpc-shutdown phitex--server))
  (setq phitex--server (phitex--connect (phitex--root) 'always))
  ;; (the mode on already: the buffer opened on the new connection)
  (if phitex-mode (phitex--open) (phitex-mode 1)))

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

(defun phitex-doctor ()
  "Check PhiTeX's setup for this buffer, each finding on its own line.
Which phitex.el is loaded (and whether it was loaded whole), the phitex
on PATH and its version, the running watches, and this buffer's file,
watch and connection."
  (interactive)
  (let* ((buf (current-buffer))
         (file (buffer-file-name buf))
         (exe (executable-find (car phitex-command)))
         (version (and exe (with-temp-buffer
                             (and (eq 0 (ignore-errors (call-process exe nil t nil "--version")))
                                  (buffer-string)))))
         (sessions (phitex--sessions))
         (session (and file (phitex--session-for file)))
         (server (buffer-local-value 'phitex--server buf))
         (unbound (cl-remove-if #'boundp '(phitex-mark-selection phitex-dblclick-focus phitex-follow-delay
                                          phitex-diagnostics-delay phitex-attach phitex-command)))
         (ok 0) (bad 0))
    (with-current-buffer (get-buffer-create "*phitex-doctor*")
      (let ((inhibit-read-only t))
        (erase-buffer)
        (cl-flet ((line (good text &optional fix)
                    (if good (cl-incf ok) (cl-incf bad))
                    (insert (if good "  ✓ " "  ✗ ") text "\n")
                    (when (and fix (not good)) (insert "      → " fix "\n"))))
          (insert "PhiTeX doctor  " (format-time-string "%F %T") "\n\n")
          (insert "This Emacs\n")
          (line t (format "Emacs %s" emacs-version))
          (line t (format "phitex.el loaded from %s" (or (symbol-file 'phitex-mode 'defun) "?")))
          (line (null unbound)
                (if unbound (format "phitex.el loaded only in part: %s unset" (mapconcat #'symbol-name unbound ", "))
                  "phitex.el loaded whole")
                "an older and a newer phitex.el mixed in this session: restart Emacs")
          (insert "\nThe phitex program\n")
          (line exe (if exe (format "%s" exe) (format "%s not on PATH (exec-path)" (car phitex-command)))
                "M-x phitex-install, or add its folder to exec-path")
          (when exe
            (line version (if version (string-trim (car (split-string version "\n"))) "phitex --version failed")
                  "run phitex --version in a terminal")
            (when version
              (let ((proto (and (string-match "editor protocol \\([0-9]+\\)" version)
                                (string-to-number (match-string 1 version)))))
                (line (or (null proto) (= proto phitex--protocol))
                      (format "editor protocol: phitex %s, phitex.el %s" (or proto "?") phitex--protocol)
                      (if (and proto (> proto phitex--protocol)) "update phitex.el" "run phitex upgrade")))))
          (insert "\nRunning watches (phitex session list)\n")
          (if (null sessions)
              (line (not (eq phitex-attach 'always)) "none"
                    "start one in a terminal: phitex watch FILE.tex")
            (dolist (s sessions)
              (insert (format "  %s%s  pid %s, %s\n" (if (equal s session) "→ " "  ")
                              (plist-get s :main) (plist-get s :pid) (or (plist-get s :version) "?")))))
          (insert (format "\nThis buffer (%s)\n" (buffer-name buf)))
          (line file (if file (format "file %s" file) "no file") "save the buffer to a file")
          (when file
            (let ((true (file-truename file)))
              (unless (equal true (expand-file-name file))
                (line t (format "resolved through a symlink to %s" true))))
            (line (or session (not (eq phitex-attach 'always)))
                  (if session (format "its watch: %s (folder %s)" (plist-get session :main) (plist-get session :root))
                    (format "no running watch holds it (phitex-attach is %s: %s)" phitex-attach
                            (if (eq phitex-attach 'never) "one is started here" "one is started here by phitex-mode")))
                  "start one: phitex watch FILE.tex, then M-x phitex-attach"))
          (line (buffer-local-value 'phitex-mode buf)
                (if (buffer-local-value 'phitex-mode buf) "phitex-mode on" "phitex-mode off") "M-x phitex-mode")
          (when (buffer-local-value 'phitex-mode buf)
            (line (and server (jsonrpc-running-p server))
                  (if (and server (jsonrpc-running-p server))
                      (format "connected%s, folder %s" (if (gethash server phitex--attached) " (attached)" "")
                              (or (gethash server phitex--roots) "?"))
                    "not connected")
                  "M-x phitex-restart, or M-x phitex-attach"))
          (insert (format "\n%d fine, %d to look at\n" ok bad)))
        (special-mode)
        (goto-char (point-min))))
    (pop-to-buffer "*phitex-doctor*")))

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
