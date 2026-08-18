import tempfile
import unittest
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from meshtalk.protocol import (
    GroupMembershipPayload,
    GroupMessagePayload,
    GroupMetadataPayload,
    GroupRekeyPayload,
)
from meshtalk.settings import Room, Settings


class GroupPayloadTests(unittest.TestCase):
    def setUp(self):
        self.owner = Ed25519PrivateKey.generate()
        self.owner_id = "a" * 64
        self.group_id = "b" * 32

    def test_signed_payload_round_trips(self):
        message = GroupMessagePayload(self.group_id, 1, "c" * 32, self.owner_id, 1.0, b"0" * 12, b"cipher", b"s" * 64)
        self.assertEqual(GroupMessagePayload.decode(message.encode()), message)
        membership = GroupMembershipPayload(self.group_id, 1, self.owner_id, [{"peer_id": self.owner_id, "display_name": "Owner"}], b"s" * 64)
        self.assertEqual(GroupMembershipPayload.decode(membership.encode()), membership)
        metadata = GroupMetadataPayload(self.group_id, "Roadhouse", self.owner_id, 1, b"s" * 64)
        self.assertEqual(GroupMetadataPayload.decode(metadata.encode()), metadata)
        rekey = GroupRekeyPayload(self.group_id, 2, self.owner_id, "d" * 64, b"k" * 64, b"s" * 64)
        self.assertEqual(GroupRekeyPayload.decode(rekey.encode()), rekey)

    def test_named_invite_is_signed_and_legacy_room_survives(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = Settings(Path(directory) / "settings.json")
            room = settings.create_group("Roadhouse", self.owner_id, self.owner.public_key().public_bytes_raw(), self.owner)
            joined = Room.from_invite(room.invite)
            self.assertEqual(joined.name, "Roadhouse")
            self.assertEqual(joined.owner_id, self.owner_id)
            legacy = Room.create()
            migrated = Settings(Path(directory) / "legacy.json")
            migrated.rooms[legacy.id] = legacy
            count = migrated.migrate_legacy_groups(self.owner_id, self.owner.public_key().public_bytes_raw(), self.owner)
            self.assertEqual(count, 1)
            self.assertEqual(migrated.rooms[legacy.id].name, "Untitled group")


if __name__ == "__main__":
    unittest.main()
