import ipaddress
import struct
import unittest

from meshtalk.udp_transport import STUN_COOKIE, parse_stun_response


class StunTest(unittest.TestCase):
    def test_parses_xor_mapped_ipv4_address(self):
        transaction_id = bytes(range(12))
        address = ipaddress.IPv4Address("198.51.100.9").packed
        cookie = struct.pack("!I", STUN_COOKIE)
        encoded_address = bytes(byte ^ cookie[index] for index, byte in enumerate(address))
        port = 54321
        value = b"\x00\x01" + struct.pack("!H", port ^ (STUN_COOKIE >> 16)) + encoded_address
        attribute = struct.pack("!HH", 0x0020, len(value)) + value
        response = struct.pack("!HHI12s", 0x0101, len(attribute), STUN_COOKIE, transaction_id) + attribute

        self.assertEqual(parse_stun_response(response, transaction_id), ("198.51.100.9", port))

    def test_rejects_wrong_transaction(self):
        response = struct.pack("!HHI12s", 0x0101, 0, STUN_COOKIE, b"x" * 12)
        with self.assertRaises(ValueError):
            parse_stun_response(response, b"y" * 12)
