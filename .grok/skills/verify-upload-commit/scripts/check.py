#!/usr/bin/env python3
"""Check that the upload-commit TLA+ model still describes the code, then run TLC."""

from __future__ import annotations

import hashlib
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
MODEL_DIR = SKILL_DIR / "model"
CACHE_DIR = SKILL_DIR / ".tool-cache"
REPO_ROOT = SKILL_DIR.parents[2]

TLC_VERSION = "1.7.4"
TLC_JAR_URL = (
    "https://github.com/tlaplus/tlaplus/releases/download/"
    f"v{TLC_VERSION}/tla2tools.jar"
)
TLC_JAR_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
JAVA_IMAGE = (
    "eclipse-temurin:21-jre@sha256:"
    "d77e090ae1f6970c047b443c6f0a6c1358b0426d44432bb5a7753408cd43de0d"
)

CONFIGS = (
    "UploadCommit.cfg",
    "UploadCommitOverwrite.cfg",
    "UploadCommitRerun.cfg",
)


class CheckError(Exception):
    pass


def repo_file(*parts: str) -> Path:
    path = REPO_ROOT.joinpath(*parts)
    if not path.is_file():
        raise CheckError(f"missing source file {path}")
    return path


def read_repo(*parts: str) -> str:
    return repo_file(*parts).read_text(encoding="utf-8")


def require_in_order(label: str, text: str, snippets: list[str]) -> None:
    pos = -1
    for snippet in snippets:
        found = text.find(snippet, pos + 1)
        if found < 0:
            raise CheckError(
                f"{label}: expected {snippet!r} after position {pos}. "
                "The model no longer describes this file. Update the TLA+ "
                "actions to match the code, or the change broke the protocol."
            )
        pos = found


def check_correspondence() -> None:
    upload = read_repo("src", "upload", "run-upload.ts")
    require_in_order(
        "src/upload/run-upload.ts runUpload",
        upload,
        [
            "deps.store.getManifestWithMeta(inputs.scope, artifactName)",
            "guard = {mode: 'create-only'}",
            "existing.expired ||",
            "inputs.overwrite ||",
            "existing.manifest.runAttempt < inputs.scope.runAttempt",
            "{mode: 'compare-and-swap', etag: existing.etag}",
            "throw new ArtifactConflictError(",
            "const blobResult = await deps.store.putBlobStream({",
            "await deps.store.commitManifest(inputs.scope, manifest, guard)",
            "await deps.store.deleteBlobBestEffort(blobResult.blobKey)",
            "await deps.store.deleteBlobBestEffort(existing.manifest.blobKey)",
        ],
    )
    if upload.find("putBlobStream") > upload.find("commitManifest"):
        raise CheckError(
            "src/upload/run-upload.ts: putBlobStream must run before "
            "commitManifest (blob first, then manifest)."
        )

    s3 = read_repo("src", "storage", "s3-store.ts")
    require_in_order(
        "src/storage/s3-store.ts commitManifest",
        s3,
        [
            "if (guard.mode === 'create-only') {",
            "baseInput.IfNoneMatch = '*'",
            "} else if (guard.mode === 'compare-and-swap') {",
            "baseInput.IfMatch = guard.etag",
            "if (isPreconditionFailed(error))",
        ],
    )

    memory = read_repo("src", "storage", "memory-store.ts")
    require_in_order(
        "src/storage/memory-store.ts commitManifest",
        memory,
        [
            "if (guard.mode === 'create-only' && existing)",
            "guard.mode === 'compare-and-swap' &&",
            "(!existing || existing.etag !== guard.etag)",
        ],
    )

    download = read_repo("src", "download", "run-download.ts")
    require_in_order(
        "src/download/run-download.ts named download",
        download,
        [
            "const found = await deps.store.getManifestWithMeta(inputs.scope, inputs.name)",
            "if (!found || found.expired)",
            "store.openBlobStream(manifest.blobKey)",
        ],
    )
    print("correspondence: ok")


def ensure_jar() -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    jar = CACHE_DIR / "tla2tools.jar"
    if jar.is_file() and hashlib.sha256(jar.read_bytes()).hexdigest() == TLC_JAR_SHA256:
        return jar
    print(f"downloading TLC {TLC_VERSION} -> {jar}")
    urllib.request.urlretrieve(TLC_JAR_URL, jar)
    digest = hashlib.sha256(jar.read_bytes()).hexdigest()
    if digest != TLC_JAR_SHA256:
        jar.unlink(missing_ok=True)
        raise CheckError(
            f"tla2tools.jar sha256 mismatch: got {digest}, want {TLC_JAR_SHA256}"
        )
    return jar


def run_cmd(argv: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        cwd=cwd,
        text=True,
        capture_output=True,
        check=False,
    )


def tlc_argv(jar: Path, config: str, metadir: Path) -> list[str]:
    return [
        "java",
        "-XX:+UseParallelGC",
        "-cp",
        str(jar),
        "tlc2.TLC",
        "-workers",
        "1",
        "-fp",
        "0",
        "-metadir",
        str(metadir),
        "-config",
        config,
        "UploadCommit.tla",
    ]


def run_tlc_local(jar: Path, config: str, metadir: Path) -> subprocess.CompletedProcess[str]:
    java = shutil.which("java")
    if java is None:
        raise FileNotFoundError("java")
    argv = tlc_argv(jar, config, metadir)
    argv[0] = java
    return run_cmd(argv, MODEL_DIR)


def run_tlc_docker(jar: Path, config: str, metadir: Path) -> subprocess.CompletedProcess[str]:
    docker = shutil.which("docker")
    if docker is None:
        raise CheckError(
            "Need Java 11+ (java on PATH) or Docker to run TLC "
            f"{TLC_VERSION}. Install either, then rerun."
        )
    return run_cmd(
        [
            docker,
            "run",
            "--rm",
            "-v",
            f"{MODEL_DIR}:/spec:ro",
            "-v",
            f"{jar}:/tools/tla2tools.jar:ro",
            "-w",
            "/spec",
            JAVA_IMAGE,
            "java",
            "-XX:+UseParallelGC",
            "-cp",
            "/tools/tla2tools.jar",
            "tlc2.TLC",
            "-workers",
            "1",
            "-fp",
            "0",
            "-metadir",
            "/tmp/tlc-states",
            "-config",
            config,
            "UploadCommit.tla",
        ],
        MODEL_DIR,
    )


def run_tlc(jar: Path, config: str) -> str:
    with tempfile.TemporaryDirectory(prefix="tlc-") as tmp:
        metadir = Path(tmp)
        try:
            result = run_tlc_local(jar, config, metadir)
        except FileNotFoundError:
            result = run_tlc_docker(jar, config, metadir)
    out = (result.stdout or "") + (result.stderr or "")
    passed = (
        result.returncode == 0
        and "Model checking completed. No error has been found." in out
        and "is violated" not in out
    )
    if not passed:
        raise CheckError(
            f"TLC failed on {config} (exit {result.returncode}):\n{out}"
        )
    states = ""
    for line in out.splitlines():
        if "states generated," in line.lower() and "distinct states found" in line.lower():
            states = line.strip()
            break
    print(f"TLC {config}: pass" + (f" ({states})" if states else ""))
    return out


def main() -> int:
    try:
        if not (MODEL_DIR / "UploadCommit.tla").is_file():
            raise CheckError(f"missing model at {MODEL_DIR / 'UploadCommit.tla'}")
        check_correspondence()
        jar = ensure_jar()
        for config in CONFIGS:
            run_tlc(jar, config)
    except CheckError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
