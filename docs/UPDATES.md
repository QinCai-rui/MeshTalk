# Standalone updates

This applies to the compiled CLI/TUI on Windows, macOS, and Linux. Desktop
packages keep their existing installer-based update flow. Source checkouts
still use Bun and uv; a compiled release never falls back to uv.

## Layout and selection

Release archives still contain `meshtalk` and `meshtalk-backend` (`.exe` on
Windows). This is intentional: older, already-shipped updaters require that
layout to install a release containing the new updater.

A managed installation keeps complete releases and update state together:

```text
.meshtalk-install.json                 current/pending release selection
.meshtalk-install.json.bak             recovery selection
.meshtalk-install-lock.sqlite          installation lock
.meshtalk-usage/*.json                 launcher/backend process records
versions/release-<id>/
  meshtalk[.exe]
  meshtalk-backend[.exe]
  .meshtalk-release.json               version and both file digests
```

The existing command path stays the same, but its implementation differs where
Windows compatibility requires it:

| Installation | Command entry | What updates |
| --- | --- | --- |
| Linux/macOS, including shared `~/.local/bin` | `meshtalk` symlink through `.meshtalk-current` to a release | The complete launcher and backend |
| Windows dedicated folder | Existing folder becomes a junction through `current` to a release | The complete launcher and backend |
| Windows shared folder, or a flat installation awaiting migration | Existing executable forwards to the selected release | The payload immediately; the forwarding executable once all instances have stopped |

There is **no permanently retained old launcher**. Unix switches an atomically
renamed symlink. Windows retargets its `current` junction in place, rather than
deleting it before creating a replacement. Its release store is a hidden sibling
named `.<installation-folder>.meshtalk-install`, outside the visible junction.
State, the lock, and process records therefore never move when a release changes.

A launcher resolves its executable to a physical release before finding the
backend beside it. Retargeting a command does not mix an already-running
launcher with another release's backend. Unix handoff uses `execve` to preserve
the terminal; a Windows compatibility forwarder waits and returns its child's
exit status.

Selection also uses a schema-1 JSON file on every OS. It is written to a temporary
sibling, flushed, then renamed
over its predecessor without unlinking the predecessor first. An exclusive
SQLite write transaction serializes installation, selection, registration, and
cleanup. SQLite releases the lock if the installer crashes. The database holds
no messages or identity data.

## Download, activation, and cleanup

Downloads verify the GitHub-provided SHA-256 digest and validate the archive's
paths and required regular files. Both binaries are copied into a staging
directory on the installation filesystem, hashed, then published together as a
release. The pending selection is published only after this completes. A failed
download or copy does not replace either active executable.

The CLI may download an update while another instance is running. Activation
waits for a suitable launch or explicit restart. Restart checks for other
launcher processes **before** stopping the shared backend. If process inspection
fails, activation is deferred rather than assuming no other window exists.

If a crash interrupts publication between the selector and its command link,
the next launch reconciles the link to the verified selection before dispatching.

For a shared Windows folder, an executable from the downloaded release waits
for the installation's processes to exit, then refreshes only MeshTalk's own
entry executable. It never replaces a running root executable. It rechecks the
latest selection, so a superseding download is not lost. The wait is bounded
to five minutes; later exits retry. A deliberately persistent backend must also
be stopped, or the installer can be rerun with explicit automatic-close permission.

The previous release remains available until the new launcher reaches its own
entry point. After that acknowledgement, cleanup deletes unused managed
releases. Process records protect launchers, detached backends, and replacement
children during handoff. Native process inspection additionally protects older
untracked launchers and bundled backend worker processes. An inaccessible
process, malformed usage record, or unavailable process listing defers cleanup.
An apparently reused live PID may keep an old release longer; deletion is
conservative rather than risking a running instance.

Cleanup runs at startup, on normal exit, and every 30 seconds while a managed
launcher runs. After a crash, the next launch collects stale process records
and owned staging directories. Cleanup never recursively removes an arbitrary
`versions` directory, follows directory links, or removes unmarked directories.
The obsolete root backend is also removed once the managed release is confirmed
and no legacy process needs it. A Windows compatibility entry is refreshed to
the selected version, not exempted from future launcher fixes.

## Existing installations and recovery

- A complete flat installation is copied into a verified release on the first
  launch of the new launcher. Unix then replaces the command's directory entry
  with a symlink, without modifying the running file's bytes. Windows keeps its
  existing executable until an offline refresh or dedicated-folder migration.
- Dedicated Windows migration requires all relevant instances to stop. The
  installer records a recovery journal before moving the old folder aside; it
  restores it if publication fails. If interrupted by a crash, rerun the installer
  to finish recovery. The retired folder is deleted only after the new launcher
  confirms startup and its old process records and native executable paths are
  no longer live.
- Shared Windows folders are never converted into directory junctions. Their
  unrelated files and existing shortcuts remain in place. If someone adds files
  through an already-managed junction, further switches refuse rather than hide
  or delete those files.
- Windows updates staged by older releases in `pending-update.json` are imported
  only for the matching installation and only when their pair is complete.
  Failed imports preserve the old marker, staged files, and installed binaries.
- The earlier `.meshtalk-current.json` layout is imported after checking its
  recorded hashes. Only its explicitly identified legacy release is eligible
  for eventual removal; unrelated directories remain untouched.
- Read-only installations can still run their existing complete release. They
  cannot migrate, install updates, or write process records without write access.
- An incomplete pending update does not prevent launching a verified current
  release. Download the update again to replace the failed pending selection.
- A damaged current selection can recover its verified backup. An explicit
  installer run can repair a damaged selector, backend, or stable entry point.
  Repair creates a fresh release beside damaged files rather than overwriting
  files another process might still use.

The Bash and PowerShell installers invoke the downloaded launcher's protocol-1
`--install-from <directory> --install-dir <root>` operation. They do not delete
existing versions before installing. Historical releases without this protocol
can still be installed into a separate flat directory; they cannot overwrite a
managed installation. Explicitly uninstall first if a historical downgrade is
necessary. Historical installers/updaters already running old code cannot gain
the new update guarantees retroactively.

### Closing MeshTalk automatically

Pass `--close-running` to the Bash installer or `-CloseRunning` to the PowerShell
installer to explicitly permit closing MeshTalk for installation or uninstall.
Generic `--yes`/`-Yes` does **not** grant this permission. Active sessions and file
transfers will be interrupted.

The helper first requests authenticated backend shutdown, which lets connected
TUI windows exit cleanly. Remaining processes are checked against the selected
installation's physical paths, user ownership, and process identity. Unix uses
SIGTERM; Windows requests a supported window close. The helper does not force
termination or kill by executable name alone. Backend shutdown closes every TUI
window sharing that backend; process-level close requests are restricted to the
selected installation.
An older Windows console process that does not exit after backend shutdown may
need to be closed manually. If any relevant process remains or cannot be
verified, the installer aborts instead of replacing its files.

Managed uninstall delegates release cleanup to the same locked implementation
and preserves unrelated files, including in a shared `~/.local/bin`. If the
launcher cannot execute, the scripts leave release directories for inspection
rather than guessing their ownership. The small lock database is intentionally
retained so concurrent installers cannot acquire different lock-file inodes.

Updates do not migrate or delete `MESHTALK_DATA_DIR`, identity keys, message
history, settings, or consent. There is no wire-protocol or cryptography change.
