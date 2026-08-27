"""Authenticated, forward-secret E2EE message envelopes."""

from __future__ import annotations

import os

from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


def derive_shared_key(private_key: X25519PrivateKey, public_key: X25519PublicKey) -> bytes:
    """Derive a shared encryption key using X25519 key exchange and HKDF."""
    return HKDF(algorithm=SHA256(), length=32, salt=None, info=b"meshtalk-e2ee-v1").derive(
        private_key.exchange(public_key)
    )


def encrypt_for_recipient(recipient_public_bytes: bytes, plaintext: bytes, associated_data: bytes) -> bytes:
    """Encrypt with a one-time X25519 key. Output is ephemeral key, nonce, ciphertext."""
    recipient_public = X25519PublicKey.from_public_bytes(recipient_public_bytes)
    ephemeral_private = X25519PrivateKey.generate()
    key = derive_shared_key(ephemeral_private, recipient_public)
    nonce = os.urandom(12)
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, associated_data)
    ephemeral_public = ephemeral_private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return ephemeral_public + nonce + ciphertext


def decrypt_as_recipient(private_key: X25519PrivateKey, encrypted: bytes, associated_data: bytes) -> bytes:
    """Decrypt a message using recipient's private key and ephemeral public key from message."""
    if len(encrypted) < 32 + 12 + 16:
        raise ValueError("Encrypted message is too short")
    ephemeral_public = X25519PublicKey.from_public_bytes(encrypted[:32])
    key = derive_shared_key(private_key, ephemeral_public)
    return AESGCM(key).decrypt(encrypted[32:44], encrypted[44:], associated_data)
