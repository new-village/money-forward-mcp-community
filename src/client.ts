import { load } from "cheerio";
import { USER_AGENT } from "./version.js";
import type {
  MoneyForwardAccount,
  MoneyForwardAccountEntry,
  MoneyForwardAsset,
  MoneyForwardAssetBreakdown,
  MoneyForwardAssetDetailGroup,
  MoneyForwardHouseholdBookSummary,
  MoneyForwardHouseholdCategory,
  MoneyForwardLiabilityBreakdown,
  MoneyForwardLiabilityDetail,
  MoneyForwardTransactionList,
} from "./types.js";

export interface MoneyForwardClientOptions {
  cookie: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onCookieUpdate?: (cookie: string) => Promise<void>;
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
  private currentCookie: string;

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
    this.currentCookie = options.cookie;
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

  async getAccounts(): Promise<MoneyForwardAccountEntry[]> {
    const html = await this.getHtml("/accounts");
    const portfolioGroups = await this.getAssetDetails();
    const liabilities = await this.getLiabilityDetails();
    const portfolioByInstitution = new Map<string, number>();
    const portfolioItemsByInstitution = new Map<
      string,
      Array<{ name: string; category: string; value: number }>
    >();
    for (const group of portfolioGroups) {
      for (const item of group.items) {
        if (item.institution) {
          portfolioByInstitution.set(
            item.institution,
            (portfolioByInstitution.get(item.institution) ?? 0) + item.value,
          );
          const institutionItems =
            portfolioItemsByInstitution.get(item.institution) ?? [];
          institutionItems.push({
            name: item.name,
            category: group.category,
            value: item.value,
          });
          portfolioItemsByInstitution.set(item.institution, institutionItems);
        }
      }
    }
    const liabilitiesByInstitution = new Map<string, number>();
    const liabilityItemsByInstitution = new Map<
      string,
      MoneyForwardLiabilityDetail[]
    >();
    for (const item of liabilities) {
      if (item.institution) {
        liabilitiesByInstitution.set(
          item.institution,
          (liabilitiesByInstitution.get(item.institution) ?? 0) + item.balance,
        );
        const institutionItems =
          liabilityItemsByInstitution.get(item.institution) ?? [];
        institutionItems.push(item);
        liabilityItemsByInstitution.set(item.institution, institutionItems);
      }
    }

    const $ = load(html);
    const accounts: Array<{
      accountId: string;
      accountName: string;
      institution: string;
      assetBalance: number;
      liabilityBalance: number;
      netBalance: number;
      subAccounts: Array<{
        name: string;
        category: string | null;
        kind: "asset" | "liability";
        balance: number;
        source:
          "account_detail" | "portfolio" | "liability" | "account_summary";
      }>;
      registeredAt: string | null;
      lastFetchedAt: string | null;
      status: string | null;
    }> = [];
    $("#account-table tbody tr").each((_index, row) => {
      const cells = $(row).find("td");
      const link = cells.eq(0).find('a[href^="/accounts/show/"]').first();
      const href = link.attr("href") ?? "";
      const accountId = href.split("/").filter(Boolean).at(-1) ?? "";
      const accountName = cells.eq(0).text().replace(/\s+/g, " ").trim();
      if (!accountId || !accountName) return;
      const institution = accountName
        .replace(/\s*\(\s*本サイト\s*\).*$/, "")
        .trim();
      const displayedAsset = parseDisplayNumber(cells.eq(1).text());
      const assetBalance =
        displayedAsset ?? portfolioByInstitution.get(institution) ?? 0;
      const liabilityBalance = liabilitiesByInstitution.get(institution) ?? 0;
      const dates = cells
        .eq(2)
        .text()
        .replace(/\s+/g, " ")
        .trim()
        .match(/^(\d{4}\/\d{2}\/\d{2})\s*\(([^)]+)\)$/);
      accounts.push({
        accountId,
        accountName,
        institution,
        assetBalance,
        liabilityBalance,
        netBalance: assetBalance - liabilityBalance,
        subAccounts: [],
        registeredAt: dates?.[1] ?? null,
        lastFetchedAt: dates?.[2]?.trim() ?? null,
        status: cells.eq(3).text().replace(/\s+/g, " ").trim() || null,
      });
    });
    for (const account of accounts) {
      const detailHtml = await this.getHtml(
        `/accounts/show/${encodeURIComponent(account.accountId)}`,
      );
      const detail = load(detailHtml);
      const table = detail("table")
        .filter((_index, element) => {
          const headers = detail(element)
            .find("tr")
            .first()
            .find("th")
            .map((_cellIndex, cell) => detail(cell).text().trim())
            .get();
          return (
            headers.includes("名称") &&
            headers.includes("種類") &&
            headers.includes("残高")
          );
        })
        .first();
      table
        .find("tr")
        .slice(1)
        .each((_index, row) => {
          const cells = detail(row).find("td");
          const name = cells.eq(1).text().replace(/\s+/g, " ").trim();
          const balance = parseDisplayNumber(cells.eq(3).text());
          if (!name || balance === null) return;
          account.subAccounts.push({
            name,
            category: null,
            kind: "asset",
            balance,
            source: "account_detail",
          });
        });
      if (account.subAccounts.length === 0) {
        for (const item of portfolioItemsByInstitution.get(
          account.institution,
        ) ?? []) {
          account.subAccounts.push({
            name: item.name,
            category: item.category,
            kind: "asset",
            balance: item.value,
            source: "portfolio",
          });
        }
      }
      if (account.subAccounts.length === 0 && account.assetBalance !== 0) {
        account.subAccounts.push({
          name: account.institution,
          category: null,
          kind: "asset",
          balance: account.assetBalance,
          source: "account_summary",
        });
      }
      for (const item of liabilityItemsByInstitution.get(account.institution) ??
        []) {
        account.subAccounts.push({
          name: item.name,
          category: item.category,
          kind: "liability",
          balance: -item.balance,
          source: "liability",
        });
      }
    }
    const entries: MoneyForwardAccountEntry[] = accounts.flatMap((account) =>
      account.subAccounts.map((entry) => ({
        accountId: account.accountId,
        institution: account.institution,
        name: entry.name,
        kind: entry.kind,
        category: entry.category,
        balance: entry.balance,
        currency: "JPY" as const,
        source: entry.source,
        registeredAt: account.registeredAt,
        lastFetchedAt: account.lastFetchedAt,
        status: account.status,
      })),
    );
    const registeredInstitutions = new Set(
      accounts.map((account) => account.institution),
    );
    for (const [institution, items] of portfolioItemsByInstitution) {
      if (registeredInstitutions.has(institution)) continue;
      entries.push(
        ...items.map((item) => ({
          accountId: null,
          institution,
          name: item.name,
          kind: "asset" as const,
          category: item.category,
          balance: item.value,
          currency: "JPY" as const,
          source: "portfolio" as const,
          registeredAt: null,
          lastFetchedAt: null,
          status: null,
        })),
      );
    }
    for (const [institution, items] of liabilityItemsByInstitution) {
      if (registeredInstitutions.has(institution)) continue;
      entries.push(
        ...items.map((item) => ({
          accountId: null,
          institution,
          name: item.name,
          kind: "liability" as const,
          category: item.category,
          balance: -item.balance,
          currency: "JPY" as const,
          source: "liability" as const,
          registeredAt: null,
          lastFetchedAt: null,
          status: null,
        })),
      );
    }
    return entries;
  }

  async listManualAccounts(): Promise<MoneyForwardAccount[]> {
    const html = await this.getHtml("/accounts");
    const $ = load(html);
    const basicAccounts: Array<{ name: string; id: string }> = [];

    $("section.manual_accounts tr td:first-child a").each((_index, element) => {
      const name = $(element).text().trim();
      const href = $(element).attr("href") ?? "";
      const id = href.split("/").filter(Boolean).at(-1) ?? "";
      if (name && id) basicAccounts.push({ name, id });
    });

    return basicAccounts;
  }

  async listManualAssets(accountId: string): Promise<MoneyForwardAsset[]> {
    const normalizedAccountId = accountId.trim();
    if (!normalizedAccountId)
      throw new MoneyForwardApiError("accountId is invalid.");
    const html = await this.getHtml(
      `/accounts/show_manual/${encodeURIComponent(normalizedAccountId)}`,
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
          entryPrice: parseNumber(values.get("entried_price")),
          entryDate: values.get("entried_at")?.trim() || null,
        });
      },
    );
    return assets;
  }

  async getAssetBreakdown(): Promise<MoneyForwardAssetBreakdown> {
    const html = await this.getHtml("/bs/portfolio");
    const match = html.match(/var\s+assetClassRatio\s*=\s*(\[[\s\S]*?\]);/);
    if (!match?.[1]) {
      throw new MoneyForwardApiError(
        "Could not find the asset breakdown on the portfolio page.",
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(match[1]);
    } catch (error) {
      throw new MoneyForwardApiError(
        "Could not parse the asset breakdown on the portfolio page.",
        undefined,
        { cause: error },
      );
    }
    if (!Array.isArray(raw)) {
      throw new MoneyForwardApiError(
        "The asset breakdown has an invalid format.",
      );
    }

    const values = raw.map((item) => {
      if (
        typeof item !== "object" ||
        item === null ||
        typeof (item as { name?: unknown }).name !== "string" ||
        typeof (item as { y?: unknown }).y !== "number" ||
        !Number.isFinite((item as { y: number }).y)
      ) {
        throw new MoneyForwardApiError(
          "The asset breakdown contains an invalid item.",
        );
      }
      return {
        category: (item as { name: string }).name.trim(),
        value: (item as { y: number }).y,
      };
    });
    const total = values.reduce((sum, item) => sum + item.value, 0);

    return {
      total,
      currency: "JPY",
      items: values.map((item) => ({
        ...item,
        percentage: total === 0 ? 0 : round((item.value / total) * 100, 2),
      })),
    };
  }

  async getAssetDetails(): Promise<MoneyForwardAssetDetailGroup[]> {
    const html = await this.getHtml("/bs/portfolio");
    const $ = load(html);
    const fallbackCategories: Record<string, string> = {
      portfolio_det_depo: "預金・現金",
      portfolio_det_crpt: "暗号資産",
    };
    const groups: MoneyForwardAssetDetailGroup[] = [];

    $('[id^="portfolio_det_"]').each((_sectionIndex, section) => {
      const table = $(section).find("table").first();
      if (!table.length) return;
      const sectionId = $(section).attr("id") ?? "";
      const heading = $(section)
        .find("h1,h2,h3,h4")
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim();
      const category = heading.startsWith("合計：")
        ? fallbackCategories[sectionId]
        : heading;
      if (!category) return;

      const headers = table
        .find("tr")
        .first()
        .find("th")
        .map((_index, cell) => $(cell).text().replace(/\s+/g, " ").trim())
        .get();
      const items: MoneyForwardAssetDetailGroup["items"] = [];
      table
        .find("tr")
        .slice(1)
        .each((_rowIndex, row) => {
          const cells = $(row)
            .find("td")
            .map((_index, cell) => $(cell).text().replace(/\s+/g, " ").trim())
            .get();
          if (!cells.length) return;
          const details: Record<string, string> = {};
          headers.forEach((header, index) => {
            if (
              header &&
              cells[index] &&
              header !== "変更" &&
              header !== "削除"
            ) {
              details[header] = cells[index];
            }
          });
          const name =
            details["銘柄名"] ?? details["種類・名称"] ?? details["名称"];
          const valueText =
            details["評価額"] ??
            details["残高"] ??
            details["現在価値"] ??
            details["現在の価値"];
          const value = parseDisplayNumber(valueText);
          if (!name || value === null) return;
          items.push({
            name,
            value,
            institution: details["保有金融機関"] ?? null,
            details,
          });
        });
      groups.push({
        category,
        total: items.reduce((sum, item) => sum + item.value, 0),
        items,
      });
    });
    return groups;
  }

  async getLiabilityBreakdown(): Promise<MoneyForwardLiabilityBreakdown> {
    const html = await this.getHtml("/bs/liability");
    const $ = load(html);
    const items = $("#bs-liability > table, #bs-liability table")
      .first()
      .find("tr")
      .map((_index, row) => {
        const cells = $(row)
          .find("th,td")
          .map((_cellIndex, cell) => $(cell).text().replace(/\s+/g, " ").trim())
          .get();
        const value = parseDisplayNumber(cells[1]);
        const percentage = parseDisplayNumber(cells[2]);
        if (!cells[0] || value === null || percentage === null) return null;
        return { category: cells[0], value, percentage };
      })
      .get();
    if (!items.length) {
      if ($("#bs-liability").length > 0) {
        return { total: 0, currency: "JPY", items: [] };
      }
      throw new MoneyForwardApiError(
        "Could not find the liability breakdown on the liability page.",
      );
    }
    return {
      total: items.reduce((sum, item) => sum + item.value, 0),
      currency: "JPY",
      items,
    };
  }

  async getLiabilityDetails(): Promise<MoneyForwardLiabilityDetail[]> {
    const html = await this.getHtml("/bs/liability");
    const $ = load(html);
    const items: MoneyForwardLiabilityDetail[] = [];
    $("#liability_det table tr")
      .slice(1)
      .each((_index, row) => {
        const cells = $(row)
          .find("td")
          .map((_cellIndex, cell) => $(cell).text().replace(/\s+/g, " ").trim())
          .get();
        const balance = parseDisplayNumber(cells[2]);
        if (!cells[0] || !cells[1] || balance === null) return;
        items.push({
          category: cells[0],
          name: cells[1],
          balance,
          institution: cells[3] || null,
        });
      });
    if (!items.length && $("#liability_det").length === 0) {
      throw new MoneyForwardApiError(
        "Could not find liability details on the liability page.",
      );
    }
    return items;
  }

  async getTransactions(month?: string): Promise<MoneyForwardTransactionList> {
    const cookie = month
      ? await this.selectCashFlowMonth(month)
      : this.currentCookie;
    const html = await this.getHtml("/cf", cookie);
    const $ = load(html);
    const calendarScript = $("script")
      .map((_index, script) => $(script).html() ?? "")
      .get()
      .find((script) => script.includes("startDate:"));
    const periodStart = calendarScript?.match(/startDate:\s*['"]([^'"]+)/)?.[1];
    const periodEnd = calendarScript?.match(/endDate:\s*['"]([^'"]+)/)?.[1];
    if (!periodStart || !periodEnd) {
      throw new MoneyForwardApiError(
        "Could not determine the transaction period on the cash-flow page.",
      );
    }
    const year = periodStart.slice(0, 4);
    const transactions: MoneyForwardTransactionList["transactions"] = [];
    $("#cf-detail-table tr")
      .slice(1)
      .each((_index, row) => {
        const cells = $(row).find("td");
        const shortDate = cells
          .eq(1)
          .text()
          .trim()
          .match(/(\d{2})\/(\d{2})/)
          ?.slice(1);
        const description = cells.eq(2).text().replace(/\s+/g, " ").trim();
        const amount = parseDisplayNumber(cells.eq(3).text());
        if (!shortDate || !description || amount === null) return;
        const memoCell = cells.eq(7);
        const memo =
          memoCell.text().replace(/\s+/g, " ").trim() ||
          memoCell.find("[title]").attr("title")?.trim() ||
          memoCell.find("input[value]").attr("value")?.trim() ||
          null;
        transactions.push({
          date: `${year}-${shortDate[0]}-${shortDate[1]}`,
          description,
          amount,
          direction: amount >= 0 ? "income" : "expense",
          calculationTarget:
            cells
              .eq(0)
              .find('input[name="user_asset_act[is_target]"]')
              .attr("value") === "1",
          institution: cells.eq(4).text().replace(/\s+/g, " ").trim() || null,
          majorCategory: cells.eq(5).text().replace(/\s+/g, " ").trim() || null,
          minorCategory: cells.eq(6).text().replace(/\s+/g, " ").trim() || null,
          memo,
        });
      });
    return { periodStart, periodEnd, currency: "JPY", transactions };
  }

  async getHouseholdBookSummary(
    month?: string,
  ): Promise<MoneyForwardHouseholdBookSummary> {
    const cookie = month
      ? await this.selectCashFlowMonth(month)
      : this.currentCookie;
    const html = await this.getHtml("/cf/summary", cookie);
    const $ = load(html);
    const totals = $("#monthly_total_table .js-monthly_total td")
      .map((_index, cell) => $(cell).text().replace(/\s+/g, " ").trim())
      .get();
    const income = parseDisplayNumber(totals[0]);
    const expense = parseDisplayNumber(totals[2]);
    const balance = parseDisplayNumber(totals[4]);
    const period =
      month ??
      $("script")
        .map((_index, script) => $(script).html() ?? "")
        .get()
        .map((script) => script.match(/var\s+showDate\s*=\s*"([^"]+)"/)?.[1])
        .find(Boolean);
    if (income === null || expense === null || balance === null || !period) {
      throw new MoneyForwardApiError(
        "Could not parse the household book summary.",
      );
    }

    const parseCategories = (
      selector: string,
    ): MoneyForwardHouseholdCategory[] => {
      const categories: MoneyForwardHouseholdCategory[] = [];
      let current: MoneyForwardHouseholdCategory | undefined;
      $(selector)
        .find("tbody > tr")
        .each((_index, row) => {
          const cells = $(row)
            .find("td")
            .map((_cellIndex, cell) =>
              $(cell).text().replace(/\s+/g, " ").trim(),
            )
            .get();
          const amount = parseDisplayNumber(cells[1]);
          const percentage = parseDisplayNumber(cells[2]);
          if (!cells[0] || amount === null || percentage === null) return;
          if ($(row).hasClass("sum")) {
            current = {
              category: cells[0].replace(/\s+合計$/, ""),
              amount,
              percentage,
              subcategories: [],
            };
            categories.push(current);
          } else if (current) {
            current.subcategories.push({ category: cells[0], amount });
          }
        });
      return categories;
    };

    let incomeCategories = parseCategories("#table-income, #table-in");
    const expenseCategories = parseCategories("#table-outgo");
    if (incomeCategories.length === 0 && income > 0) {
      const transactionList = await this.getTransactions(month);
      const categoryMap = new Map<
        string,
        { amount: number; subcategories: Map<string, number> }
      >();
      for (const transaction of transactionList.transactions) {
        if (
          transaction.direction !== "income" ||
          !transaction.calculationTarget ||
          !transaction.majorCategory
        ) {
          continue;
        }
        const category = categoryMap.get(transaction.majorCategory) ?? {
          amount: 0,
          subcategories: new Map<string, number>(),
        };
        category.amount += transaction.amount;
        if (transaction.minorCategory) {
          category.subcategories.set(
            transaction.minorCategory,
            (category.subcategories.get(transaction.minorCategory) ?? 0) +
              transaction.amount,
          );
        }
        categoryMap.set(transaction.majorCategory, category);
      }
      incomeCategories = [...categoryMap].map(([category, values]) => ({
        category,
        amount: values.amount,
        percentage: income === 0 ? 0 : round((values.amount / income) * 100, 2),
        subcategories: [...values.subcategories].map(
          ([subcategory, amount]) => ({ category: subcategory, amount }),
        ),
      }));
    }
    const categories = new Map<
      string,
      { category: string; income: number; expense: number; balance: number }
    >();
    for (const item of incomeCategories) {
      categories.set(item.category, {
        category: item.category,
        income: item.amount,
        expense: 0,
        balance: item.amount,
      });
    }
    for (const item of expenseCategories) {
      const existing = categories.get(item.category);
      categories.set(item.category, {
        category: item.category,
        income: existing?.income ?? 0,
        expense: item.amount,
        balance: (existing?.income ?? 0) - item.amount,
      });
    }

    return {
      period,
      currency: "JPY",
      income,
      expense,
      balance,
      categorySummaries: [...categories.values()],
      incomeCategories,
      expenseCategories,
    };
  }

  private async selectCashFlowMonth(month: string): Promise<string> {
    const match = month.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
    if (!match) {
      throw new MoneyForwardApiError("month must use YYYY-MM format.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const pageResponse = await this.fetchImpl(`${this.baseUrl}/cf`, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          Cookie: this.currentCookie,
          "User-Agent": USER_AGENT,
        },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!pageResponse.ok) {
        throw new MoneyForwardApiError(
          `Money Forward ME returned HTTP ${pageResponse.status}.`,
          pageResponse.status,
        );
      }
      const pageHtml = await pageResponse.text();
      const csrf = load(pageHtml)('meta[name="csrf-token"]').attr("content");
      if (!csrf) {
        throw new MoneyForwardApiError(
          "Could not find a CSRF token for month selection.",
        );
      }
      let cookie = await this.applyResponseCookies(
        this.currentCookie,
        pageResponse.headers,
      );
      const year = match[1];
      const monthNumber = String(Number(match[2]));
      const response = await this.fetchImpl(`${this.baseUrl}/cf/fetch`, {
        method: "POST",
        headers: {
          Accept: "text/javascript, application/javascript, */*; q=0.01",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Cookie: cookie,
          Origin: this.baseUrl,
          Referer: `${this.baseUrl}/cf`,
          "User-Agent": USER_AGENT,
          "X-CSRF-Token": csrf,
          "X-Requested-With": "XMLHttpRequest",
        },
        body: new URLSearchParams({ from: `${year}/${monthNumber}/1` }),
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new MoneyForwardApiError(
          `Money Forward ME month selection returned HTTP ${response.status}.`,
          response.status,
        );
      }
      await response.text();
      cookie = await this.applyResponseCookies(cookie, response.headers);
      return cookie;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async applyResponseCookies(
    baseCookie: string,
    headers: Headers,
  ): Promise<string> {
    const updatedCookie = mergeResponseCookies(baseCookie, headers);
    if (updatedCookie !== this.currentCookie) {
      this.currentCookie = updatedCookie;
      await this.options.onCookieUpdate?.(updatedCookie);
    }
    return updatedCookie;
  }

  private async getHtml(
    path: string,
    cookie = this.currentCookie,
  ): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          Cookie: cookie,
          Referer: `${this.baseUrl}/`,
          "User-Agent": USER_AGENT,
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
      await this.applyResponseCookies(cookie, response.headers);
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

function mergeResponseCookies(cookie: string, headers: Headers): string {
  const cookieMap = new Map<string, string>();
  for (const pair of cookie.split(/;\s*/)) {
    const index = pair.indexOf("=");
    if (index > 0) cookieMap.set(pair.slice(0, index), pair.slice(index + 1));
  }
  const responseHeaders = headers as Headers & {
    getSetCookie?: () => string[];
  };
  const setCookies = responseHeaders.getSetCookie?.() ?? [];
  for (const setCookie of setCookies) {
    const pair = setCookie.split(";", 1)[0] ?? "";
    const index = pair.indexOf("=");
    if (index > 0) cookieMap.set(pair.slice(0, index), pair.slice(index + 1));
  }
  return [...cookieMap].map(([name, value]) => `${name}=${value}`).join("; ");
}

function parseNumber(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDisplayNumber(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const normalized = value.replaceAll(",", "").replace(/[^0-9+.-]/g, "");
  const parsed = Number(normalized);
  return normalized && Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
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
