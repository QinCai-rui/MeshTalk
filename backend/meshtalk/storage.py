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

import os
import shutil
import sqlite3
import tempfile
from pathlib import Path

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

# Top-level entries eligible for storage migration.
MIGRATABLE_ENTRIES = (DB_FILENAME, IDENTITY_FILENAME, FILES_SUBDIR)


def validate_target_dir(raw: str, *, base: Path | None = None) -> Path:
    """Validate a candidate storage/files directory and return its absolute path.

    Creates the directory (including parents) and proves writability with a
    temporary file. Raises ValueError when unusable.
    """
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("path must be a non-empty string")
    cleaned = raw.strip().strip('"').strip("'")
    candidate = Path(cleaned).expanduser()
    if not candidate.is_absolute():
        anchor = base if base is not None else Path.cwd()
        candidate = (anchor / candidate).resolve()
    try:
        candidate.mkdir(parents=True, exist_ok=True)
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


def dir_has_content(path: Path) -> bool:
    """Return True when a directory exists and holds any non-runtime entries."""
    try:
        entries = list(path.iterdir())
    except OSError:
        return False
    return any(entry.name not in RUNTIME_FILES for entry in entries)


def snapshot_tree(base: Path) -> dict[str, int]:
    """Map relative file paths under base to their sizes (excludes runtime files)."""
    snapshot: dict[str, int] = {}
    if not base.is_dir():
        return snapshot
    for root, dirs, files in os.walk(base):
        # Prune nothing: files/ tree has no runtime files, but keep the guard.
        dirs[:] = [name for name in dirs if name not in RUNTIME_FILES]
        for name in files:
            if name in RUNTIME_FILES:
                continue
            full = Path(root) / name
            try:
                rel = str(full.relative_to(base))
                snapshot[rel] = full.stat().st_size
            except OSError:
                continue
    return snapshot


def copy_tree_merge(src: Path, dst: Path) -> list[str]:
    """Copy all files under src into dst (merge), returning copied relative paths.

    Raises on the first failure after best-effort removal of files copied by
    this call. Pre-existing destination files are overwritten by copy2 and are
    NOT removed on abort (only paths in the returned list are cleaned, and the
    list is only returned on full success; on failure the partial list is
    cleaned internally).
    """
    copied: list[str] = []
    try:
        if not src.is_dir():
            return copied
        dst.mkdir(parents=True, exist_ok=True)
        for root, dirs, files in os.walk(src):
            rel_root = Path(root).relative_to(src)
            target_root = dst / rel_root if str(rel_root) != "." else dst
            target_root.mkdir(parents=True, exist_ok=True)
            for name in files:
                if name in RUNTIME_FILES:
                    continue
                source = Path(root) / name
                rel = str((rel_root / name) if str(rel_root) != "." else Path(name))
                target = dst / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
                copied.append(rel)
    except Exception:
        for rel in reversed(copied):
            try:
                (dst / rel).unlink()
            except OSError:
                pass
        raise
    return copied


def copy_file(source: Path, dest: Path) -> None:
    """Copy a single file, creating parent directories. Removes partial dest on failure."""
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, dest)
    except Exception:
        try:
            if dest.exists():
                dest.unlink()
        except OSError:
            pass
        raise


def verify_tree_copy(src: Path, dst: Path, copied: list[str]) -> list[str]:
    """Verify copied files exist at dst with matching sizes. Returns error strings."""
    problems: list[str] = []
    for rel in copied:
        source, target = src / rel, dst / rel
        try:
            if not target.is_file():
                problems.append(f"missing after copy: {rel}")
                continue
            if source.stat().st_size != target.stat().st_size:
                problems.append(f"size mismatch after copy: {rel}")
        except OSError as exc:
            problems.append(f"cannot verify {rel}: {exc}")
    return problems


def sqlite_integrity_ok(db_path: Path) -> str | None:
    """Run PRAGMA integrity_check on a SQLite file. Returns None when OK, else details."""
    try:
        uri = f"file:{db_path}?mode=ro"
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


async def migrate_files_location(*, db, settings, target: Path) -> dict:
    """Move the effective files directory to target with copy-verify-delete.

    ``db`` needs ``has_active_file_transfers()``; ``settings`` needs
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
    if same_location(old_base, target):
        try:
            settings.set_files_dir(str(target))
        except ValueError as exc:
            raise RuntimeError(str(exc)) from exc
        return {"migrated": False, "cleanup_warning": None}
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
    try:
        settings.set_files_dir(str(target))
    except ValueError as exc:
        raise RuntimeError(str(exc)) from exc
    cleanup_warning = None
    if dir_has_content(old_base):
        problems = delete_tree_contents(old_base)
        if problems:
            cleanup_warning = "; ".join(problems[:5])
    return {"migrated": True, "cleanup_warning": cleanup_warning}


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
    if same_location(old_storage, target):
        return {"migrated": False, "files_migrated": False, "cleanup_warning": None, "noop": True}
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
    migrate_files = (
        migrate
        and files_follow_storage
        and dir_has_content(old_files_base)
        and not same_location(old_files_base, new_files_base)
    )
    copied_files: list[str] = []
    if migrate:
        if old_db.exists():
            try:
                await db.vacuum_into(new_db)
            except Exception as exc:
                raise RuntimeError(f"Could not copy the messages database: {exc}") from exc
            problem = sqlite_integrity_ok(new_db)
            if problem:
                try:
                    new_db.unlink()
                except OSError:
                    pass
                raise RuntimeError(f"Database copy verification failed ({problem}). Location unchanged.")
        if old_identity.exists():
            copy_file(old_identity, new_identity)
            if old_identity.stat().st_size != new_identity.stat().st_size:
                try:
                    new_identity.unlink()
                except OSError:
                    pass
                raise RuntimeError("Identity copy verification failed (size mismatch). Location unchanged.")
        if migrate_files:
            try:
                copied_files = copy_tree_merge(old_files_base, new_files_base)
            except Exception as exc:
                raise RuntimeError(f"Could not copy stored files: {exc}. Location unchanged.") from exc
            problems = verify_tree_copy(old_files_base, new_files_base, copied_files)
            if problems:
                for rel in reversed(copied_files):
                    try:
                        (new_files_base / rel).unlink()
                    except OSError:
                        pass
                detail = "; ".join(problems[:5])
                raise RuntimeError(f"Verification of the copied files failed ({detail}). Location unchanged.")
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
            except ValueError as exc:
                raise RuntimeError(str(exc)) from exc
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
        raise RuntimeError(
            f"Could not open the database at the new location: {exc}. Location unchanged."
        ) from exc
    file_manager.data_dir = target
    try:
        settings.set_storage_dir(str(target))
    except ValueError as exc:
        raise RuntimeError(str(exc)) from exc
    summary: dict = {"migrated": migrate, "files_migrated": bool(migrate_files), "cleanup_warning": None, "noop": False}
    cleanup_problems: list[str] = []
    if migrate:
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
