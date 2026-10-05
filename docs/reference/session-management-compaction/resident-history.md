---
summary: "Worker-owned transcript acquisition, resident message windows, and remaining SDK migration"
read_when:
  - Changing which transcript payloads an active session retains
  - Migrating synchronous session history consumers to worker reads
  - Reviewing transcript revision fences, rewrites, or branch navigation
title: "Session transcript working sets"
---

**Status: private runtime migration, with synchronous SDK exceptions.** Committed
appends and rewrites evict old resident message payloads. Internal recovery and
navigation acquire omitted history through the storage owner. The proposed SDK
capability below remains a separate migration; this is not a universal resident
memory cap. This adds no configuration option and changes no schema, persisted bytes,
retention, session identity, or permissions.

The canonical transcript belongs to SQLite and its existing storage owners.
An active `SessionManager` should retain current context and bounded navigation
facts. Acquiring older history for an operation must not install complete
history into the live manager. See [session state on disk](/reference/session-management-compaction/store)
and [database access in workers](/reference/database-schemas/worker-access).

## Current boundary

Bounded opening selects raw entries by byte/event budget. The manager's entry
array and ID index share one payload graph; equal initial raw/model messages
also share immutable objects. Committed append and rewrite publication evicts
old message payloads and their resident parent-map entries using that same budget.
The newest message and user anchors, non-message SDK metadata, labeled targets,
and at most two assistant records needed for synchronous context-usage accounting
are retained exceptions. These exceptions can exceed the byte/event budget,
including an oversized complete custom payload. Accounting records preserve the
provider checkpoint and post-compaction usage decision without moving the admitted
context start backward.

A context-start entry ID survives raw eviction. Internal context readers acquire
the original context plus committed appends at the captured transcript version;
they do not restart at the newest resident row or silently replace the model's
existing prompt prefix. Rewrites remap this anchor, and explicit navigation or
context replacement publishes a new selection. Frozen row identity owns cached
byte counts; weak keys disappear with evicted payloads.

The selected raw entry, visible context leaf, and append cursor are distinct
navigation facts. Raw branch reads and cleanup include a selected entry excluded
from model context, even when a side-append cursor points elsewhere. Context
readers continue to omit that entry; serialization preserves the raw selection.
Parent facts retain both the exact raw rewrite anchor and its nearest canonical
ancestor. Eviction keeps canonical identity anchors only while resident entries,
the current cursor, or opaque links reference them; these anchors retain IDs and
ordinals, never payloads.

Generic history pages and branch reads refuse entries larger than their acquisition budget.
Admitted context and navigation reads preserve complete tool results, including selected
tool targets; recovery and replay scans can request the same exception. Each page admits
at most one oversized result, and collected context, navigation, and truncation stay within
64 MiB plus the largest complete result, checking bytes before acquiring payloads. Replay
scans release each page while collecting the assistant replacements they need. This
operation allowance is separate from resident memory and does not cap stored content.
Rewrite preparation applies that operation budget to its complete raw suffix,
including context-excluded rows and custom data, before acquiring suffix payloads.
It refuses excess acquisition before committing a replacement.
The resident navigation and eviction owner is `session-manager-resident-window.ts`;
`session-manager-core.ts` and `session-manager.ts` publish its views. Storage
acquisition lives in `session-accessor.sqlite-active-context.ts` and
`session-transcript-history-read.ts` under `src/config/sessions/`.

The manager is legitimately retained by `AgentSession` and active-run callbacks.
Reducing its working set complements correct run teardown; it does not replace
run settlement or allow clearing data that accepted writes still need.

## Resident snapshot

Publish one immutable snapshot containing the target binding, database
incarnation, transcript version, selected leaf/append cursor, admission fence,
and local manager revision. Retain the header, model/thinking settings,
boundary counts, current-context entries, and navigation links only for those
entries and their required omitted-boundary anchors.

The selection preserves custom messages, branch summaries, compaction/reset
retention, tool pairs, replay checkpoints, and prompt-series metadata. Raw and
model views share a frozen payload only when their representations agree;
entry-ID equality alone does not establish equivalence after projection,
redaction, or rewrite. Worker transfer creates receiver-side objects, so a
combined acquisition must avoid sending overlapping raw/model payloads twice.

The snapshot records its byte/event counts and completeness. Arbitrary-history
results remain operation-owned; they never become a second manager cache.
Committed append, suffix replacement, navigation, and rewrite operations must
publish a bounded replacement before notifying observers. Failed writes retain
the old snapshot. If a manager cannot adopt its own committed durable view, the
existing committed-write error path invalidates it; the write is never replayed.
After destructive commits, preserving a superseding view requires a published version
that includes the deletion; local navigation alone cannot keep the old view usable.
An outer AgentSession context publisher instead rejects a stale acquired view
without invalidating a newer legitimate manager selection. It revalidates its
captured history reader immediately before installing messages or accounting.
The active message array has its own publication fence: replacement also checks
the captured array and ordered message identities, since an agent can receive a
message before its transcript write settles. Navigation completion checks come
from the operation owner before its caller resumes. If context acquisition fails
before navigation commits, the owner restores its previous view only while the
selected version, binding, and navigation are still current.
If navigation or compaction commits but its model-context publication fails, the
exact old message view becomes unavailable. Further prompts and message writes
reject it until the session is reopened or valid replacement context is installed.
Canonical history remains readable, and a superseding view is left intact.

