---------------------------- MODULE UploadCommit ----------------------------
(***************************************************************************
  Concurrent commit protocol for one artifact name in one workflow run.

  Each action below is one await / one S3 call in the code. Names match
  the repo. Read the mapping in the skill before you edit this file.

  src/upload/run-upload.ts
    GetManifestWithMeta, guard choice, PutBlobStream, CommitManifest,
    DeleteOwnBlobBestEffort (catch), DeleteOldBlobBestEffort (success)
  src/storage/s3-store.ts
    If-None-Match: * (create-only), If-Match (compare-and-swap),
    putBlobStream, deleteBlobBestEffort
  src/storage/memory-store.ts
    the same WriteGuard checks, atomic inside commitManifest
  src/download/run-download.ts
    download reads only a committed, non-expired manifest, then its blobKey

  CrashAfterPutBlob is the runner dying after putBlobStream returns and
  before commitManifest — AC-19 (incomplete upload stays invisible).
 ***************************************************************************)

EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  u1, u2,          \* two jobs that share one artifact name
  Seeded,          \* TRUE: a live attempt-1 artifact already exists
  AllOverwrite,    \* inputs.overwrite for both jobs
  JobAttempt       \* GITHUB_RUN_ATTEMPT for both jobs

Uploaders == {u1, u2}
Overwrite == [u \in Uploaders |-> AllOverwrite]
Attempt == [u \in Uploaders |-> JobAttempt]

ASSUME u1 # u2
ASSUME Seeded \in BOOLEAN
ASSUME AllOverwrite \in BOOLEAN
ASSUME JobAttempt \in {1, 2}

None == 0

VARIABLES
  pc,                 \* per-job program counter in runUpload
  guardMode,          \* WriteGuard.mode: "none" | "create-only" | "cas"
  guardEtag,          \* WriteGuard.etag, or None
  ownBlob,            \* blobKey this job just put
  oldBlob,            \* existing.manifest.blobKey snapshotted at GetManifest
  hasManifest,        \* a manifests/<name>.json object exists
  manifestBlob,       \* committed blobKey
  manifestEtag,       \* S3 ETag / memory-store etag
  manifestAttempt,    \* ArtifactManifestV1.runAttempt
  blobs,              \* blob keys that exist under blobs/
  nextBlob,           \* generateArtifactId (unique ids)
  nextEtag            \* next ETag after a successful PutObject

vars == <<pc, guardMode, guardEtag, ownBlob, oldBlob,
          hasManifest, manifestBlob, manifestEtag, manifestAttempt,
          blobs, nextBlob, nextEtag>>

Terminal == {"Done", "Failed", "Crashed"}

-----------------------------------------------------------------------------
\* Init. Seeded models a prior successful upload of this name at runAttempt 1.

Init ==
  /\ pc = [u \in Uploaders |-> "GetManifest"]
  /\ guardMode = [u \in Uploaders |-> "none"]
  /\ guardEtag = [u \in Uploaders |-> None]
  /\ ownBlob = [u \in Uploaders |-> None]
  /\ oldBlob = [u \in Uploaders |-> None]
  /\ IF Seeded THEN
       /\ hasManifest = TRUE
       /\ manifestBlob = 1
       /\ manifestEtag = 1
       /\ manifestAttempt = 1
       /\ blobs = {1}
       /\ nextBlob = 2
       /\ nextEtag = 2
     ELSE
       /\ hasManifest = FALSE
       /\ manifestBlob = None
       /\ manifestEtag = None
       /\ manifestAttempt = None
       /\ blobs = {}
       /\ nextBlob = 1
       /\ nextEtag = 1

-----------------------------------------------------------------------------
\* run-upload.ts:76-93 after store.getManifestWithMeta.
\* Guard is chosen from that snapshot; another job may commit before PutBlob.

