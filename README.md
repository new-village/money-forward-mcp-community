# money-forward-mcp-community

Unofficial, community-maintained stdio MCP server and TypeScript client for Money Forward ME.

It reads Money Forward ME's authenticated web pages with a user-provided Cookie header and exposes portfolio, liabilities, linked accounts, cashflow, household-book summaries, and manual accounts as structured MCP tools.

> [!WARNING]
> This project is unofficial and is not affiliated with Money Forward, Inc. or Money Forward Home, Inc. Internal endpoints and HTML can change without notice. Treat Cookies and returned financial data as secrets. Never put them in GitHub issues, logs, npm packages, or public prompts. Review the latest Money Forward terms before use.

## Capabilities

- Portfolio total, asset-class allocation, and individual holdings
- Liability total, class allocation, loans, and card balances
- Flat account view across banks, securities, points, cards, and loans
- Monthly cashflow rows with direction and calculation-target filters
- Monthly income, expense, net balance, and category summaries
- Custom/manual account and asset lookup
- Browser login, trusted Cookie import, authentication checks, and rolling Cookie refresh

Data tools never modify financial records. Month-specific cashflow reads update Money Forward's selected-month session state and may persist a rotated Cookie.

## Quick start

### Local / desktop

```bash
npx money-forward-mcp-community auth
npx money-forward-mcp-community auth --status
```

Complete login and multi-factor authentication in the browser. The Cookie is stored at:

```text
~/.config/money-forward-mcp-community/config.json
```

Example MCP client configuration:

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

Do not automate email/password login on a remote server. Export a Cookie from a trusted authenticated browser and supply it through a secret manager or a protected config file.

```bash
MONEY_FORWARD_COOKIE='your Cookie header' \
  npx -y money-forward-mcp-community
```

Or mount a config file:

```json
{
  "cookie": "your Cookie header",
  "updatedAt": "2026-07-20T00:00:00.000Z"
}
```

```bash
MONEY_FORWARD_MCP_COMMUNITY_CONFIG=/run/secrets/money-forward/config.json \
  npx -y money-forward-mcp-community
```

## Tool selection for agents

Use compact summary tools before requesting large detail payloads.

| User intent                                       | Preferred tool                        | Notes                                                       |
| ------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------- |
| Net worth or balances by bank/card/account        | `money_forward_get_account`           | Flat signed balances; assets positive, liabilities negative |
| Total assets or allocation                        | `money_forward_get_portfolio_summary` | Compact; includes zero-balance asset classes                |
| Individual holdings or valuation details          | `money_forward_get_portfolio_details` | Larger response; grouped by asset class                     |
| Total debt or debt allocation                     | `money_forward_get_liability_summary` | Positive amounts owed                                       |
| Individual loans or card balances                 | `money_forward_get_liability_details` | Positive amounts owed                                       |
| Monthly income, spending, net, or category totals | `money_forward_get_cashflow_summary`  | Prefer an explicit `month`                                  |
| Individual monthly cashflow rows                  | `money_forward_get_cashflow_details`  | Supports direction and calculation-target filters           |
| Custom/manual accounts only                       | `money_forward_list_manual_accounts`  | Not linked banks, cards, or securities                      |
| Assets inside one manual account                  | `money_forward_list_manual_assets`    | Requires `id` from the previous tool                        |

### Recommended agent workflow

1. If a data tool reports missing or expired authentication, call `money_forward_auth_status`, then `money_forward_auth_check`.
2. For monthly analysis, call `money_forward_get_cashflow_summary` first.
3. Call `money_forward_get_cashflow_details` only when individual transactions are necessary.
4. For net worth by account, call `money_forward_get_account` and sum its signed `balance` values.
5. For asset composition, use Portfolio tools rather than reconstructing allocation from account rows.

## Structured output

Successful tools return both human-readable JSON text and MCP structured output. Programmatic consumers should read:

```typescript
response.structuredContent.result;
```

Each tool declares an MCP `outputSchema`, allowing compatible agents to inspect the response contract before calling it.

Errors set `isError: true` and return a stable object in `structuredContent.error`:

```json
{
  "code": "auth_required",
  "message": "Money Forward ME authentication is not configured.",
  "retryable": false,
  "suggestedTools": ["money_forward_auth_login", "money_forward_set_cookie"]
}
```

Defined error categories include authentication requirements/expiry, upstream timeouts or HTTP errors, and page-format changes.

## Account model

`money_forward_get_account` returns a flat array. There is no institution-specific nested `subAccounts` model.

```ts
type MoneyForwardAccountEntry = {
  accountId: string | null;
  institution: string;
  name: string;
  kind: "asset" | "liability";
  category: string | null;
  balance: number;
  currency: "JPY";
  source: "account_detail" | "portfolio" | "liability" | "account_summary";
  registeredAt: string | null;
  lastFetchedAt: string | null;
  status: string | null;
};
```

Example:

```json
[
  {
    "institution": "Example Bank",
    "name": "Savings",
    "kind": "asset",
    "category": null,
    "balance": 1500000,
    "currency": "JPY",
    "source": "account_detail"
  },
  {
    "institution": "Example Bank",
    "name": "Home loan",
    "kind": "liability",
    "category": "Mortgage",
    "balance": -12000000,
    "currency": "JPY",
    "source": "liability"
  }
]
```

### Account sign convention

