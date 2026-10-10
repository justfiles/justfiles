# File mode synchronization: prior art

Research checked 2026-10-03. This note records evidence for the interface discussion; it does not change the agreed design.

## Dropbox

Dropbox explicitly documents support for synchronizing POSIX executable bits using its metadata mechanism. Its supported Windows alternate data streams include `:com.dropbox.posix.executable`, demonstrating that a client can preserve a property even where the native filesystem does not interpret it as a POSIX permission. The documentation does not specify preservation of every owner/group/other read/write bit or setuid, setgid, and sticky bits. Do not interpret executable support as a full-mode preservation guarantee. [Dropbox Help: supported extended attributes](https://help.dropbox.com/sync/extended-attributes) (updated 2024-12-18).

The public Files API is a separate contract. Its current `FileMetadata` and upload `CommitInfo` schemas have no native POSIX-mode or executable field; upload `mode` means add/overwrite/revision-checked update. Arbitrary application properties do not establish a desktop-client permission contract. [Dropbox's public API specification](https://github.com/dropbox/dropbox-api-spec/blob/main/files.stone).

## Google Drive

The public Drive API's `File` resource has no native POSIX-mode or executable field. It does expose arbitrary `properties` and private `appProperties`, so an application can store its own metadata, but that is not a promise that Drive for desktop interprets or preserves it. [Google Drive File reference](https://developers.google.com/workspace/drive/api/reference/rest/v3/files).

Drive's `Permission` resource controls access by Google users, groups, domains, and roles such as reader or writer. These sharing permissions are not POSIX mode bits. [Google Drive Permission reference](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions).

No reliable first-party guarantee for round-tripping full POSIX modes through Drive for desktop was found in this review. Google's desktop troubleshooting documentation explains that the client needs local read/write access; it does not establish permission preservation. Absence from the public API alone is not proof of what the desktop client can or cannot preserve. [Drive for desktop troubleshooting](https://support.google.com/drive/answer/2565956?hl=en).

## Open-source tools

| Tool | Documented behavior |
| --- | --- |
| Syncthing | Synchronizes permissions where supported; on Windows its documented mapping is limited to the read-only bit. Ownership and extended attributes are separate options. `ignorePerms` lets a folder omit permission information, useful for filesystems or environments that cannot apply it. [FAQ](https://docs.syncthing.net/users/faq.html#what-things-are-synced), [configuration](https://docs.syncthing.net/users/config.html#config-option-folder.ignoreperms). |
| Unison | Uses a configurable permission mask. The default is `0o1777`: ordinary rwx plus sticky, excluding setuid and setgid. Its source explicitly distinguishes Unix and Windows permission support. Full-bit propagation is available by changing the mask. [Current permission code and embedded documentation](https://github.com/bcpierce00/unison/blob/master/src/props.ml). |
| rsync | `--perms` preserves source permissions; `--executability` provides a narrower regular-file policy when full permission preservation is disabled. Its `--fake-super` option stores privileged or restrictive attributes separately while keeping the actual files manageable by the receiving user. [Official manual](https://rsync.samba.org/ftp/rsync/rsync.1). |
| rclone | Metadata preservation is opt-in with `--metadata` and depends on the backend. Local-to-local transfers can preserve mode and other attributes on supported systems. Its documented metadata transfer occurs with object uploads, so metadata-only changes are not generally propagated by ordinary sync. It distinguishes preserving metadata from interpreting it on the destination. [Metadata documentation](https://rclone.org/docs/#metadata-support). |

## Concerns with full mode

Ordinary rwx permissions occupy `0o777`. The broader POSIX mask `0o7777` also includes setuid, setgid, and sticky. Those extra bits affect execution credentials, directory group inheritance, or who may remove entries. Mode does not include owner/group identities or the full access-control list. [Linux inode documentation](https://man7.org/linux/man-pages/man7/inode.7.html).

The design implications are:

- **Portability:** a mode value can be preserved as data even where the host cannot apply it. Syncthing and Unison demonstrate that native permission handling needs platform-specific rules; Dropbox's executable metadata and rclone's metadata model demonstrate preservation beyond native interpretation.
- **Local identity:** copying `0o660` does not ensure access for the same people on two machines, because the owning user and group may differ. Supporting identical access policy would require a separate identity/ownership design. Syncthing treats [ownership synchronization](https://docs.syncthing.net/advanced/folder-sync-ownership.html) separately.
- **Continued access:** applying restrictive permissions to backing files or directories can prevent an ordinary sync process from reading or maintaining them. rsync's `--fake-super` is prior art for keeping the recorded attributes while retaining sufficient actual access. This is an issue for native application of mode, not for transmitting the number.
- **Special bits:** setuid/setgid have behavior beyond ordinary file access and depend on local ownership. Unison's default exclusion is a useful precedent for treating them separately. Sticky also has directory semantics and should be an explicit scope choice.

## Recommendation for neo-fs

This is a recommendation for the ongoing discussion, not an adopted interface change:

Syncing ordinary rwx permissions (`0o777`) is reasonable; the evidence does not require an executable-only model. Keep one `mode` representation. Define special-bit handling explicitly, with no automatic setuid/setgid application by default.

Separate the logical mode we preserve from the permissions a native backend can safely apply. A backend limitation must not silently erase the replicated value, and stored mode is not a substitute for authority authentication and authorization. The exact materialization and failure policy belongs in the interface contract before this scope is adopted. No new generic policy framework is needed merely to choose the initial behavior.