## Proposed asynchronous operations

Extend `prepareSessionTranscriptHydration` and its existing worker owner.
The following names describe proposed internal contracts, not current exports.
`prepareHistoryRead` synchronously captures the bound target, owner incarnation,
`SessionTranscriptContextVersion` (`generation`, `rawSeq`, `updatedAt`), admitted
turn receipt/anchor, selected branch, append cursor, and local manager revision.
Its returned read capability is bound to that live owner:

```ts
type HistorySelection =
  | { kind: "context"; maxBytes: number; maxEvents: number }
  | { kind: "entry"; entryId: string }
  | { kind: "branch-page"; leafId: string; cursor?: string; maxBytes: number; maxEvents: number }
  | { kind: "navigation"; fromId: string | null; targetId: string }
  | {
      kind: "custom-page";
      customType?: string;
      cursor?: string;
      maxBytes: number;
      maxEvents: number;
    };
```

`read(selection, signal)` returns the matching result and captured version.
Context returns shared raw/model payloads and resident facts. Entry returns an
entry or explicit absence. Branch/custom pages return ordered events, counts,
and an opaque continuation; only `complete: true` establishes the end of the
selection. Custom selection preserves historical order and duplicates unless
that custom type already defines a different semantic reducer. Navigation
returns target facts, common ancestor, and bounded labels/child summaries.

Each page validates its version inside the same SQLite snapshot used to read
it. A continuation binds the target, branch, version, and next position; it
never follows the latest active branch. Release each page before acquiring the
next rather than accumulating the entire transcript. Do not hold a SQLite
transaction across provider, plugin, or other asynchronous work. A later page
rejects a changed version; append-tolerant continuation requires separate proof
from the existing read-fence contract, not invented historical snapshot storage.

`prepareRewrite({ replacements, expectedVersion }, signal)` uses canonical
source rows and anchors in the existing worker, returning a preparation handle,
source-to-destination mapping, and byte/count deltas. It does not clone a live
manager. `commitRewrite(handle, signal)` rechecks writer authority and source
preconditions through the current writer, then returns committed IDs/version
and bounded replacement context. Cancellation closes unused preparations;
accepted writes retain custody until native settlement, even if their caller
stops waiting. Release handles in `finally` and on owner close or worker exit.

Before returning any result, recheck cancellation and current read authority.
Before publication, also recheck target binding, navigation revision, and
transcript version. A captured token is not current authority. Writes recheck
live authority at transaction admission and immediately before commit. Existing
SQLite admission and foreign-commit freshness rules remain the only owners of
schema and connection validation.

Results distinguish completed selection, exact-entry absence, version conflict,
owner loss, cancellation, and oversized-event refusal. Missing context or a
revoked owner is never an empty successful read. A stale read with no effect
may be reacquired by its operation owner; an uncertain or completed write must
be reconciled through its receipt, never retried as a fresh mutation.

## Oversized entries and cleanup

A strict byte budget cannot simultaneously retain an arbitrary complete row.
`session-manager-retained-data.test.ts` exposes the concrete conflict: a manager
opened with a 4,096-byte budget later appends a 5 MiB custom payload. Synchronous
`removeTrailingEntries` must remove an aborted assistant, preserve that custom
payload exactly, repair its parent, and keep `getEntry` consistent with storage.
Those assertions do not prove that every method is a shipped SDK contract, but
they do establish behavior that unconditional eviction would change.

Do not evict the custom row and report successful zero-removal cleanup from an
incomplete resident suffix. Zero removals requires proof that the selected
suffix has no match. Awaited cleanup must acquire enough version-fenced suffix
facts to resolve the predicate boundary, preserving custom bytes in the storage
owner when the predicate needs no payload. Arbitrary caller predicates that
inspect custom data need an explicit operation-sized acquisition or a versioned
API change; they cannot be serialized into a worker query by assumption.

Oversized raw acquisition must have an explicit result rather than silently
truncating bytes or skipping an event. Preserve existing strict-reader refusal
and model-only overflow projection rules. Any temporary complete-event exception
must be measured separately from the resident budget. Do not impose a new
stored-content cap to make a memory assertion pass.

## Consumer cutover

