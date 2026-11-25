# 受け入れ基準（Executable Acceptance Criteria / ATDD）

## 1. ATDD 採用方針

「公式互換」を謳う OSS では、ハッピーパスではなく **既存ワークフローが暗黙に依存している境界挙動のズレ** が最大のバグ源になる。したがって受け入れ要件は定義すべきだが、Cucumber / Gherkin のような重い BDD フレームワークや、コードと乖離する散文仕様書は作らない。

代わりに以下の2つを直結させる。
1. **外部から観測可能な振る舞いだけを書いた受け入れマトリクス（`AC-01`〜`AC-20`）**: 入力（`with` / `env`）に対し、終了コード・`GITHUB_OUTPUT`・警告ログ・展開後ファイル配置・S3上の最終状態だけを規定する。内部クラスやヘルパーの呼び出し順は一切テストしない。
2. **Action 境界テストハーネス (`__tests__/helpers/action-harness.ts`)**: 各 `AC-XX` をそのまま Vitest のテストケース名に対応させ、`INPUT_*` / `GITHUB_*` 環境変数と一時 `GITHUB_OUTPUT` ファイルを通してエントリポイント層を駆動する。各実装フェーズでは該当する `AC-XX` の失敗（Red）を先に確認してから実装を入れる。

---

## 2. 受け入れ基準一覧（`AC-01`〜`AC-20`）

### A. Upload: パス解決・アーカイブ構造・出力互換

| ID | シナリオ | 入力条件 | 期待される観測結果 |
|---|---|---|---|
| `AC-01` | 単一ファイルのアップロードと出力形式 | `path: a/b/hello.txt`, `name: my-art` | 親ディレクトリ `a/b/` が除去され ZIP 直下に `hello.txt` が格納される。`artifact-id` は53-bit安全整数文字列、`artifact-digest` は64文字の16進 SHA-256（`sha256:` 接頭辞なし、公式実装準拠）、`artifact-url` は `s3://<bucket>/<blobKey>` が出力される。 |
| `AC-02` | 複数パス・除外glob・LCAルート算出 | `path` に `pkg-a/dist/**`, `pkg-b/dist/**`, `!**/sourcemap.map` を指定 | 最小共通祖先（ワークスペースルート）からの相対構造 `pkg-a/dist/...`, `pkg-b/dist/...` が保持され、除外パターン一致ファイルは含まれない。 |
| `AC-03` | 隠しファイルとシンボリックリンク | `.env` や `.hidden/file`、実体ファイルを指す symlink を含むディレクトリ | デフォルト（`include-hidden-files: false`）では隠しファイルが除外され、`true` 指定時のみ含まれる。symlink はリンク先実体の内容としてアーカイブされ、壊れた symlink は無視される。 |
| `AC-04` | 一致ファイル0件時の振る舞い | 存在しないパス + `if-no-files-found: warn \| error \| ignore` | `warn` は警告を出して成功終了（S3書き込みなし・出力空）、`error` は失敗終了、`ignore` は警告なしで成功終了する。 |
| `AC-05` | 無圧縮単一ファイル転送（`archive: false`） | `archive: false`, `name: ignored-name`, `path: dist/app.tar.gz` | ZIP化せず生ファイルのままアップロードされ、アーティファクト名は `name` を無視して `app.tar.gz` になる（公式 `@actions/artifact` v6 準拠）。2ファイル以上一致した場合は失敗終了する。 |

### B. Upload: 同名競合・上書き・ワークフロー再実行（Re-run）

| ID | シナリオ | 入力条件 | 期待される観測結果 |
|---|---|---|---|
| `AC-06` | 同一試行内の同名重複拒否 | 同じ `GITHUB_RUN_ID` かつ同じ `GITHUB_RUN_ATTEMPT` で同名アーティファクトを `overwrite: false`（デフォルト）で2回（または並列に）アップロード | 1つのみ成功し、もう一方は重複エラーで失敗終了する。既存のアーティファクト内容は破壊されない。 |
| `AC-07` | 明示的な上書き（`overwrite: true`） | 既存と同名で `overwrite: true` を指定して新内容をアップロード | 成功し、直後の `download` で新しい内容と新しい `artifact-id` / `artifact-digest` が取得される。旧 Blob はベストエフォートで削除される。 |
| `AC-08` | 「失敗ジョブのみ再実行」との両立 | `GITHUB_RUN_ATTEMPT=1` で `job-a-art` と `job-b-art` を作成後、`GITHUB_RUN_ATTEMPT=2` で `job-b-art` のみ `overwrite: false` のまま再アップロード | `job-b-art` は新しい `runAttempt` としてエラーにならず更新され、再実行されていない `job-a-art`（attempt 1）も同一 `run_id` の `download` でそのまま取得できる。 |

