import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from meshtalk.settings import Room, Settings


class SettingsControlSetupTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.path = Path(self.tempdir.name) / "settings.json"

    def tearDown(self):
        self.tempdir.cleanup()

    def test_new_settings_offer_control_setup(self):
        settings = Settings(self.path)

        self.assertEqual(settings.control_url, "")
        self.assertFalse(settings.control_setup_dismissed)
        self.assertFalse(settings.identity_setup_dismissed)

    def test_dismissed_setup_persists_without_a_control_url(self):
        settings = Settings(self.path)
        settings.dismiss_control_setup()

        loaded = Settings(self.path)

        self.assertEqual(loaded.control_url, "")
        self.assertTrue(loaded.control_setup_dismissed)

    def test_setting_control_url_also_dismisses_setup(self):
        settings = Settings(self.path)
        settings.set_control_url("wss://control.example/v1/rendezvous/")

        loaded = Settings(self.path)

        self.assertEqual(loaded.control_url, "wss://control.example/v1/rendezvous")
        self.assertTrue(loaded.control_setup_dismissed)

    def test_identity_setup_dismissal_persists_independently(self):
        settings = Settings(self.path)
        settings.dismiss_identity_setup()

        loaded = Settings(self.path)

        self.assertTrue(loaded.identity_setup_dismissed)
        self.assertFalse(loaded.control_setup_dismissed)

    def test_environment_control_url_does_not_mutate_persisted_settings(self):
        settings = Settings(self.path)
        settings.dismiss_control_setup()

        with patch.dict(os.environ, {"MESHTALK_CONTROL_URL": "wss://temporary.example"}):
            self.assertEqual(settings.control_url, "wss://temporary.example")

        loaded = Settings(self.path)
        self.assertEqual(loaded.control_url, "")
        self.assertTrue(loaded.control_setup_dismissed)

    def test_remote_plain_websocket_urls_are_rejected(self):
        settings = Settings(self.path)

        with self.assertRaisesRegex(ValueError, "Remote control URLs must use wss://"):
            settings.set_control_url("ws://control.example/v1/rendezvous")

    def test_local_plain_websocket_urls_are_allowed(self):
        settings = Settings(self.path)

        settings.set_control_url("ws://127.0.0.1:8787/v1/rendezvous")

        self.assertEqual(settings.control_url, "ws://127.0.0.1:8787/v1/rendezvous")

    def test_server_ip_pins_persist_and_can_be_cleared(self):
        settings = Settings(self.path)
        settings.set_control_pinned_ip("2001:0db8::1")
        settings.set_stun_pinned_ip("203.0.113.10")

        loaded = Settings(self.path)

        self.assertEqual(loaded.control_pinned_ip, "2001:db8::1")
        self.assertEqual(loaded.stun_pinned_ip, "203.0.113.10")
        loaded.clear_control_pinned_ip()
        loaded.clear_stun_pinned_ip()
        self.assertIsNone(Settings(self.path).control_pinned_ip)
        self.assertIsNone(Settings(self.path).stun_pinned_ip)

    def test_stun_ip_pin_must_be_ipv4(self):
        settings = Settings(self.path)

        with self.assertRaisesRegex(ValueError, "STUN pinned IP must be IPv4"):
            settings.set_stun_pinned_ip("2001:db8::1")

        with self.assertRaisesRegex(ValueError, "valid IP address"):
            settings.set_control_pinned_ip("not-an-ip")


class RoomInvitePersistenceTest(unittest.TestCase):
    def test_room_invite_survives_settings_reload(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "settings.json"
            settings = Settings(path)
            room = settings.create_room()
            invite = room.invite

            loaded = Settings(path)

            self.assertEqual(loaded.rooms[room.id].invite, invite)
            self.assertEqual(Room.from_invite(invite), loaded.rooms[room.id])

    def test_group_name_is_encrypted_in_invite_and_survives_reload(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "settings.json"
            settings = Settings(path)
            room = settings.create_room("Project Nightfall")
            invite = room.invite

            self.assertNotIn("Project Nightfall", invite)
            self.assertTrue(invite.startswith("meshtalk-group:"))
            self.assertEqual(Room.from_invite(invite).group_name, "Project Nightfall")
            self.assertEqual(Settings(path).rooms[room.id].group_name, "Project Nightfall")

            stripped = "meshtalk:" + invite.removeprefix("meshtalk-group:").rsplit(".", 1)[0]
            with self.assertRaisesRegex(ValueError, "conflicts"):
                settings.join_room(stripped)


class MutePeerPersistenceTest(unittest.TestCase):
    def test_permanent_mute_survives_reload(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "settings.json"
            settings = Settings(path)
            settings.mute_peer("peer1", 0)

            loaded = Settings(path)

            self.assertTrue(loaded.is_peer_muted("peer1"))
            self.assertEqual(loaded.muted_peers["peer1"], 0)

    def test_timed_mute_survives_while_valid(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "settings.json"
            settings = Settings(path)
            settings.mute_peer("peer2", time.time() + 3600)

            loaded = Settings(path)

            self.assertTrue(loaded.is_peer_muted("peer2"))

    def test_expired_mute_is_cleared_on_load(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "settings.json"
            settings = Settings(path)
            settings.mute_peer("peer3", time.time() - 10)

            loaded = Settings(path)

            self.assertFalse(loaded.is_peer_muted("peer3"))
            self.assertNotIn("peer3", loaded.muted_peers)

    def test_unmute_removes_peer(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "settings.json"
            settings = Settings(path)
            settings.mute_peer("peer4", 0)
            self.assertTrue(settings.is_peer_muted("peer4"))

            settings.unmute_peer("peer4")

            self.assertFalse(settings.is_peer_muted("peer4"))
            self.assertNotIn("peer4", settings.muted_peers)

    def test_timed_mute_expires_at_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "settings.json"
            settings = Settings(path)
            settings.mute_peer("peer5", time.time() + 0.1)
            self.assertTrue(settings.is_peer_muted("peer5"))

            time.sleep(0.2)

            self.assertFalse(settings.is_peer_muted("peer5"))
            self.assertNotIn("peer5", settings.muted_peers)
