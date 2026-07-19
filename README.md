# money-forward-mcp-community

Unofficial, community-maintained stdio MCP server for Money Forward ME. It uses cookie-based access to Money Forward ME's internal web endpoints.

> [!WARNING]
> このプロジェクトは非公式であり、株式会社マネーフォワードおよびマネーフォワードホーム株式会社とは関係ありません。内部エンドポイントやHTML構造は予告なく変わる可能性があります。Cookie、認証情報、金融データをGitHub、npm、ログ、Issueへ含めないでください。利用前に最新の利用規約を確認してください。

## Design

`new-village/note-mcp-community` と `new-village/eight-mcp-community` と同じ認証モデルを採用しています。

- デスクトップ: Playwrightでブラウザログインし、Cookieをローカル保存
- GCP、Hermes、コンテナ: 環境変数または読み取り専用設定ファイル
- MCPと通常のTypeScriptコードで同じクライアントを利用
- 初版のデータ取得ツールは読み取り専用

初版は [`sammrai/mfapi`](https://github.com/sammrai/mfapi) v0.0.2 の口座・資産取得ロジックを参考にしています。現在扱うのはMoney Forward MEの「手動入力した口座」とその資産です。銀行・カード明細や家計簿全体の取得はまだ実装していません。

## Quick start

### Local / desktop

```bash
npx money-forward-mcp-community auth
npx money-forward-mcp-community auth --status
```

ブラウザでMoney Forward MEへログインし、必要なら多要素認証を完了します。Cookieは次へ保存されます。

```text
~/.config/money-forward-mcp-community/config.json
```

MCPクライアント設定:

```json
{
  "mcpServers": {
    "money-forward-me": {
      "command": "npx",
      "args": ["-y", "money-forward-mcp-community"]
    }
  }
}
```

### Server / Hermes / CI

リモートサーバー上でメールアドレスとパスワードによるヘッドレスログインを自動化しないでください。信頼済み端末で取得したCookieをSecret Manager等から環境変数へ渡すか、設定ファイルを読み取り専用でマウントします。

```bash
MONEY_FORWARD_COOKIE='your Cookie header' \
  npx -y money-forward-mcp-community
```

設定ファイルを使う場合:

```json
{
  "cookie": "your Cookie header",
  "updatedAt": "2026-07-19T00:00:00.000Z"
}
```

```bash
MONEY_FORWARD_MCP_COMMUNITY_CONFIG=/run/secrets/money-forward/config.json \
  npx -y money-forward-mcp-community
```

## Authentication priority

1. `MONEY_FORWARD_COOKIE`
2. `MF_ME_COOKIE`（互換用）
3. `MONEY_FORWARD_MCP_COMMUNITY_CONFIG` が指すJSON
4. `~/.config/money-forward-mcp-community/config.json`

CLI:

```bash
money-forward-mcp-community auth
money-forward-mcp-community auth --status
money-forward-mcp-community auth --clear
money-forward-mcp-community set-cookie '<COOKIE_HEADER>'
money-forward-mcp-community serve
```

ブラウザが未導入の場合:

```bash
npx -p playwright playwright install chromium
```

## MCP tools

Authentication:

- `money_forward_auth_status`
- `money_forward_auth_login`
- `money_forward_set_cookie`
- `money_forward_clear_cookie`
- `money_forward_auth_check`

Data:

- `money_forward_list_accounts`
- `money_forward_list_assets`

## TypeScript API

```ts
import { MoneyForwardClient, readCookie } from "money-forward-mcp-community";

const client = new MoneyForwardClient({ cookie: await readCookie() });
const accounts = await client.listAccounts();
```

## Environment

| Variable                               | Default             | Description                    |
| -------------------------------------- | ------------------- | ------------------------------ |
| `MONEY_FORWARD_COOKIE`                 | none                | Money Forward `Cookie` header  |
| `MF_ME_COOKIE`                         | none                | Compatible Cookie env name     |
| `MONEY_FORWARD_MCP_COMMUNITY_CONFIG`   | default config path | Config JSON path               |
| `MONEY_FORWARD_REQUEST_TIMEOUT_MS`     | `15000`             | Request timeout, 100–120000 ms |
| `MONEY_FORWARD_MCP_COMMUNITY_HEADLESS` | `false`             | Browser login headless mode    |

## Security

- Cookieには金融データへアクセスできるセッション情報が含まれます。パスワード相当として扱ってください。
- 設定ファイルは作成時に`0600`を設定します。
- Cookieの値をMCPステータスやログへ出力せず、先頭・末尾の短いプレビューだけを返します。
- AIクライアント側のデータ保持・学習設定を確認してください。
- 所有・管理権限のあるアカウントだけに利用してください。

## Development

```bash
npm install
npm run check
npm test
npm run build
npm run lint
npm pack --dry-run
```

## Release

`main`へのConventional CommitをGitHub Actionsとsemantic-releaseが処理し、GitHub Releaseとnpm公開を行います。npmでは `new-village/money-forward-mcp-community` と `.github/workflows/release.yml` をTrusted Publisherとして設定してください。`NPM_TOKEN`は使用しません。

## License

MIT
