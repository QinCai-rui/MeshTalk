"""Storage location management for MeshTalk persistent data.

Covers the migratable payload that lives under the storage directory:
the messages database (``meshtalk.db``), received/sent file transfers
(``files/``), and the peer identity (``identity.json``).

Runtime files (IPC socket/token, pid file, logs, updater state) always stay
in the data directory (``MESHTALK_DATA_DIR`` or ``~/.meshtalk``) and are
never copied or deleted by migration.

All mutating helpers follow abort semantics: any copy/verification failure
raises, the caller must leave the old location active, and partially copied
files at the destination are removed best-effort (only files this migration
created, never pre-existing destination content).
"""

from __future__ import annotations

import hashlib
import os
import secrets
import shutil
import sqlite3
import stat
import tempfile
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote

DB_FILENAME = "meshtalk.db"
IDENTITY_FILENAME = "identity.json"
FILES_SUBDIR = "files"
STORAGE_ENV_VAR = "MESHTALK_STORAGE_DIR"

# Files that belong to the running backend/launcher and must never be
# migrated or deleted. settings.json also stays: it anchors the data dir
# and records the storage_dir override.
RUNTIME_FILES = frozenset(
    {
        "settings.json",
        "settings.json.tmp",
        "meshtalk.sock",
        "meshtalk.port",
        "meshtalk.token",
        "meshtalk.pid",
        "backend.log",
        "update-restart-path",
        "pending-update.json",
        "update-helper.log",
        ".data_dir",
    }
)


def _is_link(info: os.stat_result) -> bool:
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    )


@contextmanager
def _directory(path: Path, *, create: bool = False, writable: bool = False):
    """Pin a directory without following links; only new directories get mode 0700.

    POSIX operations stay relative to the opened directory even if an ancestor
    is renamed. Windows has no equivalent dir_fd APIs, so it checks reparse
    points but still depends on the user's directory ACLs against path races.
    """
    path = Path(os.path.abspath(path))
    descriptor = None
    try:
        if os.name != "nt":
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
            descriptor = os.open(path.anchor, flags)
            for name in path.parts[1:]:
                if create:
                    try:
                        os.mkdir(name, mode=0o700, dir_fd=descriptor)
                    except FileExistsError:
                        pass
                child = os.open(name, flags, dir_fd=descriptor)
                os.close(descriptor)
                descriptor = child
            if writable:
                info = os.fstat(descriptor)
                # A shared, readable directory is fine. A different owner or
                # non-sticky shared writer could replace entries during commit
                # or cleanup. Refuse it instead of chmod'ing a user's folder.
                if info.st_uid != os.getuid() or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX):
                    raise PermissionError("private storage requires an owned directory without shared write access")
        else:
            current = Path(path.anchor)
            for name in path.parts[1:]:
                current /= name
                if create:
                    try:
                        current.mkdir(mode=0o700)
                    except FileExistsError:
                        pass
                info = current.lstat()
                if _is_link(info) or not stat.S_ISDIR(info.st_mode):
                    raise OSError("private storage directory must not be a link")
        yield path, descriptor
    finally:
        if descriptor is not None:
            os.close(descriptor)


def ensure_private_directory(path: Path) -> None:
    """Create missing directories privately without changing existing modes."""
    with _directory(path, create=True):
        pass


def _entry(directory, name: str):
    path, descriptor = directory
    return (name, {"dir_fd": descriptor}) if descriptor is not None else (path / name, {})


def _entry_stat(directory, name: str) -> os.stat_result | None:
    entry, options = _entry(directory, name)
    try:
        return os.stat(entry, follow_symlinks=False, **options)
    except FileNotFoundError:
        return None


def _same_file(first: os.stat_result | None, second: os.stat_result | None) -> bool:
    return first is not None and second is not None and (first.st_dev, first.st_ino) == (second.st_dev, second.st_ino)


def _unlink_owned(directory, name: str, expected: os.stat_result) -> None:
    if _same_file(_entry_stat(directory, name), expected):
        entry, options = _entry(directory, name)
        os.unlink(entry, **options)


