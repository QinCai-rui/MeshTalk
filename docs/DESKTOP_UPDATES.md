# Desktop signed updates

MeshTalk desktop bundles can use Tauri's signed updater once release signing is
configured. Until then, the app intentionally keeps the updater disabled and
only offers the release-download page.

To enable it, generate a Tauri updater key pair, store the private signing key
and password exclusively in CI secrets, and configure an HTTPS endpoint that
returns signed updater metadata. Set the public key and endpoint in the Tauri
updater configuration at build time; do not place private keys, signing
passwords, message contents, filenames, or endpoint-card payloads in source
control or release notes.

The release workflow must sign each platform bundle and publish the matching
signature plus a channel-specific manifest. Test update installation from a
separate install before enabling it for stable users. Snapshot/unstable and
stable channels must use independently generated manifests and must never allow
an unsigned fallback.