- `kind: "asset"`: `balance` is zero or positive
- `kind: "liability"`: `balance` is zero or negative
- Sum all `balance` values to obtain net value

`source` preserves the Money Forward page used for the row:

| Source            | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `account_detail`  | A sub-account from a linked institution's detail page       |
| `portfolio`       | A Portfolio holding such as points or stored value          |
| `liability`       | A Liability row such as a loan or card balance              |
| `account_summary` | Institution total used when no lower-level row is available |

Matching across pages is generic and based on Money Forward's institution labels. No bank or card name is hard-coded. A source label is retained so agents can explain provenance and avoid treating fallback totals as detailed holdings. Portfolio or liability rows with an institution label that does not match a registered account are retained with `accountId: null` rather than silently discarded.

## Cashflow

Both cashflow tools accept an optional month:

```json
{ "month": "2026-06" }
```

Use explicit `YYYY-MM` whenever reproducibility matters. If omitted, Money Forward's currently displayed month is used. Selecting a month performs Money Forward's session-level month switch before reading; it does not edit transactions or household-book records.

`money_forward_get_cashflow_details` also accepts:

```json
{
  "month": "2026-06",
  "direction": "expense",
  "calculationTargetOnly": true
}
```

- `direction`: `all`, `income`, or `expense`
- `calculationTargetOnly`: exclude rows Money Forward does not use in household-book calculations
- Transaction `amount`: income positive, expense negative
- Summary `income` and `expense`: both positive totals
- Summary `balance`: income minus expense

## Portfolio and liabilities

Portfolio and Liability deliberately keep Money Forward's original concepts separate:

- Portfolio summary/details describe assets and holdings.
- Liability summary/details describe positive amounts owed.
- Account entries normalize liabilities to negative signed balances for net-value calculations.

Do not add Portfolio and account asset totals together: they are different views of overlapping financial data.

## Authentication tools

| Tool                         | Behavior                                                              |
| ---------------------------- | --------------------------------------------------------------------- |
| `money_forward_auth_status`  | Checks local configuration only; no network request                   |
| `money_forward_auth_check`   | Verifies the configured Cookie against Money Forward                  |
| `money_forward_auth_login`   | Opens a Playwright browser and stores Cookies locally                 |
| `money_forward_set_cookie`   | Verifies and stores a trusted Cookie header                           |
| `money_forward_clear_cookie` | Deletes the config-file Cookie; does not change environment variables |

Authentication priority:

1. `MONEY_FORWARD_COOKIE`
2. `MF_ME_COOKIE` (compatibility)
3. `MONEY_FORWARD_MCP_COMMUNITY_CONFIG`
4. `~/.config/money-forward-mcp-community/config.json`

CLI:

```bash
money-forward-mcp-community auth
money-forward-mcp-community auth --status
money-forward-mcp-community auth --clear
money-forward-mcp-community set-cookie '<COOKIE_HEADER>'
money-forward-mcp-community serve
```

If Chromium is not installed:

```bash
npx -p playwright playwright install chromium
```

## Cookie refresh

Money Forward may rotate session Cookies on authenticated responses.

- Config-file Cookies are updated atomically after a successful authenticated response.
- The temporary file and final config use mode `0600`.
- Environment-variable Cookies are never persisted to disk.
- Cookie values, previews, and local config paths are not returned by MCP authentication tools.

A Cookie can still be invalidated server-side by logout, password changes, or security policy. Use `money_forward_auth_check` when data access fails.

## TypeScript API

```ts
import { MoneyForwardClient, readCookie } from "money-forward-mcp-community";

const client = new MoneyForwardClient({ cookie: await readCookie() });

const accounts = await client.getAccounts();
const JuneSummary = await client.getHouseholdBookSummary("2026-06");
const manualAccounts = await client.listManualAccounts();
```

## Environment

| Variable                               | Default             | Description                               |
| -------------------------------------- | ------------------- | ----------------------------------------- |
| `MONEY_FORWARD_COOKIE`                 | none                | Money Forward `Cookie` header             |
| `MF_ME_COOKIE`                         | none                | Compatibility Cookie environment variable |
| `MONEY_FORWARD_MCP_COMMUNITY_CONFIG`   | default config path | Config JSON path                          |
| `MONEY_FORWARD_REQUEST_TIMEOUT_MS`     | `15000`             | Request timeout, 100–120000 ms            |
| `MONEY_FORWARD_MCP_COMMUNITY_HEADLESS` | `false`             | Browser-login headless mode               |

## Security and limitations

- Cookies provide access to financial data. Treat them like passwords.
- The server uses unofficial HTML and internal web behavior, not a supported public API.
- Money Forward can change pages, labels, or session behavior without notice.
- `lastFetchedAt` is the display label provided by Money Forward and may omit the year.
- Foreign-currency balances can be returned as Money Forward's JPY valuation.
- Only use accounts you own or are authorized to manage.
- Review the data-retention and model-training settings of the MCP host and AI client.

## Development

```bash
npm install
npm run format
npm run check
npm test
npm run lint
npm run build
npm pack --dry-run
```

## Release

Conventional Commits on `main` are processed by GitHub Actions and semantic-release to create GitHub and npm releases. Configure `new-village/money-forward-mcp-community` and `.github/workflows/release.yml` as npm Trusted Publishers. `NPM_TOKEN` is not required.

## License

MIT