@contextmanager
def _private_output(dest: Path, *, replace: bool):
    """Stage mode-0600 bytes exclusively, then publish without clobbering copies."""
    with _directory(dest.parent, create=True, writable=True) as directory:
        previous = _entry_stat(directory, dest.name)
        if previous is not None:
            if not replace:
                raise FileExistsError(f"destination already contains '{dest.name}'")
            if _is_link(previous) or not stat.S_ISREG(previous.st_mode):
                raise OSError("private storage destination must be a regular file, not a link")
            if os.name != "nt" and previous.st_uid != os.getuid():
                raise PermissionError("private storage destination belongs to another user")
        name = f".{dest.name}.{secrets.token_hex(16)}.tmp"
        entry, options = _entry(directory, name)
        descriptor = os.open(entry, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600, **options)
        owned = os.fstat(descriptor)
        try:
            yield descriptor
            os.fsync(descriptor)
            os.close(descriptor)
            descriptor = None
            current = _entry_stat(directory, dest.name)
            if previous is None:
                # link() is an atomic no-replace publication, including when
                # a dangling symlink or a competing file appears mid-copy.
                target, target_options = _entry(directory, dest.name)
                os.link(entry, target, src_dir_fd=options.get("dir_fd"), dst_dir_fd=target_options.get("dir_fd"), follow_symlinks=False)
            else:
                if not _same_file(previous, current) or _is_link(current):
                    raise FileExistsError("private storage destination changed during write")
                target, _ = _entry(directory, dest.name)
                os.replace(entry, target, src_dir_fd=options.get("dir_fd"), dst_dir_fd=options.get("dir_fd"))
        finally:
            if descriptor is not None:
                os.close(descriptor)
            try:
                _unlink_owned(directory, name, owned)
            except OSError:
                pass


def write_private_text(dest: Path, text: str) -> None:
    """Atomically replace an owned regular file with private UTF-8 text."""
    with _private_output(dest, replace=True) as descriptor:
        with os.fdopen(os.dup(descriptor), "w", encoding="utf-8") as handle:
            handle.write(text)


@contextmanager
def _private_input(source: Path, *, restrict: bool = False):
    with _directory(source.parent) as directory:
        entry, options = _entry(directory, source.name)
        before = _entry_stat(directory, source.name)
        if before is None:
            raise FileNotFoundError(source)
        if _is_link(before) or not stat.S_ISREG(before.st_mode):
            raise OSError("private storage source must be a regular file, not a link")
        descriptor = os.open(entry, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0), **options)
        try:
            info = os.fstat(descriptor)
            if not _same_file(before, info) or not stat.S_ISREG(info.st_mode):
                raise OSError("private storage source changed during open")
            if restrict and os.name != "nt":
                if info.st_uid != os.getuid() or info.st_nlink != 1:
                    raise PermissionError("private settings must be an owned, unlinked regular file")
                os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "rb", closefd=False) as handle:
                yield handle
        finally:
            os.close(descriptor)


def read_private_text(source: Path, *, restrict: bool = False) -> str:
    """Read a regular file without following links, optionally hardening old modes."""
    with _private_input(source, restrict=restrict) as handle:
        return handle.read().decode("utf-8")


def resolve_target_dir(raw: str, *, base: Path | None = None) -> Path:
    """Resolve a candidate storage/files directory without touching the filesystem.

    Used to run same-location and nesting checks *before* ``validate_target_dir``
    creates the directory, so a rejected target never leaves an empty tree behind.
    """
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("path must be a non-empty string")
    cleaned = raw.strip().strip('"').strip("'")
    candidate = Path(cleaned).expanduser()
    if not candidate.is_absolute():
        anchor = base if base is not None else Path.cwd()
        candidate = anchor / candidate
    try:
        return candidate.resolve()
    except OSError:
        return candidate.absolute()


def validate_target_dir(raw: str, *, base: Path | None = None) -> Path:
    """Validate a candidate storage/files directory and return its absolute path.

    Creates the directory (including parents) and proves writability with a
    temporary file. Raises ValueError when unusable. Callers should run
    ``resolve_target_dir`` geometry checks first when a rejection must not
    create the directory.
    """
    candidate = resolve_target_dir(raw, base=base)
    try:
        ensure_private_directory(candidate)
        with tempfile.NamedTemporaryFile(dir=candidate, prefix=".meshtalk-", delete=True) as probe:
            probe.write(b"test")
            probe.flush()
    except Exception as exc:
        raise ValueError(f"Cannot use directory '{candidate}': {exc}") from exc
    return candidate.resolve() if candidate.exists() else candidate


