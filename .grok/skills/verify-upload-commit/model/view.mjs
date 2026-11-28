export const title = "Upload commit for one artifact name"

const jobLabel = {
  GetManifest: "reading the manifest",
  PutBlob: "writing the blob",
  CommitManifest: "blob stored, committing the manifest",
  CleanupOwnBlob: "commit lost, deleting own blob",
  CleanupOldBlob: "published, deleting the previous blob",
  Done: "published",
  Failed: "failed",
  Crashed: "crashed after the blob"
}

export function state(v) {
  const store = v.hasManifest
    ? `live artifact (blob ${v.manifestBlob}, attempt ${v.manifestAttempt})`
    : "no artifact"
  const jobs = {}
  for (const u of Object.keys(v.pc)) {
    jobs[u] = jobLabel[v.pc[u]] ?? v.pc[u]
  }
  return {Store: store, ...jobs}
}

export function step(action) {
  if (action === "Idle") return null
  if (action.startsWith("GetManifestWithMeta")) return "the job reads the manifest"
  if (action.startsWith("PutBlobStream")) return "the job writes the blob"
  if (action.startsWith("CrashAfterPutBlob")) return "the runner dies before commit"
  if (action.startsWith("CommitManifest")) return "the job commits the manifest"
  if (action.startsWith("DeleteOwnBlobBestEffort")) return "the job deletes the blob it just wrote"
  if (action.startsWith("DeleteOldBlobBestEffort")) return "the job deletes the previous blob"
  return action
}

export function group(v) {
  if (!v.hasManifest) return "empty"
  return "live"
}

export const colors = {
  empty: "gray",
  live: "green"
}
