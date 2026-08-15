"""Persistent signing and encryption identity for a LanChat peer."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey,
    X25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, PublicFormat


def _raw_private(key: Ed25519PrivateKey | X25519PrivateKey) -> bytes:
    return key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())


def _raw_public(key: Ed25519PublicKey | X25519PublicKey) -> bytes:
    return key.public_bytes(Encoding.Raw, PublicFormat.Raw)


@dataclass
class Identity:
    """An Ed25519 signing identity plus a separate X25519 encryption key."""

    signing_private_key: Ed25519PrivateKey
    encryption_private_key: X25519PrivateKey
    peer_id: str
    display_name: str

    @classmethod
    def generate(cls, display_name: str = "Anonymous") -> Identity:
        signing_private_key = Ed25519PrivateKey.generate()
        peer_id = hashlib.sha256(_raw_public(signing_private_key.public_key())).hexdigest()
        return cls(signing_private_key, X25519PrivateKey.generate(), peer_id, display_name)

    @property
    def private_key(self) -> X25519PrivateKey:
        """Compatibility alias for the encryption private key."""
        return self.encryption_private_key

    def signing_public_key_bytes(self) -> bytes:
        return _raw_public(self.signing_private_key.public_key())

    def encryption_public_key_bytes(self) -> bytes:
        return _raw_public(self.encryption_private_key.public_key())

    def public_key_bytes(self) -> bytes:
        return self.encryption_public_key_bytes()

    def save(self, path: Path) -> None:
        path.mkdir(parents=True, exist_ok=True)
        key_path = path / "identity.json"
        key_path.write_text(json.dumps({
            "version": 2,
            "peer_id": self.peer_id,
            "display_name": self.display_name,
            "signing_private_key": _raw_private(self.signing_private_key).hex(),
            "encryption_private_key": _raw_private(self.encryption_private_key).hex(),
        }, indent=2))
        key_path.chmod(0o600)

    @classmethod
    def load(cls, path: Path) -> Identity | None:
        key_path = path / "identity.json"
        if not key_path.exists():
            return None
        data = json.loads(key_path.read_text())
        if data.get("version") != 2:
            # The old X25519-only format cannot authenticate a peer. Replace it
            # rather than continuing with an unauthenticated identity.
            return None
        signing_private_key = Ed25519PrivateKey.from_private_bytes(
            bytes.fromhex(data["signing_private_key"])
        )
        peer_id = hashlib.sha256(_raw_public(signing_private_key.public_key())).hexdigest()
        if peer_id != data["peer_id"]:
            raise ValueError("Identity peer ID does not match its signing key")
        return cls(
            signing_private_key,
            X25519PrivateKey.from_private_bytes(bytes.fromhex(data["encryption_private_key"])),
            peer_id,
            data["display_name"],
        )

    @classmethod
    def load_or_generate(cls, path: Path, display_name: str = "Anonymous") -> Identity:
        identity = cls.load(path)
        if identity is None:
            identity = cls.generate(display_name)
            identity.save(path)
        return identity
