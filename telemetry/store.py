import sqlite3
from datetime import date, timedelta

class Store:
    def __init__(self, path: str):
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("CREATE TABLE IF NOT EXISTS daily_pings(version TEXT, os TEXT, arch TEXT, day TEXT, count INTEGER NOT NULL, PRIMARY KEY(version,os,arch,day))")
        self.db.execute("CREATE TABLE IF NOT EXISTS daily_events(event TEXT, day TEXT, count INTEGER NOT NULL, PRIMARY KEY(event,day))")
        self.db.commit()
    def record(self, payload: dict) -> None:
        day = date.today().isoformat()
        if payload["tier"] == 0:
            self.db.execute("INSERT INTO daily_pings VALUES(?,?,?,?,1) ON CONFLICT(version,os,arch,day) DO UPDATE SET count=count+1", (payload["app_version"], payload["os"], payload["arch"], day))
        else:
            for event in payload["events"]:
                self.db.execute("INSERT INTO daily_events VALUES(?,?,?) ON CONFLICT(event,day) DO UPDATE SET count=count+excluded.count", (event["name"], day, event["count"]))
        self.db.execute("DELETE FROM daily_pings WHERE day < ?", ((date.today() - timedelta(days=90)).isoformat(),))
        self.db.execute("DELETE FROM daily_events WHERE day < ?", ((date.today() - timedelta(days=90)).isoformat(),))
        self.db.commit()
