import unittest

from meshtalk.network_monitor import NetworkMonitor, NetworkState


class NetworkMonitorTest(unittest.IsolatedAsyncioTestCase):
    async def test_notifies_once_when_gateway_or_local_ip_changes(self):
        states = iter([
            NetworkState("192.0.2.1", "192.0.2.20"),
            NetworkState("192.0.2.1", "192.0.2.21"),
            NetworkState("192.0.2.254", "192.0.2.21"),
        ])
        changes = []

        async def on_change(previous, current):
            changes.append((previous, current))

        monitor = NetworkMonitor(on_change, state_provider=lambda: next(states))
        await monitor.start()
        try:
            self.assertTrue(await monitor.poll_once())
            self.assertTrue(await monitor.poll_once())
            self.assertEqual(len(changes), 2)
            self.assertEqual(changes[0][0].local_ip, "192.0.2.20")
            self.assertEqual(changes[1][1].gateway, "192.0.2.254")
        finally:
            await monitor.stop()

    async def test_same_state_does_not_refresh(self):
        state = NetworkState("192.0.2.1", "192.0.2.20")
        calls = 0

        async def on_change(previous, current):
            nonlocal calls
            calls += 1

        monitor = NetworkMonitor(on_change, state_provider=lambda: state)
        await monitor.start()
        try:
            self.assertFalse(await monitor.poll_once())
            self.assertEqual(calls, 0)
        finally:
            await monitor.stop()
