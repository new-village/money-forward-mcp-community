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
    await expect(client.listAccounts()).resolves.toEqual([
      {
        name: "Cash",
        id: "abc",
        subAccountIdHash: "hash123",
        accountString: "abc@hash123",
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
});