GetManifestWithMeta(u) ==
  /\ pc[u] = "GetManifest"
  /\ IF ~hasManifest THEN
       /\ guardMode' = [guardMode EXCEPT ![u] = "create-only"]
       /\ guardEtag' = [guardEtag EXCEPT ![u] = None]
       /\ oldBlob' = [oldBlob EXCEPT ![u] = None]
       /\ pc' = [pc EXCEPT ![u] = "PutBlob"]
     ELSE IF Overwrite[u] \/ manifestAttempt < Attempt[u] THEN
       /\ guardMode' = [guardMode EXCEPT ![u] = "cas"]
       /\ guardEtag' = [guardEtag EXCEPT ![u] = manifestEtag]
       /\ oldBlob' = [oldBlob EXCEPT ![u] = manifestBlob]
       /\ pc' = [pc EXCEPT ![u] = "PutBlob"]
     ELSE
       \* ArtifactConflictError before any blob is written
       /\ pc' = [pc EXCEPT ![u] = "Failed"]
       /\ UNCHANGED <<guardMode, guardEtag, oldBlob>>
  /\ UNCHANGED <<ownBlob, hasManifest, manifestBlob, manifestEtag,
                 manifestAttempt, blobs, nextBlob, nextEtag>>

\* run-upload.ts:103-109 store.putBlobStream. Blob key is unique (new ArtifactId).

PutBlobStream(u) ==
  /\ pc[u] = "PutBlob"
  /\ ownBlob' = [ownBlob EXCEPT ![u] = nextBlob]
  /\ blobs' = blobs \union {nextBlob}
  /\ nextBlob' = nextBlob + 1
  /\ pc' = [pc EXCEPT ![u] = "CommitManifest"]
  /\ UNCHANGED <<guardMode, guardEtag, oldBlob, hasManifest,
                 manifestBlob, manifestEtag, manifestAttempt, nextEtag>>

\* Runner dies after putBlobStream returns, before commitManifest (AC-19).

CrashAfterPutBlob(u) ==
  /\ pc[u] = "CommitManifest"
  /\ pc' = [pc EXCEPT ![u] = "Crashed"]
  /\ UNCHANGED <<guardMode, guardEtag, ownBlob, oldBlob, hasManifest,
                 manifestBlob, manifestEtag, manifestAttempt,
                 blobs, nextBlob, nextEtag>>

\* run-upload.ts:138 and s3-store.ts:307-333 / memory-store.ts:126-150.
\* create-only: If-None-Match: * / reject if the key exists.
\* cas: If-Match: <etag> / reject on etag mismatch.

