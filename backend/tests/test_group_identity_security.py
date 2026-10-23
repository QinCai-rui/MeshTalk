"""Group message IDs that collide across senders must never yield a false ACK.

The honest copy is still dropped when another member's copy arrives first.
Fully fixing that needs a (group, sender, message) key migration.
"""

import hashlib
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

from meshtalk.database import Database
from meshtalk.encryption import encrypt_for_recipient
from meshtalk.group_router import GroupRouter
from meshtalk.identity import Identity
from meshtalk.protocol import GroupMessagePayload, Packet, PacketType, group_origin_signed_bytes
from meshtalk.settings import Settings


class GroupIdentitySecurityTest(unittest.IsolatedAsyncioTestCase):
    async def test_conflicting_id_is_not_acknowledged(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            alice, attacker, cara = [Identity.generate(name) for name in ('Alice', 'Attacker', 'Cara')]
            settings = Settings(root / 'settings.json')
            room = settings.create_room('Group')
            received = []

            class MemoryPeers:
                def get_connected_peer(self, _):
                    return None

                async def send_packet(self, peer, packet):
                    received.append((peer.peer_id, packet))

            victim = Database(root / 'cara.db')
            sender = Database(root / 'alice.db')
            await victim.connect()
            await sender.connect()
            try:
                router = GroupRouter(cara, MemoryPeers(), victim, settings)
                for identity in (alice, attacker, cara):
                    await victim.upsert_group_member(room.id, identity.peer_id, identity.display_name)
                timestamp = time.time()
                for identity, content in ((attacker, b'attacker content'), (alice, b'honest content')):
                    message = GroupMessagePayload('disclosed-id', room.id, identity.peer_id, cara.peer_id, timestamp, b'')
                    message.origin_signature = identity.signing_private_key.sign(group_origin_signed_bytes(
                        message.message_id, room.id, identity.peer_id, timestamp, None, hashlib.sha256(content).hexdigest()))
                    message.encrypted_content = encrypt_for_recipient(cara.encryption_public_key_bytes(), content, message.associated_data())
                    message.signature = identity.signing_private_key.sign(message.signed_bytes())
                    peer = SimpleNamespace(peer_id=identity.peer_id, signing_public_key=identity.signing_public_key_bytes(), supports=lambda _: True)
                    await router.handle_packet(peer, Packet(PacketType.GROUP_MESSAGE, message.encode()))
                rows = await victim.get_group_messages(room.id)
                self.assertEqual([(row['sender_id'], row['content']) for row in rows], [(attacker.peer_id, 'attacker content')])
                # Only the first copy's sender gets a receipt; the conflicting one gets none.
                self.assertEqual([target for target, _ in received], [attacker.peer_id])
                await sender.save_group_message(dict(message_id='disclosed-id', group_id=room.id,
                                                    sender_id=alice.peer_id, content='honest content', created_at=timestamp))
                await sender.set_group_delivery('disclosed-id', cara.peer_id, 'sent')
                self.assertEqual((await sender.get_group_deliveries('disclosed-id'))[0]['status'], 'sent')
            finally:
                await victim.close()
                await sender.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
