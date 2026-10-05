# Project trash and mobile navigation

My workspace offers Delete project. The inline confirmation names the project, explains recovery, and requires acknowledgement that no SCAD command is running. Move to Trash relocates the entire project directory under data/.scad-trash/<UUID>/project. Restore project returns it to its original name; existing names are never overwritten. There is no permanent erase action.

The server allows DELETE /api/projects/:id?version=<readVersion> and POST /api/trash/:id/restore, with the local capability, exact Origin, Host and cross-site protections. Other material endpoints stay read-only. GET /api/trash does not create directories. The reader excludes the reserved trash directory. Deletion rejects changed snapshots and pending publication. Folder/link containment checks precede moves; operations within this server are serialized. Failed entries remain on disk for recovery rather than being purged.

There is no interprocess writer lock: stop CLI work before moving or restoring a project. The acknowledgement is not an automatic process detector. Restored projects preserve all their files; Flow browser layouts remain scoped to project/content versions. Trash records survive server restart and are loaded on the home screen.

On mobile Browse projects starts collapsed, toggles aria-expanded and reveals the labeled project search/list. Desktop navigation remains visible.

Verification: 578 tests / 51 files PASS before the final confirmation UI adjustment; focused UI and type/lint/build checks after that adjustment PASS. Backend tests exercised removal/restoration of disposable projects, byte preservation, stale version rejection, restore collision and Origin/capability rejection. Chrome keyboard activation verified confirmation, initially disabled Move to Trash, cancellation, and mobile toggle false/true. Real projects were not deleted. Screenshot saved outside the repository. No interprocess concurrency guarantee or permanent deletion is provided.
