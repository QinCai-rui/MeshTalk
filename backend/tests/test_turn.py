import unittest

from meshtalk.turn import TurnServer


class TurnServerTest(unittest.TestCase):
    def test_defaults_to_udp(self):
        self.assertEqual(TurnServer.from_uri("turn:relay.example.com"), TurnServer(
            "relay.example.com", 3478, "udp", False
        ))

    def test_parses_tls_tcp_uri(self):
        self.assertEqual(TurnServer.from_uri("turns:relay.example.com:443?transport=tcp"), TurnServer(
            "relay.example.com", 443, "tcp", True
        ))

    def test_tls_defaults_to_tcp(self):
        self.assertEqual(TurnServer.from_uri("turns:relay.example.com"), TurnServer(
            "relay.example.com", 5349, "tcp", True
        ))

    def test_rejects_duplicate_transport(self):
        with self.assertRaises(ValueError):
            TurnServer.from_uri("turn:relay.example.com?transport=udp&transport=tcp")

    def test_rejects_tls_udp(self):
        with self.assertRaises(ValueError):
            TurnServer.from_uri("turns:relay.example.com:3478?transport=udp")
