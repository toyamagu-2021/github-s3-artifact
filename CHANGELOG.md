# Changelog

## [0.1.4](https://github.com/toyamagu-2021/github-s3-artifact/compare/v0.1.3...v0.1.4) (2026-11-28)


### Bug Fixes

* **terraform:** drop OIDC trust conditions STS does not map ([#29](https://github.com/toyamagu-2021/github-s3-artifact/issues/29)) ([8e65ed2](https://github.com/toyamagu-2021/github-s3-artifact/commit/8e65ed21ae6f6dbae46b428eb54fa6d1d2182541))

## [v0.1.3](https://github.com/toyamagu-2021/github-s3-artifact/compare/v0.1.2...v0.1.3) - 2026-11-28

### Fixes
- fix(storage,download): filter expired manifests in listManifests and create empty download-path by @toyamagu-2021 in https://github.com/toyamagu-2021/github-s3-artifact/pull/21

## [v0.1.2](https://github.com/toyamagu-2021/github-s3-artifact/compare/v0.1.1...v0.1.2) - 2026-11-27

### Features
- feat(merge): add the upload-artifact merge sub-action by @toyamagu-2021 in https://github.com/toyamagu-2021/github-s3-artifact/pull/15
- feat(runtime): honor artifact concurrency, stall, and list caps by @toyamagu-2021 in https://github.com/toyamagu-2021/github-s3-artifact/pull/16
- feat(upload): add an opt-in presigned artifact-url by @toyamagu-2021 in https://github.com/toyamagu-2021/github-s3-artifact/pull/18

### Fixes
- fix(windows): keep drive roots and expand backslash tilde paths by @toyamagu-2021 in https://github.com/toyamagu-2021/github-s3-artifact/pull/17

### Maintenance
- docs(verify): fix feature map drift from verification skill audit by @toyamagu-2021 in https://github.com/toyamagu-2021/github-s3-artifact/pull/20

## [v0.1.1](https://github.com/toyamagu-2021/github-s3-artifact/compare/v0.1.0...v0.1.1) - 2026-11-26

### Maintenance
- chore(repo): pin Actions and add Dependabot by @toyamagu-2021 in https://github.com/toyamagu-2021/github-s3-artifact/pull/7
- Add project-local verification skill (verify-github-s3-artifact) by @toyamagu-2021 in https://github.com/toyamagu-2021/github-s3-artifact/pull/13
- chore(deps): bump Actions, Vitest 5, and minimatch by @toyamagu-2021 in https://github.com/toyamagu-2021/github-s3-artifact/pull/14

## [v0.1.0](https://github.com/toyamagu-2021/github-s3-artifact/commits/v0.1.0) - 2026-11-25

### Features
- feat(actions): add S3ArtifactStore, runUpload, and runDownload actions by @toyamagu-2021 in https://github.com/toyamagu-2021/github-s3-artifact/pull/1