| Consumer                                        | Required contract                                                                                                                                                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compaction                                      | Acquire admitted current context and boundary anchors; preserve the pending user entry and tool pairs. Run hooks/providers without holding SQLite open, commit the marker, then publish committed context/accounting. |
| Replay repair                                   | Locate rejected checkpoints or affected thinking entries at the captured branch/version. Rewrite through the existing owner and remove stale prefix-bound checkpoints from re-appended suffix messages.               |
| Tool-result truncation                          | Build the existing plan from versioned current context, preserving trailing-result policy. Reconcile prompt projections against the committed replacement context.                                                    |
| Suffix cleanup                                  | Resolve the complete predicate boundary through bounded reverse acquisition. Preserve custom/opaque bytes and parent remapping; an incomplete window cannot establish a no-op.                                        |
| Tree navigation and summaries                   | Acquire omitted target/common-ancestor facts without installing complete history. Summarize only the required abandoned path, commit leaf/summary/labels, and publish bounded context.                                |
| Forking                                         | Copy the canonical selected path in the storage owner; return committed destination identity and bounded context.                                                                                                     |
| Rewrite preparation                             | Replace resident `byId` source assumptions and cloned detached managers with worker-owned source anchors and preparation handles. Preserve pending-input relocation, compaction identity, and side-append topology.   |
| Setup, settlement, guards, and accounting       | Consume admitted current-context snapshots or named latest-marker/boundary facts; do not scan history or maintain independent caches.                                                                                 |
| `ReadonlySessionManager` extension readers      | Introduce an awaited, versioned history capability. Keep identity/current-context facts synchronous; migrate bundled readers and hook preparation together.                                                           |
| `ProviderReplaySessionStateV2.getCustomEntries` | Replace its synchronous generic history requirement through an approved versioned capability; preserve ordering/duplicates and propagate read failures rather than returning empty state.                             |

The pure algorithms in `packages/agent-core` keep explicit prepared inputs.
They do not gain database access or a competing interpretation of boundaries.

## SDK and incognito migration boundaries

Current `ReadonlySessionManager` exposes synchronous entry/branch/tree readers.
`ProviderReplaySessionStateV2` still inherits synchronous `getCustomEntries`;
the [provider migration](/plugins/sdk-migration/how-to-migrate#await-provider-replay-metadata)
adds awaited writes, not awaited history reads. The synchronous readers already
exist in the published stable `v2026.9.5` source. A complete audit of the exported
reader surface and its completeness guarantees remains necessary.
Verify that evidence and obtain SDK-owner acceptance before changing a shipped
signature, completeness guarantee, or compatibility window. A legacy complete
synchronous-array contract cannot also promise universally bounded residency.
Do not silently redefine it as a partial window or keep an internal twin without
a verified public contract and removal boundary.

Production incognito continues to use its exact process-owned database until
the existing canonical worker migration activates. Never open another
`:memory:` database to satisfy a read. Capture the current owner and reject its
closure/replacement. This design does not activate that migration or change
incognito expiry, restart loss, or retention.

## First slice and completion evidence

Private runtime rewrites acquire canonical source rows and construct the suffix
in the storage owner, replacing the cloned-manager preparation path. Replay
repair, tool-result truncation, compaction, and settlement use versioned context
reads. Awaited cleanup walks the predicate boundary once before deciding whether
to mutate; it preserves oversized resident custom data by reference. Deprecated
synchronous cleanup refuses an eviction gap instead of treating incomplete
history as a successful no-op.

Async tree navigation acquires the target and abandoned path, then installs a
bounded selected context. Forking copies canonical history in the storage owner
and returns a bounded destination view. These operations recheck navigation,
target binding, transcript version, cancellation, and live ownership before
publication. Failed adoption of the manager's own committed view invalidates the
manager and cannot be replayed as a fresh write. If a newer selection supersedes
an outer context read, that read cannot overwrite AgentSession state; an already
committed operation reports a non-retryable publication failure while preserving
the newer selection.

Synchronous SDK custom-history readers preserve ordering and duplicates, so
non-message records remain resident. Synchronous settings, prompt-series,
cache-TTL, and boundary readers consume those retained records; label readers
also retain their target payloads. The existing deprecated synchronous mutation
and rewrite-preparation methods remain until the next Plugin SDK major. Removing
these exceptions requires the versioned SDK capability described above and its
owner acceptance. No universal resident bound is claimed for those contracts.

Deprecated synchronous reload preserves live pins at an unchanged target, leaf,
and transcript revision. A changed revision or deliberate navigation uses its
shipped strict bounded reload. Async runtime reloads acquire current retention
facts from the storage worker within the same snapshot as their selected payloads.

Freeze published canonical payloads and use replacement objects for sanitation,
redaction, and explicit rewrites. Eviction only drops references: it does not
edit a published prompt prefix, remove stored events, or change existing stable
prompt refresh rules. Compaction keeps its explicit context-replacement role.

Proof must cover 2k/10k/50k histories, 1,000 committed appends, oversized custom
cleanup, omitted-branch navigation, and rewritten history. Measure manager,
main-isolate, worker, and transient-operation retention separately; test actual
Gateway latency with concurrent sessions and release through real run settlement.
Exercise revision changes, target/authority loss after awaits, incognito owner
closure, cancellation, and commit-before-publication failure. Preserve compaction,
replay, redaction, and prompt-byte behavior. No schema or update migration follows
from these process-local projections; earlier code reads the same stored bytes.
