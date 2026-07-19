import { load } from "cheerio";
import type { MoneyForwardAccount, MoneyForwardAsset } from "./types.js";

export interface MoneyForwardClientOptions {
  cookie: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class MoneyForwardApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MoneyForwardApiError";
  }
}

export class MoneyForwardClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: MoneyForwardClientOptions) {
    if (!options.cookie.trim())
      throw new Error("Money Forward ME cookie must not be empty.");
    this.baseUrl = (options.baseUrl ?? "https://moneyforward.com").replace(
      /\/$/,
      "",
    );
    this.timeoutMs =
      options.timeoutMs ??
      readTimeout(process.env.MONEY_FORWARD_REQUEST_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async authCheck(): Promise<{ authenticated: true }> {
    const html = await this.getHtml("/accounts");
    const $ = load(html);
    const hasAuthenticatedPage =
      $('meta[name="csrf-token"]').length > 0 ||
      $(
        'a[href*="sign_out"], form[action*="sign_out"], section.manual_accounts',
      ).length > 0;
    if (!hasAuthenticatedPage) {
      throw new MoneyForwardApiError(
        "Money Forward ME cookie is invalid or expired.",
        401,
      );
    }
    return { authenticated: true };
  }

  async listAccounts(): Promise<MoneyForwardAccount[]> {
    const html = await this.getHtml("/accounts");
    const $ = load(html);
    const basicAccounts: Array<{ name: string; id: string }> = [];

    $("section.manual_accounts tr td:first-child a").each((_index, element) => {
      const name = $(element).text().trim();
      const href = $(element).attr("href") ?? "";
      const id = href.split("/").filter(Boolean).at(-1) ?? "";
      if (name && id) basicAccounts.push({ name, id });
    });

    return Promise.all(
      basicAccounts.map(async ({ name, id }) => {
        const subAccountIdHash = await this.getSubAccountIdHash(id);
        return {
          name,
          id,
          subAccountIdHash,
          accountString: `${id}@${subAccountIdHash}`,
        };
      }),
    );
  }

  async listAssets(accountString: string): Promise<MoneyForwardAsset[]> {
    const accountId = accountString.split("@")[0]?.trim();
    if (!accountId) throw new MoneyForwardApiError("accountString is invalid.");
    const html = await this.getHtml(
      `/accounts/show_manual/${encodeURIComponent(accountId)}`,
    );
    const $ = load(html);
    const assets: MoneyForwardAsset[] = [];

    $('form.form-horizontal[action="/bs/portfolio/edit"]').each(
      (_index, form) => {
        const formId =
          $(form).attr("id")?.replace("new_user_asset_det_", "") ?? "";
        const values = new Map<string, string>();
        $(form)
          .find("input[id]")
          .each((_inputIndex, input) => {
            const id = $(input).attr("id")?.replace("user_asset_det_", "");
            const value = $(input).val();
            if (id && typeof value === "string") values.set(id, value);
          });

        const name = values.get("name")?.trim();
        const value = parseNumber(values.get("value"));
        if (!formId || !name || value === null) return;
        const backendId = values.get("id");
        assets.push({
          assetId: backendId ? `${formId}@${backendId}` : formId,
          assetSubclassId: values.get("asset_subclass_id") ?? "unknown",
          name,
          value,
          entriedPrice: parseNumber(values.get("entried_price")),
          entriedAt: values.get("entried_at")?.trim() || null,
        });
      },
    );
    return assets;
  }

  private async getSubAccountIdHash(accountId: string): Promise<string> {
    const html = await this.getHtml(
      `/accounts/show_manual/${encodeURIComponent(accountId)}`,
    );
    const $ = load(html);
    const value = $("#user_asset_det_sub_account_id_hash > option")
      .first()
      .attr("value")
      ?.trim();
    if (!value) {
      throw new MoneyForwardApiError(
        `Could not find sub-account id for account ${accountId}.`,
      );
    }
    return value;
  }

  private async getHtml(path: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          Cookie: this.options.cookie,
          Referer: `${this.baseUrl}/`,
          "User-Agent": "money-forward-mcp-community/0.1.0",
        },
        redirect: "follow",
        signal: controller.signal,
      });
      const finalHost = new URL(response.url || `${this.baseUrl}${path}`)
        .hostname;
      if (
        finalHost === "id.moneyforward.com" ||
        response.url.includes("/users/sign_in")
      ) {
        throw new MoneyForwardApiError(
          "Money Forward ME cookie is invalid or expired.",
          401,
        );
      }
      if (!response.ok) {
        throw new MoneyForwardApiError(
          `Money Forward ME returned HTTP ${response.status}.`,
          response.status,
        );
      }
      return await response.text();
    } catch (error) {
      if (error instanceof MoneyForwardApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new MoneyForwardApiError(
          `Money Forward ME request timed out after ${this.timeoutMs}ms.`,
        );
      }
      throw new MoneyForwardApiError(
        "Could not connect to Money Forward ME.",
        undefined,
        {
          cause: error,
        },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseNumber(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function readTimeout(raw: string | undefined): number {
  if (!raw) return 15_000;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 120_000) {
    throw new Error(
      "MONEY_FORWARD_REQUEST_TIMEOUT_MS must be an integer from 100 to 120000.",
    );
  }
  return parsed;
}