def same_location(first: Path, second: Path) -> bool:
    """Return True when two paths resolve to the same directory."""
    try:
        return os.path.samefile(first, second)
    except OSError:
        return os.path.normcase(os.path.abspath(first)) == os.path.normcase(os.path.abspath(second))


def _resolved_text(path: Path) -> str:
    try:
        resolved = path.resolve()
    except Exception:
        resolved = path.absolute()
    return os.path.normcase(str(resolved))


def locations_nested(first: Path, second: Path) -> bool:
    """Return True when two locations are identical or one contains the other.

    Paths are resolved (symlinks, ``..``, case/separators) before comparing,
    so nesting is caught even when spelled differently. Used to reject a
    migration target that would be deleted along with the old location
    during post-verification cleanup.
    """
    return location_contains(first, second) or location_contains(second, first)


def location_contains(parent: Path, child: Path) -> bool:
    """Return True when child is parent or lives inside parent."""
    parent_text, child_text = _resolved_text(parent), _resolved_text(child)
    return child_text == parent_text or child_text.startswith(parent_text.rstrip(os.sep) + os.sep)


def dir_has_content(path: Path) -> bool:
    """Return True when a directory contains any non-runtime file or symlink.

    Runtime names are only ignored at the top level (the storage root).
    Empty subdirectories do not count, so a target left with only empty
    folders (for example after an aborted copy) is still reusable.
    """

    def check(directory: Path, *, top: bool) -> bool:
        try:
            entries = list(directory.iterdir())
        except OSError:
            return False
        for entry in entries:
            if top and entry.name in RUNTIME_FILES:
                continue
            if entry.is_dir() and not entry.is_symlink():
                if check(entry, top=False):
                    return True
                continue
            return True
        return False

    return check(path, top=True)


def copy_tree_merge(src: Path, dst: Path) -> list[str]:
    """Copy all files under src into dst (merge), returning copied relative paths.

    Refuses to overwrite a file that already exists at the destination: a
    collision means the destination is not a safe migration target, and
    overwriting (then deleting on abort) would destroy pre-existing data.
    Raises on the first failure after best-effort removal of files and
    directories created by this call, so a failed copy never leaves a partial
    merge behind.
    """
    copied: list[str] = []
    created_dirs: list[Path] = []

    def ensure_dir(path: Path) -> None:
        missing: list[Path] = []
        current = path
        while not current.exists() and current != current.parent:
            missing.append(current)
            current = current.parent
        ensure_private_directory(path)
        created_dirs.extend(missing)

    try:
        if src.is_symlink():
            raise OSError("migration source must not be a link")
        if not src.is_dir():
            return copied
        ensure_dir(dst)
        for root, dirs, files in os.walk(src):
            rel_root = Path(root).relative_to(src)
            target_root = dst / rel_root if str(rel_root) != "." else dst
            # Do not descend into links to unrelated source directories.
            dirs[:] = sorted(name for name in dirs if not (Path(root) / name).is_symlink())
            ensure_dir(target_root)
            for name in files:
                # Runtime files are only special at the storage root. Nested
                # files (e.g. a received attachment named "settings.json")
                # are user data and must be copied like any other file.
                if str(rel_root) == "." and name in RUNTIME_FILES:
                    continue
                source = Path(root) / name
                rel = str((rel_root / name) if str(rel_root) != "." else Path(name))
                target = dst / rel
                if target.exists() or target.is_symlink():
                    raise FileExistsError(f"destination already contains '{rel}'")
                ensure_dir(target.parent)
                copy_file(source, target)
                copied.append(rel)
    except Exception:
        for rel in reversed(copied):
            try:
                (dst / rel).unlink()
            except OSError:
                pass
        for directory in sorted(created_dirs, key=lambda item: len(item.parts), reverse=True):
            try:
                directory.rmdir()
            except OSError:
                pass
        raise
    return copied


