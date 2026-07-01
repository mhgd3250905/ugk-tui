# Task Marketplace Function Status

Date: 2026-07-01

## Implemented

| Priority | Function | Status |
| --- | --- | --- |
| P0 | User task upload | Upload page posts zip or source URL to `/api/tasks/submit`; submissions stay pending. |
| P0 | Upload storage | Uploaded artifacts use the `TASK_UPLOADS` R2 binding; metadata is stored in D1. |
| P0 | Moderation/publish | Admin-only review queue publishes or rejects submissions; published tasks enter the community catalog. |
| P1 | My account dashboard | Account page shows favorites, submissions, downloads, and profile identity. |
| P1 | Real sorting/filtering | Marketplace supports text search, category filter, and sorting by name/downloads/likes/newest. |
| P1 | Per-task user state | Task stats include liked, favorited, and downloaded state for signed-in users. |
| P1 | Reporting | Signed-in users can report a task once; admins see the report queue. |
| P2 | Versioning | Published submissions create immutable `task_versions`; official manifest entries include `1.0.0`. |
| P2 | Stats detail | Per-task stats detail rolls download events up by day. |
| P2 | Admin tools | Admin page is gated by configured GitHub logins and lists submissions plus reports. |

## Operational Follow-Ups

- Rotate any secrets that were pasted into chat after deployment is verified.
- Decide whether community-published tasks should become installer-visible through the static manifest or a dynamic manifest endpoint.
- Add richer moderation actions later if needed, such as closing reports without code changes.