CommitManifest(u) ==
  /\ pc[u] = "CommitManifest"
  /\ IF guardMode[u] = "create-only" THEN
       IF hasManifest THEN
         /\ pc' = [pc EXCEPT ![u] = "CleanupOwnBlob"]
         /\ UNCHANGED <<hasManifest, manifestBlob, manifestEtag,
                        manifestAttempt, nextEtag>>
       ELSE
         /\ hasManifest' = TRUE
         /\ manifestBlob' = ownBlob[u]
         /\ manifestEtag' = nextEtag
         /\ manifestAttempt' = Attempt[u]
         /\ nextEtag' = nextEtag + 1
         /\ pc' = [pc EXCEPT ![u] = "Done"]
     ELSE
       IF (~hasManifest) \/ (manifestEtag # guardEtag[u]) THEN
         /\ pc' = [pc EXCEPT ![u] = "CleanupOwnBlob"]
         /\ UNCHANGED <<hasManifest, manifestBlob, manifestEtag,
                        manifestAttempt, nextEtag>>
       ELSE
         /\ hasManifest' = TRUE
         /\ manifestBlob' = ownBlob[u]
         /\ manifestEtag' = nextEtag
         /\ manifestAttempt' = Attempt[u]
         /\ nextEtag' = nextEtag + 1
         /\ pc' = [pc EXCEPT ![u] = "CleanupOldBlob"]
  /\ UNCHANGED <<guardMode, guardEtag, ownBlob, oldBlob, blobs, nextBlob>>

\* run-upload.ts:139-141 catch: deleteBlobBestEffort of the blob just put.

DeleteOwnBlobBestEffort(u) ==
  /\ pc[u] = "CleanupOwnBlob"
  /\ blobs' = blobs \ {ownBlob[u]}
  /\ pc' = [pc EXCEPT ![u] = "Failed"]
  /\ UNCHANGED <<guardMode, guardEtag, ownBlob, oldBlob, hasManifest,
                 manifestBlob, manifestEtag, manifestAttempt,
                 nextBlob, nextEtag>>

\* run-upload.ts:144-146: after a successful replace, delete the snapshotted blob.

DeleteOldBlobBestEffort(u) ==
  /\ pc[u] = "CleanupOldBlob"
  /\ blobs' = blobs \ {oldBlob[u]}
  /\ pc' = [pc EXCEPT ![u] = "Done"]
  /\ UNCHANGED <<guardMode, guardEtag, ownBlob, oldBlob, hasManifest,
                 manifestBlob, manifestEtag, manifestAttempt,
                 nextBlob, nextEtag>>

\* End state. Without this, a finished run is a deadlock.

Idle ==
  /\ \A u \in Uploaders: pc[u] \in Terminal
  /\ UNCHANGED vars

-----------------------------------------------------------------------------

Next ==
  \/ \E u \in Uploaders:
       \/ GetManifestWithMeta(u)
       \/ PutBlobStream(u)
       \/ CrashAfterPutBlob(u)
       \/ CommitManifest(u)
       \/ DeleteOwnBlobBestEffort(u)
       \/ DeleteOldBlobBestEffort(u)
  \/ Idle

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
\* TypeOK — every variable stays in the range the code uses.

TypeOK ==
  /\ pc \in [Uploaders -> {"GetManifest", "PutBlob", "CommitManifest",
                           "CleanupOwnBlob", "CleanupOldBlob"} \union Terminal]
  /\ guardMode \in [Uploaders -> {"none", "create-only", "cas"}]
  /\ guardEtag \in [Uploaders -> Nat]
  /\ ownBlob \in [Uploaders -> Nat]
  /\ oldBlob \in [Uploaders -> Nat]
  /\ hasManifest \in BOOLEAN
  /\ manifestBlob \in Nat
  /\ manifestEtag \in Nat
  /\ manifestAttempt \in Nat
  /\ blobs \subseteq Nat
  /\ nextBlob \in Nat
  /\ nextEtag \in Nat

\* A download of this name (run-download.ts:37-41) either fails not-found
\* or opens the blobKey from the committed manifest. That blob must exist.

CommittedBlobExists ==
  hasManifest => manifestBlob \in blobs

\* AC-06, including the parallel case: two overwrite:false jobs in the same
\* runAttempt cannot both publish. The winner's content is the live artifact.

SameAttemptExclusive ==
  \A a \in {1, 2}:
    Cardinality({u \in Uploaders :
                  /\ pc[u] = "Done"
                  /\ Overwrite[u] = FALSE
                  /\ Attempt[u] = a}) <= 1

\* A job that reached Done stays the live artifact unless a later job
\* replaced it using the etag/blob it actually read (compare-and-swap).
\* Fails if CommitManifest writes unconditionally (lost update).

DoneIsCurrentOrReplacedBySnapshot ==
  \A u \in Uploaders:
    pc[u] = "Done" =>
      \/ (hasManifest /\ manifestBlob = ownBlob[u])
      \/ \E v \in Uploaders:
           /\ v # u
           /\ oldBlob[v] = ownBlob[u]
           /\ pc[v] \in {"CommitManifest", "CleanupOldBlob", "Done",
                         "CleanupOwnBlob", "Failed"}

=============================================================================