def copy_file(source: Path, dest: Path) -> None:
    """Copy regular-file bytes privately and atomically, never replacing dest.

    Do not copy source permissions: even a legacy shared source must produce
    an owner-only copy. Content verification remains the caller's job.
    """
    with _private_input(source) as reader:
        with _private_output(dest, replace=False) as descriptor:
            with os.fdopen(os.dup(descriptor), "wb") as writer:
                shutil.copyfileobj(reader, writer, length=1024 * 1024)


def _file_digest(path: Path) -> str:
    """Return the SHA-256 hex digest of a file, streaming so large files stay bounded."""
    hasher = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def verify_file_copy(source: Path, target: Path) -> str | None:
    """Verify a single copied file by content. Returns None when identical, else a reason."""
    try:
        if not target.is_file():
            return "missing after copy"
        if source.stat().st_size != target.stat().st_size:
            return "size mismatch after copy"
        if _file_digest(source) != _file_digest(target):
            return "content mismatch after copy"
    except OSError as exc:
        return f"cannot verify: {exc}"
    return None


def verify_tree_copy(src: Path, dst: Path, copied: list[str]) -> list[str]:
    """Verify copied files match their sources byte-for-byte. Returns error strings.

    Compares SHA-256 digests rather than sizes alone, so same-size corruption
    introduced during the copy is caught before the source is deleted.
    """
    problems: list[str] = []
    for rel in copied:
        problem = verify_file_copy(src / rel, dst / rel)
        if problem:
            problems.append(f"{problem}: {rel}")
    return problems


def sqlite_integrity_ok(db_path: Path) -> str | None:
    """Run PRAGMA integrity_check on a SQLite file. Returns None when OK, else details."""
    try:
        # Percent-encode the path: a literal '?' or '#' in a Windows path would
        # otherwise be parsed as URI query/fragment and abort a valid migration.
        uri = f"file:{quote(str(db_path))}?mode=ro"
        connection = sqlite3.connect(uri, uri=True, timeout=10)
        try:
            rows = connection.execute("PRAGMA integrity_check").fetchall()
        finally:
            connection.close()
    except Exception as exc:
        return f"cannot open database copy: {exc}"
    if rows != [("ok",)]:
        detail = "; ".join(str(row[0]) for row in rows[:5])
        return f"integrity check failed: {detail}"
    return None


def delete_tree_contents(base: Path, *, remove_base: bool = False) -> list[str]:
    """Delete everything under base except runtime files. Returns error strings."""
    problems: list[str] = []
    if not base.is_dir():
        return problems
    for entry in list(base.iterdir()):
        if entry.name in RUNTIME_FILES:
            continue
        try:
            if entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry)
            else:
                entry.unlink()
        except OSError as exc:
            problems.append(f"cannot delete {entry}: {exc}")
    if remove_base:
        try:
            base.rmdir()
        except OSError as exc:
            problems.append(f"cannot remove directory {base}: {exc}")
    return problems


async def _rollback_db_switch(
    *,
    db,
    file_manager,
    previous_db_path: Path,
    previous_key: bytes | None,
    previous_data_dir: Path,
) -> str | None:
    """Best-effort rollback to the previous database location.

    Reopens the previous database (restoring its encryption key when given)
    and restores the file manager path. Returns None when the old location
    is live again, otherwise details of what failed so the caller can report
    that the backend may need a restart.
    """
    problems: list[str] = []
    try:
        await db.close()
    except Exception as exc:
        problems.append(f"close failed: {exc}")
    db.db_path = previous_db_path
    if previous_key is not None:
        try:
            db.set_storage_key(previous_key)
        except Exception as exc:
            problems.append(f"rekey failed: {exc}")
    try:
        await db.connect()
    except Exception as exc:
        problems.append(f"reconnect failed: {exc}")
    try:
        file_manager.data_dir = previous_data_dir
    except Exception as exc:
        problems.append(f"data_dir restore failed: {exc}")
    return "; ".join(problems) if problems else None


