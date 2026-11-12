# Knowledge and local data

Remember keeps original evidence, maintained knowledge, and operational state separate in ownership. Moving all files into six folders would hide the distinction without repairing learning or retrieval.

## Maintained knowledge

Markdown remains canonical, identified by `(spaceId, slug)`. SQLite Wiki history owns revisions, source quotations, proposals, dismissals, and undo. Page paths, human edits, and each Space's Auto/Suggest choice remain authoritative.

The six visible categories remain compatible navigation. Their responsibilities are now explicit:

| Subject | Owner | Contents |
| --- | --- | --- |
| Computer user | Existing private self profile, otherwise `people/me` | Supported identity, preferences, current responsibilities, short project-role summaries and links |
| Collaborator or personal relationship | `people/<person>` in its appropriate Space | Supported identity/relationship, concise role boundaries and project links |
| Durable undertaking | `projects/<project>` and topic children | Goal, current state, detailed responsibilities, decisions, constraints and remaining work |
| Reusable knowledge | `decisions`, `research`, `processes`, `concepts` | Knowledge useful independently across projects; project-specific material stays with its project |

People are not an address book. A passing mention, message recipient, guessed audio speaker, or matching first name does not establish a person or relationship. Distinct person slugs are never heuristically merged. An observed document remains an observed document; assistant claims do not become verified biography. There is no parallel entity database or forced category migration.

Generation and review share one ownership policy in `knowledgeOrganization.ts`. Person orientation can use a fact also relevant to a project without duplicating the project's narrative. Ordinary Markdown links connect same-Space pages and resolve correctly in the Wiki, editor, history and proposal previews.

## Learning and retrieval

Normal agent/Day/Timeline learning now considers self and collaborators explicitly. A bounded private self profile is supplied to Remember's local chat with a revision and source URL. Current source availability, exclusions and page revisions are checked again before relying on it. The change does not enable retired automatic external-agent hooks.

## User brief

Every reader that tailors its work to the person starts from the same brief, assembled in `userBrief.ts`:

- **Profile**: the private self profile page. It holds identity, responsibilities and stated preferences, plus a Working style section with attributed, dated observations of how the person works and communicates. The Day review maintains it through the normal reviewed Wiki flow, and a material profile change takes priority among a Day's knowledge suggestions.
- **Activity**: usual hours, projects, apps and recently abandoned Tasks over the last 21 days, computed by code in `userActivity.ts` from at least three recorded Days. It is never written to the Wiki, so it is always current and cannot outlive deleted data.

Readers: Remember's chat (context `profile` and `activity`), proactive review (`userContext`), the Day review (profile pinned first in `wiki_pages`, activity in `user_activity`) and external agents through `remember_brief` / `remember brief`. The brief is background for relevance and tone. It is never a citable source and never establishes a commitment, ownership or a current event.

The Day review lists every Wiki page so no subject is duplicated. Whole-page bodies are given room in this order: the self profile, pages a person edited since Remember's last rewrite, pages whose title or slug today's analysis names, then most recently updated.

Dismissing a pending knowledge proposal now records the same durable, page- and Space-scoped rejection used by undo. Replaying its content or quoted evidence under another source ID cannot create another proposal or bypass the rejection by switching the Space to Auto. A genuinely later original user statement can reinstate it; a newer assistant paraphrase cannot. Repeated dismissal preserves the original rejection time. Existing historical dismissals are not backfilled, and detecting semantically equivalent rewritten claims remains the evidence reviewer's responsibility.

Search uses whole-word terms, supports a single collaborator name, and follows one bounded link hop among person and project pages in the selected local Space.

Imported agent evidence resolves to the original journal event and must match provider, session, role, observation time and quotation. Expired, excluded, deleted or pre-consent text cannot be replaced with a quotation retained in a Wiki revision.

Existing installations receive a source-based repair for missing Personal people/profile pages while agent learning, AI consent and source access permit it. It reads currently retained original evidence referenced by Wiki history, processes at most eight whole sources per run, and uses the existing evidence reviewer and revision-aware writer. Every successful source gets opaque durable coverage; adding pages or changing settings does not replay earlier sources or recreate deleted pages. Failed sources retain durable backoff while other sources progress; nothing unprocessed is marked covered. Sources over the whole-message budget remain unacknowledged. Policy, page and proposal changes invalidate in-flight work; shutdown aborts its model call and prevents later writes. Only currently permitted page bodies and source-backed proposal context reach generation. Existing profiles and project bodies are not rewritten by this repair. Evidence never retained in Wiki history, or no longer available under current consent, is outside its backfill coverage.

## Storage ownership

| Class | Existing owner/location | Lifecycle |
| --- | --- | --- |
| Original sources | Evidence database, audio, imported agent journal, dictation | Existing user deletion/privacy rules; processed agent text expires after 30 days with identity tombstones |
| Maintained knowledge | `daily-review/wiki`, per-Space Markdown, `wiki.sqlite` | Durable revisions, human edits, dismissal and undo |
| Derived projections | Proactive Day snapshots inside `evidence.sqlite` | Every historic snapshot ID retained; large immutable provenance shared and compressed |
| Runtime/cache/assets | Chromium caches, model assets, logs, agent runtime | Separate from canonical Wiki and original evidence; this change does not delete these files |

The measured growth came mainly from repeated complete provenance/lineage arrays in immutable Day snapshots. `ProactiveDayStorage` now stores fields over 16 KB as immutable SHA-256-addressed deflate payloads, with a 64 MiB decoded limit and integrity verification. Hydration precedes hashing and validation, preserving historical source references exactly. No snapshot garbage collection or raw-source retention change is introduced. Shared payloads are removed only after their last referencing snapshot is deleted or replaced.

New writes use the compact representation. One legacy row is visited per normal sync, with a durable row cursor and completion marker to avoid repeated scans. Savepoints isolate migration errors from Day publication; an oversized or corrupt old row is retained and skipped rather than blocking later work. Indexed payload references keep cleanup bounded. Schema 18 prevents older binaries from interpreting the compact fields. Downgrade requires expanding snapshots with the existing offline rollback helper against a backed-up profile; lowering `user_version` alone is unsafe.

Freed SQLite pages are reused. The running app never performs an automatic `VACUUM`. `scripts/compact-data-copy.ts` pins a read-only SQLite snapshot, checks available disk, creates a new private copy, compares hydrated snapshot hashes and original state, then compacts and checks only that copy. It never replaces the installed app's database.
