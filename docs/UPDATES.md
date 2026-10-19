# Standalone updates

This applies to the compiled CLI/TUI on Windows, macOS, and Linux. Desktop
packages keep their existing installer-based update flow. Source checkouts
still use Bun and uv; a compiled release never falls back to uv.

## Layout and selection

Release archives still contain `meshtalk` and `meshtalk-backend` (`.exe` on
Windows). This is intentional: older, already-shipped updaters require that
layout to install a release containing the new updater.

A managed installation contains:

```text
meshtalk[.exe]                         stable entry point
.meshtalk-install.json                 current/pending release selection
.meshtalk-install.json.bak             recovery selection
.meshtalk-install-lock.sqlite          installation lock
.meshtalk-usage/*.json                 launcher/backend process records
versions/release-<id>/
  meshtalk[.exe]
  meshtalk-backend[.exe]
  .meshtalk-release.json               version and both file digests
```

The stable entry point is the original compiled launcher, not a shell script.
It resolves the selected release to a physical directory and hands execution
to its launcher. A launcher inside a release always finds its backend beside
itself, even if another window later selects a different release. Unix handoff
uses `execve` to preserve the terminal; the Windows bootstrap waits and returns
the child command's exit status.

Selection uses a schema-1 JSON file on every OS rather than Windows-specific
junctions. The file is written to a temporary sibling, flushed, then renamed
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
and no legacy process needs it. The stable root launcher itself is retained.

## Existing installations and recovery

- A complete flat installation is copied into a verified release on the first
  launch of the new launcher. Its running binaries are not moved or overwritten.
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

Managed uninstall delegates release cleanup to the same locked implementation
and preserves unrelated files, including in a shared `~/.local/bin`. If the
bootstrap cannot execute, the scripts leave release directories for inspection
rather than guessing their ownership. The small lock database is intentionally
retained so concurrent installers cannot acquire different lock-file inodes.

Updates do not migrate or delete `MESHTALK_DATA_DIR`, identity keys, message
history, settings, or consent. There is no wire-protocol or cryptography change.