def remove_created_artifacts(
    *, db_path: Path, identity_path: Path, files_base: Path, copied: list[str]
) -> None:
    """Best-effort removal of artifacts a migration created at the target.

    Only call this for files this migration created: an aborted or rolled-back
    migrate must not leave a half-populated target behind (a retry would then
    see "already contains data"), but pre-existing target content is never
    touched. Errors are ignored since this runs on failure paths.
    """
    for sidecar in ("", "-wal", "-shm", "-journal"):
        candidate = db_path if not sidecar else Path(str(db_path) + sidecar)
        try:
            candidate.unlink()
        except OSError:
            pass
    try:
        identity_path.unlink()
    except OSError:
        pass
    removed_dirs: set[Path] = set()
    for rel in copied:
        target = files_base / rel
        try:
            target.unlink()
        except OSError:
            pass
        removed_dirs.add(target.parent)
    for directory in sorted(removed_dirs, key=lambda item: len(str(item)), reverse=True):
        try:
            directory.rmdir()
        except OSError:
            pass
    try:
        # Remove the files root too when this migration created it; an empty
        # directory should not make a retry look like an occupied target.
        files_base.rmdir()
    except OSError:
        pass


async def migrate_files_location(*, db, settings, target: Path) -> dict:
    """Move the effective files directory to target with copy-verify-delete.

    ``db`` needs ``has_active_file_transfers()`` and
    ``rewrite_file_paths()``; ``settings`` needs
    ``files_dir``/``_files_dir``/``set_files_dir()``. Raises RuntimeError when
    the move cannot be completed: the old location stays active and partially
    copied files are removed. Returns ``{"migrated", "cleanup_warning"}``.
    """
    if os.environ.get("MESHTALK_FILES_DIR", "").strip():
        raise RuntimeError(
            "MESHTALK_FILES_DIR is set and takes precedence over this setting; "
            "unset it before migrating."
        )
    old_base = settings.files_dir
    previous_files_setting = settings._files_dir
    if location_contains(old_base, settings.storage_dir):
        raise RuntimeError(
            f"The configured files location '{old_base}' contains the storage location "
            f"'{settings.storage_dir}'; choose a dedicated files directory before migrating."
        )
    if same_location(old_base, target):
        try:
            settings.set_files_dir(str(target))
        except Exception as exc:
            settings._files_dir = previous_files_setting
            raise RuntimeError(str(exc)) from exc
        return {"migrated": False, "cleanup_warning": None}
    if locations_nested(old_base, target):
        raise RuntimeError(
            f"Target '{target}' must not be the same as or nested inside '{old_base}' "
            "(or vice versa); deleting the old files afterwards would remove the "
            "new location. Location unchanged."
        )
    copied: list[str] = []
    if dir_has_content(old_base):
        if await db.has_active_file_transfers():
            raise RuntimeError("A file transfer is in progress; wait for it to finish before migrating.")
        try:
            copied = copy_tree_merge(old_base, target)
        except Exception as exc:
            raise RuntimeError(f"Could not copy files to '{target}': {exc}. Location unchanged.") from exc
        problems = verify_tree_copy(old_base, target, copied)
        if problems:
            for rel in reversed(copied):
                try:
                    (target / rel).unlink()
                except OSError:
                    pass
            detail = "; ".join(problems[:5])
            raise RuntimeError(f"Verification of the copied files failed ({detail}). Location unchanged.")
        # Re-check right before committing the switch: a queued transfer that
        # started during the copy would otherwise keep writing to the old
        # location, which is deleted immediately below.
        if await db.has_active_file_transfers():
            for rel in reversed(copied):
                try:
                    (target / rel).unlink()
                except OSError:
                    pass
            raise RuntimeError(
                "A file transfer started during the migration; wait for it to finish and retry. Location unchanged."
            )
    try:
        settings.set_files_dir(str(target))
    except Exception as exc:
        # Leave the old setting in effect: no files moved, nothing deleted.
        settings._files_dir = previous_files_setting
        raise RuntimeError(f"Could not save the new files location: {exc}. Location unchanged.") from exc
    if copied:
        # Re-root absolute transfer paths so existing rows resolve under the
        # new files directory before the old one is removed.
        await db.rewrite_file_paths(old_base, target)
    cleanup_warning = None
    if dir_has_content(old_base):
        problems = delete_tree_contents(old_base)
        if problems:
            cleanup_warning = "; ".join(problems[:5])
    return {"migrated": bool(copied), "cleanup_warning": cleanup_warning}


