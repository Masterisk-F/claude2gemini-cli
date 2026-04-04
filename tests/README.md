# Tests

このディレクトリは `claude2gemini-cli` プロジェクトのテストコードを格納しています。
テストフレームワークとして [Vitest](https://vitest.dev/) を使用しています。

## テストの実行方法

プロジェクトルートで以下のコマンドを実行します。

```bash
# 全てのテストを実行
npm run test

# UIや監視モード（watch）で起動して開発を行う
npx vitest

# 特定のファイルを指定して実行
npx vitest run tests/child-worker.test.ts

# カバレッジを出力しながら実行
npx vitest run --coverage
```

## ディレクトリ構成と配置ルール

テストファイルは、対象となるソースコードのディレクトリ構造と対応するように配置してください。

- **`tests/*.test.ts`**: プロジェクトの主要コンポーネント（子プロセス管理、IPC通信など）の統合的なテストや、ルートディレクトリに近いモジュールのテストを配置します。
  - 例: `child-worker.test.ts` (子プロセスの起動と通信のテスト)
  - 例: `ipc-protocol.test.ts` (IPCプロトコルのシリアライズ/デシリアライズのテスト)
  - 例: `process-isolation.test.ts` (マルチアカウント時のプロセス分離のテスト)
- **`tests/server/converters/*.test.ts`**: `server/converters/` にあるリクエスト/レスポンス変換ロジックの単体テストを配置します。
- **`tests/server/routes/*.test.ts`**: Expressのルーター機能に対するAPI統合テスト（`supertest`を使用）を配置します。

## テスト追加時のガイドライン

1. **ファイル名と配置**:
   新しいテストを追加する際は、対象ファイル名に `.test.ts` を付与し、元のソースコードと同じ階層構造になるように `tests/` 内へ配置してください。
2. **ESM / TypeScript 環境**:
   当プロジェクトは ESM (`type: "module"`) を使用しています。ローカルファイルのインポート時は、拡張子 `.js` を忘れずに付与してください。（例: `import { example } from '../server/example.js';`）
3. **VitestのAPI**:
   テストの記述には `vitest` から `describe`, `it` (または `test`), `expect`, `vi` 等をインポートして使用してください。
   ```typescript
   import { describe, it, expect } from 'vitest';

   describe('example feature', () => {
     it('should work correctly', () => {
       expect(1 + 1).toBe(2);
     });
   });
   ```
4. **モック化と非同期処理**:
   - 外部へのリクエストや子プロセス生成など、副作用を伴うテストでは `vi.mock()` などを利用して適切にモック化してください。
   - プロセスの起動やIPC通信などの非同期処理を待つ必要がある場合は、テストのタイムアウト時間（デフォルトは5秒）を超えないよう、必要に応じてタイムアウトを長めに設定（`it('...', async () => { ... }, 20000)` のように第3引数でミリ秒指定）してください。
