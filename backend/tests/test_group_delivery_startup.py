import tempfile
import unittest
from pathlib import Path

from meshtalk.database import Database


class GroupDeliveryStartupTests(unittest.IsolatedAsyncioTestCase):
    async def test_interrupted_pending_deliveries_become_failed_on_reopen(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "meshtalk.db"
            db = Database(path)
            await db.connect()
            await db.set_group_delivery("m1", "alex", "pending")
            await db.set_group_delivery("m1", "sam", "queued")
            await db.close()

            db = Database(path)
            await db.connect()
            try:
                statuses = {d["recipient_id"]: d["status"] for d in await db.get_group_deliveries("m1")}
            finally:
                await db.close()
            self.assertEqual(statuses, {"alex": "failed", "sam": "queued"})