async def switch_storage_location(*, db, settings, file_manager, identity, target: Path, migrate: bool) -> dict:
    """Switch the live backend to a new storage directory.

    With ``migrate=True`` the messages database (consistent snapshot),
    identity, and default-located files are copied, verified, and only then
    deleted from the old location. With ``migrate=False`` nothing is copied:
    an empty target gets a fresh database (old data left intact), while a
    target that already holds MeshTalk data is adopted as-is. ``db`` needs
    ``db_path``/``close()``/``connect()``/``vacuum_into()``/
    ``set_storage_key()``/``has_active_file_transfers()``; ``settings``
    needs ``storage_dir``/``files_dir``/``_storage_dir``/``_files_dir``/
    ``set_storage_dir()``; ``file_manager`` needs a writable ``data_dir``
    attribute; ``identity`` is the shared live identity, updated in place
    when adopting another location's identity.

    Raises RuntimeError when the switch cannot be completed; the old location
    stays active in that case. Returns a summary dict with ``migrated``,
    ``files_migrated``, and optional ``note``/``files_note``/
    ``cleanup_warning`` entries.
    """
    if os.environ.get(STORAGE_ENV_VAR, "").strip():
        raise RuntimeError(
            f"{STORAGE_ENV_VAR} is set and takes precedence over this setting; "
            "unset it before changing the storage location."
        )
    old_storage = settings.storage_dir
    previous_storage_setting = settings._storage_dir
    if same_location(old_storage, target):
        return {"migrated": False, "files_migrated": False, "cleanup_warning": None, "noop": True}
    if locations_nested(old_storage, target):
        raise RuntimeError(
            f"Target '{target}' must not be the same as or nested inside '{old_storage}' "
            "(or vice versa); choose a separate location. Location unchanged."
        )
    previous_data_dir = file_manager.data_dir
    # Block new sends/inbound writes for the whole switch. The active-transfer
    # check alone leaves a window between the last check and the deletion of
    # the old tree in which a queued transfer could start writing there.
    file_manager.migration_in_progress = True
    try:
        return await _switch_storage_locked(
            db=db,
            settings=settings,
            file_manager=file_manager,
            identity=identity,
            target=target,
            migrate=migrate,
            old_storage=old_storage,
            previous_storage_setting=previous_storage_setting,
            previous_data_dir=previous_data_dir,
        )
    finally:
        file_manager.migration_in_progress = False