### C. Download: 選択条件・展開ディレクトリ規則・未展開取得

| ID | シナリオ | 入力条件 | 期待される観測結果 |
|---|---|---|---|
| `AC-09` | 単一指定ダウンロードとパス展開 | `name: my-art`, `path: ~/out`（未指定時は `$GITHUB_WORKSPACE`） | `~/out` 直下に展開され（`~/out/my-art/` サブディレクトリは作られない）、解決後の絶対パスが `download-path` に出力される。存在しない `name` は失敗終了する。 |
| `AC-10` | 複数一致時のディレクトリ分離と **1件一致時の特例** | `name` 未指定（全件または `pattern: build-*`）で `merge-multiple: false \| true` | **2件以上一致**かつ `merge-multiple: false` 時は `<path>/<artifact-name>/` ごとに分離展開、`true` 時は `<path>/` 直下に統合展開される。**1件のみ一致**した場合は `merge-multiple: false` でもサブディレクトリを作らず `<path>/` 直下に展開される（公式 `download-artifact@v8` 準拠）。 |
| `AC-11` | `artifact-ids` による取得と排他制御 | カンマ区切り数値ID指定（例: `id1, id2`） | 一致するアーティファクトのみ取得される。一部IDが見つからない場合は警告を出して残りを取得し、1件も見つからない場合および `name` と同時指定した場合は失敗終了する。 |
| `AC-12` | 別Run・別リポジトリからの取得 | `repository: other-org/other-repo`, `run-id: 99999`, `github-token: dummy` | `github-token` が渡されていてもエラーにならず、S3上の `<prefix>/other-org/other-repo/runs/99999/` から該当アーティファクトを取得できる。 |
| `AC-13` | 未展開取得（`skip-decompress: true`） | ZIPアーティファクトに対し `skip-decompress: true` を指定 | 解凍せず `<destination>/<name>.zip` ファイルとしてそのまま保存され、SHA-256 検証も通過する。 |

### D. 整合性検証・セキュリティ境界

| ID | シナリオ | 入力条件 | 期待される観測結果 |
|---|---|---|---|
| `AC-14` | SHA-256 ダイジェスト不一致制御 | S3上の Blob バイト列が Manifest の `digest` と異なる状態で `digest-mismatch: error \| warn \| info \| ignore` | デフォルト（`error`）は失敗終了、`warn` は警告ログを出して成功終了、`info` / `ignore` は失敗せず終了する。 |
| `AC-15` | Zip-Slip（パストラバーサル）防御 | `../../evil.txt` や絶対パスエントリを含む不正ZIPを S3 に配置してダウンロード | 展開先ディレクトリ外への書き込みを一切行わず、失敗終了する。 |
| `AC-16` | NTFS / クロスOS禁止文字の拒否 | アーティファクト名に `/` `\` `:` `*` `?` `"` `<` `>` `\|`、またはアーカイブ内相対パスに `:` `*` 等を含む | S3 通信を行う前の入力・パス検証境界で即座に失敗終了する。 |

### E. S3設定・保持期限・障害耐性・実ワークフロー E2E

| ID | シナリオ | 入力条件 | 期待される観測結果 |
|---|---|---|---|
| `AC-17` | 環境変数フォールバックと優先順位・Secretマスク | `S3_ARTIFACT_*` / `AWS_*` 環境変数のみ指定、または `with:` との併用 | ステップの `with:` に S3 項目を書かなくても環境変数だけで動作し、両方指定時は `with:` が優先される。`secret-access-key` / `session-token` 入力時はマスク処理が呼ばれる。 |
| `AC-18` | `retention-days` 期限判定とタグ非対応S3耐性 | `retention-days: 7` 指定、および `PutObjectTagging` が `AccessDenied` / `NotImplemented` を返すモック/互換ストア | Manifest の `expiresAt` が設定され期限超過後は `download` 対象から除外される。タグ付与失敗時は警告ログのみ出してアップロードは成功する。 |
| `AC-19` | アップロード途中失敗時の不可視性 | Blob ストリーム途中でエラー中断が発生 | Manifest が書き込まれないため、後続の `download` で壊れたアーティファクトが見えたり取得されたりしない。 |
| `AC-20` | 実 GitHub Actions ワークフロー E2E | `.github/workflows/ci.yml` で MinIO サービスコンテナに対し `uses: ./upload` → `uses: ./download` を実行 | バンドル済み `dist/` が最新ソースと一致した状態で、実ランナー上のステップ間ファイル受け渡しが完全に成功する。 |
