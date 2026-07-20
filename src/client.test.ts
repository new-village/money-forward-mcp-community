import { describe, expect, it, vi } from "vitest";
import { MoneyForwardApiError, MoneyForwardClient } from "./client.js";

function htmlResponse(html: string, url = "https://moneyforward.com/accounts") {
  return Object.defineProperty(new Response(html, { status: 200 }), "url", {
    value: url,
  });
}

describe("MoneyForwardClient", () => {
  it("sends the configured cookie and detects authenticated HTML", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("Cookie")).toBe("session=secret");
        return htmlResponse(
          '<html><meta name="csrf-token" content="x"></html>',
        );
      },
    );
    const client = new MoneyForwardClient({
      cookie: "session=secret",
      fetchImpl: fetchMock as typeof fetch,
    });
    await expect(client.authCheck()).resolves.toEqual({ authenticated: true });
  });

  it("parses manual accounts and resolves their sub-account hashes", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/accounts")) {
        return htmlResponse(
          '<section class="manual_accounts"><table><tbody><tr><td><a href="/accounts/show_manual/abc">Cash</a></td></tr></tbody></table></section>',
        );
      }
      return htmlResponse(
        '<select id="user_asset_det_sub_account_id_hash"><option value="hash123">Main</option></select>',
        url,
      );
    });
    const client = new MoneyForwardClient({
      cookie: "session=secret",
      fetchImpl: fetchMock as typeof fetch,
    });
    await expect(client.listManualAccounts()).resolves.toEqual([
      {
        name: "Cash",
        id: "abc",
      },
    ]);
  });

  it("integrates registered account assets and liabilities", async () => {
    const accountHtml = `<table id="account-table"><tbody><tr>
      <td><a href="/accounts/show/account-hash">Example Bank ( 本サイト ) 123****</a></td>
      <td>1,234,567円</td><td>2024/01/02 (07/20 12:34)</td>
      <td>正常</td></tr></tbody></table>`;
    const detailHtml = `<table><tr><th>名称</th><th>種類</th><th>番号</th><th>残高</th></tr>
      <tr><td>Main</td><td>Checking</td><td>1234567</td><td>1,234,567円</td></tr>
      </table>`;
    const liabilityHtml = `<div id="liability_det"><table><tr><th>header</th></tr>
      <tr><td>Loan</td><td>Home loan</td><td>200,000円</td><td>Example Bank</td></tr>
      <tr><td>Card</td><td>Card balance</td><td>50,000円</td><td>Unmatched Card</td></tr>
      </table></div>`;
    const client = new MoneyForwardClient({
      cookie: "session=secret",
      fetchImpl: vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        return htmlResponse(
          url.endsWith("/accounts")
            ? accountHtml
            : url.endsWith("/accounts/show/account-hash")
              ? detailHtml
              : url.endsWith("/bs/liability")
                ? liabilityHtml
                : "<html></html>",
          url,
        );
      }) as typeof fetch,
    });
    await expect(client.getAccounts()).resolves.toEqual([
      {
        accountId: "account-hash",
        institution: "Example Bank",
        name: "Checking",
        kind: "asset",
        category: null,
        balance: 1234567,
        currency: "JPY",
        source: "account_detail",
        registeredAt: "2024/01/02",
        lastFetchedAt: "07/20 12:34",
        status: "正常",
      },
      {
        accountId: "account-hash",
        institution: "Example Bank",
        name: "Home loan",
        kind: "liability",
        category: "Loan",
        balance: -200000,
        currency: "JPY",
        source: "liability",
        registeredAt: "2024/01/02",
        lastFetchedAt: "07/20 12:34",
        status: "正常",
      },
      {
        accountId: null,
        institution: "Unmatched Card",
        name: "Card balance",
        kind: "liability",
        category: "Card",
        balance: -50000,
        currency: "JPY",
        source: "liability",
        registeredAt: null,
        lastFetchedAt: null,
        status: null,
      },
    ]);
  });

  it("rejects a redirect to the login host", async () => {
    const fetchMock = vi.fn(async () =>
      htmlResponse("login", "https://id.moneyforward.com/oauth/authorize"),
    );
    const client = new MoneyForwardClient({
      cookie: "expired=x",
      fetchImpl: fetchMock as typeof fetch,
    });
    await expect(client.authCheck()).rejects.toBeInstanceOf(
      MoneyForwardApiError,
    );
  });

  it("parses the portfolio asset breakdown and calculates totals", async () => {
    const fetchMock = vi.fn(async () =>
      htmlResponse(
        `<script>
          var assetClassRatio = [
            {"name":"Cash","y":1500,"color":"#fff"},
            {"name":"Stocks","y":500,"color":"#000"},
            {"name":"Bonds","y":0,"color":"#aaa"}
          ];
        </script>`,
        "https://moneyforward.com/bs/portfolio",
      ),
    );
    const client = new MoneyForwardClient({
      cookie: "session=secret",
      fetchImpl: fetchMock as typeof fetch,
    });

    await expect(client.getAssetBreakdown()).resolves.toEqual({
      total: 2000,
      currency: "JPY",
      items: [
        { category: "Cash", value: 1500, percentage: 75 },
        { category: "Stocks", value: 500, percentage: 25 },
        { category: "Bonds", value: 0, percentage: 0 },
      ],
    });
  });

  it("rejects a portfolio page without an asset breakdown", async () => {
    const client = new MoneyForwardClient({
      cookie: "session=secret",
      fetchImpl: vi.fn(async () =>
        htmlResponse("<html></html>", "https://moneyforward.com/bs/portfolio"),
      ) as typeof fetch,
    });
    await expect(client.getAssetBreakdown()).rejects.toThrow(
      "Could not find the asset breakdown",
    );
  });

  it("parses liability breakdown and details", async () => {
    const html = `<div id="bs-liability"><table>
      <tr><th>Credit card</th><td>1,000円</td><td>10%</td></tr>
      <tr><th>Mortgage</th><td>9,000円</td><td>90%</td></tr>
    </table></div>
    <div id="liability_det"><table>
      <tr><th>Type</th><th>Name</th><th>Balance</th><th>Institution</th></tr>
      <tr><td>Mortgage</td><td>Home loan</td><td>9,000円</td><td>Example Bank</td></tr>
    </table></div>`;
    const client = new MoneyForwardClient({
      cookie: "session=secret",
      fetchImpl: vi.fn(async () =>
        htmlResponse(html, "https://moneyforward.com/bs/liability"),
      ) as typeof fetch,
    });
    await expect(client.getLiabilityBreakdown()).resolves.toEqual({
      total: 10000,
      currency: "JPY",
      items: [
        { category: "Credit card", value: 1000, percentage: 10 },
        { category: "Mortgage", value: 9000, percentage: 90 },
      ],
    });
    await expect(client.getLiabilityDetails()).resolves.toEqual([
      {
        category: "Mortgage",
        name: "Home loan",
        balance: 9000,
        institution: "Example Bank",
      },
    ]);
  });

  it("returns empty liability results for a valid debt-free page", async () => {
    const html = '<div id="bs-liability"></div><div id="liability_det"></div>';
    const client = new MoneyForwardClient({
      cookie: "session=secret",
      fetchImpl: vi.fn(async () =>
        htmlResponse(html, "https://moneyforward.com/bs/liability"),
      ) as typeof fetch,
    });
    await expect(client.getLiabilityBreakdown()).resolves.toEqual({
      total: 0,
      currency: "JPY",
      items: [],
    });
    await expect(client.getLiabilityDetails()).resolves.toEqual([]);
  });

  it("parses transactions and household book summary", async () => {
    const transactionHtml = `<script>startDate: '2026-07-01', endDate: '2026-07-31'</script>
      <table id="cf-detail-table"><tr><th>Date</th></tr><tr>
      <td><input type="hidden" name="user_asset_act[is_target]" value="1"></td><td>07/10(金)</td><td>Salary</td><td>300,000</td>
      <td>Example Bank</td><td>Income</td><td>Salary</td><td>Monthly</td>
      </tr><tr><td></td><td>07/11(土)</td><td>Lunch</td><td>-1,200</td>
      <td>Example Card</td><td>Food</td><td>Dining</td><td></td></tr></table>`;
    const summaryHtml = `<script>var showDate = "2026年07月";</script>
      <table id="monthly_total_table"><tr class="js-monthly_total">
      <td>300,000円</td><td>―</td><td>1,200円</td><td>＝</td><td>298,800円</td></tr></table>
      <table id="table-outgo"><tbody>
      <tr class="sum"><td>Food 合計</td><td>1,200円</td><td>100%</td></tr>
      <tr><td>Dining</td><td>1,200円</td><td>100%</td></tr>
      </tbody></table>`;
    const client = new MoneyForwardClient({
      cookie: "session=secret",
      fetchImpl: vi.fn(async (input: string | URL | Request) =>
        htmlResponse(
          String(input).endsWith("/cf/summary") ? summaryHtml : transactionHtml,
          String(input),
        ),
      ) as typeof fetch,
    });
    const transactions = await client.getTransactions();
    expect(transactions).toMatchObject({
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      currency: "JPY",
    });
    expect(transactions.transactions).toHaveLength(2);
    expect(transactions.transactions[0]).toMatchObject({
      date: "2026-07-10",
      amount: 300000,
      direction: "income",
      calculationTarget: true,
    });
    expect(transactions.transactions[1]).toMatchObject({
      date: "2026-07-11",
      amount: -1200,
      direction: "expense",
      calculationTarget: false,
    });
    await expect(client.getHouseholdBookSummary()).resolves.toEqual({
      period: "2026年07月",
      currency: "JPY",
      income: 300000,
      expense: 1200,
      balance: 298800,
      categorySummaries: [
        { category: "Income", income: 300000, expense: 0, balance: 300000 },
        { category: "Food", income: 0, expense: 1200, balance: -1200 },
      ],
      incomeCategories: [
        {
          category: "Income",
          amount: 300000,
          percentage: 100,
          subcategories: [{ category: "Salary", amount: 300000 }],
        },
      ],
      expenseCategories: [
        {
          category: "Food",
          amount: 1200,
          percentage: 100,
          subcategories: [{ category: "Dining", amount: 1200 }],
        },
      ],
    });
  });

  it("persists refreshed cookies only when the client callback is configured", async () => {
    const onCookieUpdate = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async () => {
      const response = htmlResponse(
        '<html><meta name="csrf-token" content="x"></html>',
      );
      Object.defineProperty(response.headers, "getSetCookie", {
        value: () => [
          "_moneybook_session=refreshed; Path=/; HttpOnly; Secure; SameSite=Lax",
        ],
      });
      return response;
    });
    const client = new MoneyForwardClient({
      cookie: "_moneybook_session=old; other=value",
      fetchImpl: fetchMock as typeof fetch,
      onCookieUpdate,
    });

    await client.authCheck();
    expect(onCookieUpdate).toHaveBeenCalledOnce();
    expect(onCookieUpdate).toHaveBeenCalledWith(
      "_moneybook_session=refreshed; other=value",
    );
  });
});
