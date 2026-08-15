import os
import tempfile
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
