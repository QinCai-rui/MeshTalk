import sqlite3
import threading
from datetime import datetime, timedelta, timezone

RETENTION_DAYS = 90

class Store:
    def __init__(self, path: str):
        self._lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        with self._lock:
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("CREATE TABLE IF NOT EXISTS daily_pings(version TEXT, os TEXT, arch TEXT, day TEXT, count INTEGER NOT NULL, PRIMARY KEY(version,os,arch,day))")
            self.db.execute("CREATE TABLE IF NOT EXISTS daily_events(event TEXT, day TEXT, count INTEGER NOT NULL, PRIMARY KEY(event,day))")
            self.db.commit()
    def record(self, payload: dict) -> None:
        # UTC day so ingest day boundaries do not depend on server-local TZ.
        day = datetime.now(timezone.utc).date().isoformat()
        with self._lock:
            if payload["tier"] == 0:
                self.db.execute("INSERT INTO daily_pings VALUES(?,?,?,?,1) ON CONFLICT(version,os,arch,day) DO UPDATE SET count=count+1", (payload["app_version"], payload["os"], payload["arch"], day))
            else:
                for event in payload["events"]:
                    # Bound cardinality: ignore new distinct error.* names once
                    # 50 distinct error names exist for the day (abuse cap).
                    if event["name"].startswith("error."):
                        row = self.db.execute(
                            "SELECT COUNT(*) FROM daily_events WHERE day=? AND event LIKE 'error.%'",
                            (day,),
                        ).fetchone()
                        if row and row[0] >= 50:
                            exists = self.db.execute(
                                "SELECT 1 FROM daily_events WHERE event=? AND day=?",
                                (event["name"], day),
                            ).fetchone()
                            if not exists:
                                continue
                    self.db.execute("INSERT INTO daily_events VALUES(?,?,?) ON CONFLICT(event,day) DO UPDATE SET count=count+excluded.count", (event["name"], day, event["count"]))
            self.db.commit()
    def prune(self) -> None:
        """Delete rows older than retention. Called explicitly, not on every record()."""
        cutoff = (datetime.now(timezone.utc).date() - timedelta(days=RETENTION_DAYS)).isoformat()
        with self._lock:
            self.db.execute("DELETE FROM daily_pings WHERE day < ?", (cutoff,))
            self.db.execute("DELETE FROM daily_events WHERE day < ?", (cutoff,))
            self.db.commit()
