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

Linux AppImages use AppImageUpdate's external zsync format separately from
Tauri's signed updater. Each AppImage embeds a link to the latest stable GitHub
release and publishes its `.zsync` metadata beside the AppImage. Snapshot
AppImages therefore update to the latest stable release, not to another
snapshot.