async def _switch_storage_locked(
    *,
    db,
    settings,
    file_manager,
    identity,
    target: Path,
    migrate: bool,
    old_storage: Path,
    previous_storage_setting: str | None,
    previous_data_dir: Path,
) -> dict:
    """Body of ``switch_storage_location``; runs with the migration guard set."""
    old_db = old_storage / DB_FILENAME
    new_db = target / DB_FILENAME
    old_identity = old_storage / IDENTITY_FILENAME
    new_identity = target / IDENTITY_FILENAME
    target_has_data = new_db.exists() or new_identity.exists()
    if migrate and target_has_data:
        raise RuntimeError(
            f"Target '{target}' already contains MeshTalk data. "
            "Choose an empty location or move that data aside first."
        )
    if not migrate and not target_has_data and dir_has_content(target):
        raise RuntimeError(
            f"Target '{target}' already contains files. "
            "Pass migrate=true to transfer, or choose an empty location."
        )
    if await db.has_active_file_transfers():
        raise RuntimeError(
            "A file transfer is in progress; wait for it to finish before changing the storage location."
        )
    old_files_base = settings.files_dir
    files_follow_storage = not settings._files_dir and not os.environ.get("MESHTALK_FILES_DIR", "").strip()
    new_files_base = target / FILES_SUBDIR
    if location_contains(old_files_base, target):
        raise RuntimeError(
            f"Target '{target}' is inside the files location '{old_files_base}'; "
            "choose a separate location. Location unchanged."
        )
    migrate_files = (
        migrate
        and files_follow_storage
        and dir_has_content(old_files_base)
        and not same_location(old_files_base, new_files_base)
    )
    copied_files: list[str] = []
    if migrate:
        try:
            if old_db.exists():
                try:
                    await db.vacuum_into(new_db)
                except Exception as exc:
                    raise RuntimeError(f"Could not copy the messages database: {exc}") from exc
                problem = sqlite_integrity_ok(new_db)
                if problem:
                    raise RuntimeError(f"Database copy verification failed ({problem}). Location unchanged.")
            if old_identity.exists():
                copy_file(old_identity, new_identity)
                problem = verify_file_copy(old_identity, new_identity)
                if problem:
                    raise RuntimeError(
                        f"Identity copy verification failed ({problem}). Location unchanged."
                    )
            if migrate_files:
                try:
                    copied_files = copy_tree_merge(old_files_base, new_files_base)
                except Exception as exc:
                    raise RuntimeError(f"Could not copy stored files: {exc}. Location unchanged.") from exc
                problems = verify_tree_copy(old_files_base, new_files_base, copied_files)
                if not problems and await db.has_active_file_transfers():
                    # A queued or pending transfer started during the copy and
                    # may be writing to the old location, which is removed
                    # below; abort rather than lose its data.
                    problems = ["a file transfer started during the migration"]
                if problems:
                    raise RuntimeError(
                        f"Verification of the copied files failed ({'; '.join(problems[:5])}). "
                        "Location unchanged."
                    )
        except Exception:
            # Never leave a half-populated target behind: a retry would
            # otherwise be rejected as "already contains data".
            remove_created_artifacts(
                db_path=new_db,
                identity_path=new_identity,
                files_base=new_files_base,
                copied=copied_files,
            )
            raise
    else:
        if target_has_data:
            # Adopt the data already at the target: use its database (after a
            # read-only verification) and its identity (so existing rows stay
            # decryptable), leaving the old location completely untouched.
            adopted_identity = None
            if new_identity.exists():
                try:
                    from .identity import Identity
                    adopted_identity = Identity.load(target)
                except Exception as exc:
                    raise RuntimeError(
                        f"Cannot use the identity at '{target}': {exc}. Location unchanged."
                    ) from exc
                if adopted_identity is None:
                    raise RuntimeError(
                        f"Cannot use the identity at '{target}' (unsupported format). "
                        "Location unchanged."
                    )
            elif new_db.exists():
                raise RuntimeError(
                    f"Target '{target}' contains a database but no identity, so its "
                    "messages cannot be decrypted. Move that data aside first or "
                    "choose another location."
                )
            if new_db.exists():
                problem = sqlite_integrity_ok(new_db)
                if problem:
                    raise RuntimeError(
                        f"The database at '{target}' failed verification ({problem}). "
                        "Location unchanged."
                    )
            new_key = (adopted_identity or identity).storage_key()
            old_key = identity.storage_key()
            previous_identity_fields = (
                identity.signing_private_key,
                identity.encryption_private_key,
                identity.peer_id,
                identity.display_name,
            )
            previous_db_path = db.db_path
            await db.close()
            db.db_path = new_db
            db.set_storage_key(new_key)
            try:
                await db.connect()
            except Exception as exc:
                db.db_path = previous_db_path
                try:
                    db.set_storage_key(old_key)
                except Exception:
                    pass
                try:
                    await db.connect()
                except Exception:
                    pass
                raise RuntimeError(
                    f"Could not open the database at the new location: {exc}. Location unchanged."
                ) from exc
            identity_changed = (
                adopted_identity is not None and adopted_identity.peer_id != identity.peer_id
            )
            if adopted_identity is not None:
                identity.signing_private_key = adopted_identity.signing_private_key
                identity.encryption_private_key = adopted_identity.encryption_private_key
                identity.peer_id = adopted_identity.peer_id
                identity.display_name = adopted_identity.display_name
            file_manager.data_dir = target
            try:
                settings.set_storage_dir(str(target))
            except Exception as exc:
                # Undo the in-memory identity adoption as well: persisted
                # settings still point at the old location and its identity.
                settings._storage_dir = previous_storage_setting
                (
                    identity.signing_private_key,
                    identity.encryption_private_key,
                    identity.peer_id,
                    identity.display_name,
                ) = previous_identity_fields
                rollback_problem = await _rollback_db_switch(
                    db=db,
                    file_manager=file_manager,
                    previous_db_path=previous_db_path,
                    previous_key=old_key,
                    previous_data_dir=previous_data_dir,
                )
                if rollback_problem is None:
                    raise RuntimeError(
                        f"Could not save the new storage location: {exc}. "
                        "Rolled back; old location still active."
                    ) from exc
                raise RuntimeError(
                    f"Could not save the new storage location: {exc}. "
                    f"Rollback also failed ({rollback_problem}); restart the backend."
                ) from exc
            summary = {
                "migrated": False,
                "files_migrated": False,
                "cleanup_warning": None,
                "noop": False,
                "note": (
                    f"Switched to the existing data at '{target}'. "
                    "Previous data was left intact at "
                    f"'{old_storage}'."
                ),
            }
            if identity_changed:
                summary["note"] += (
                    " Now using the peer identity stored at the new location; "
                    "peers may need to reconnect."
                )
            if not files_follow_storage:
                summary["files_note"] = "A custom files directory is configured; it was left unchanged."
            return summary
        if old_identity.exists():
            copy_file(old_identity, new_identity)
    # Switch the live backend to the new location. The old database connection
    # is closed first so its file can be safely removed afterwards (including
    # on Windows) and no writes are lost.
    previous_db_path = db.db_path
    await db.close()
    db.db_path = new_db
    try:
        await db.connect()
    except Exception as exc:
        db.db_path = previous_db_path
        try:
            await db.connect()
        except Exception:
            pass
        # Applies to both paths: the empty-target switch also copies the
        # identity here. Leaving it behind would silently turn an identical
        # retry into an adopt of that orphaned identity.
        remove_created_artifacts(
            db_path=new_db,
            identity_path=new_identity,
            files_base=new_files_base,
            copied=copied_files,
        )
        raise RuntimeError(
            f"Could not open the database at the new location: {exc}. Location unchanged."
        ) from exc
    file_manager.data_dir = target
    try:
        settings.set_storage_dir(str(target))
    except Exception as exc:
        settings._storage_dir = previous_storage_setting
        rollback_problem = await _rollback_db_switch(
            db=db,
            file_manager=file_manager,
            previous_db_path=previous_db_path,
            previous_key=None,
            previous_data_dir=previous_data_dir,
        )
        if migrate:
            # The target copies were created by this run; drop them so the
            # location can be retried cleanly after the rollback.
            remove_created_artifacts(
                db_path=new_db,
                identity_path=new_identity,
                files_base=new_files_base,
                copied=copied_files,
            )
        if rollback_problem is None:
            raise RuntimeError(
                f"Could not save the new storage location: {exc}. "
                "Rolled back; old location still active."
            ) from exc
        raise RuntimeError(
            f"Could not save the new storage location: {exc}. "
            f"Rollback also failed ({rollback_problem}); restart the backend."
        ) from exc
    summary: dict = {"migrated": migrate, "files_migrated": bool(migrate_files), "cleanup_warning": None, "noop": False}
    cleanup_problems: list[str] = []
    if migrate:
        if migrate_files:
            # Re-root absolute transfer paths before the old files are removed,
            # so completed transfers still resolve at the new location.
            await db.rewrite_file_paths(old_files_base, new_files_base)
        for sidecar in ("", "-wal", "-shm", "-journal"):
            candidate = old_db if not sidecar else Path(str(old_db) + sidecar)
            if candidate.exists():
                try:
                    candidate.unlink()
                except OSError as exc:
                    cleanup_problems.append(f"cannot delete {candidate}: {exc}")
        if migrate_files:
            cleanup_problems.extend(delete_tree_contents(old_files_base))
        if old_identity.exists():
            try:
                old_identity.unlink()
            except OSError as exc:
                cleanup_problems.append(f"cannot delete {old_identity}: {exc}")
    else:
        summary["note"] = f"Storage switched to '{target}'. Previous data was left intact at '{old_storage}'."
    if not files_follow_storage:
        summary["files_note"] = "A custom files directory is configured; it was left unchanged."
    if cleanup_problems:
        summary["cleanup_warning"] = (
            "Location changed, but some old files could not be deleted: " + "; ".join(cleanup_problems[:5])
        )
    return summary
