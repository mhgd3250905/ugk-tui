# Task Marketplace Missing Functions

Date: 2026-06-30

## Implemented In This Pass

- Icon-only download, like, favorite, and copy controls with accessible labels.
- Real counters only: static seed values are zero; live values come from D1.
- Marketplace aggregate stats endpoint: `/api/stats`.
- Reset migration for earlier fake counters.

## Remaining Full-Function Backlog

| Priority | Function | Current Gap | Implementation Path | Acceptance |
| --- | --- | --- | --- | --- |
| P0 | User task upload | Users cannot submit taskbooks from the site | Add upload page, accept zip or GitHub URL, store submission metadata, validate required files, keep status pending | Logged-in user can submit a task and see pending status |
| P0 | Upload storage | Pages static files cannot be mutated at runtime | Use R2 for uploaded zip/artifacts, D1 for metadata, admin publish step to official catalog | Uploaded artifact is stored outside repo and linked to submission |
| P0 | Moderation/publish | No review workflow for executable taskbooks | Add admin-only review state: pending/approved/rejected/published | Only approved taskbooks appear in public catalog |
| P1 | My account dashboard | Account page only shows favorites | Show favorites, submissions, download history, and basic profile | Signed-in user sees their own activity |
| P1 | Real sorting/filtering | Search is client-only text filter | Add sort by downloads/likes/newest and category/tag filter | User can sort and filter without page reload |
| P1 | Per-task user state | Detail page does not show download history or install history | Add API state for liked/favorited/downloaded by current user | Signed-in detail page reflects user state |
| P1 | Reporting | No way to flag bad taskbooks | Add report endpoint and admin queue | Signed-in user can report a task once |
| P2 | Versioning | Task updates are not versioned | Add task_versions table and versioned manifest entries | Published task has immutable versions |
| P2 | Stats detail | Only aggregate counters exist | Add daily events rollups when traffic justifies charts | Detail page can show trend data |
| P2 | Admin tools | No admin UI | Add admin routes gated by configured GitHub logins | Admin can review submissions and reports |
