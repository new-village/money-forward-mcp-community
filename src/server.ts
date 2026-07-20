import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  AuthRequiredError,
  authStatus,
  clearStoredCookie,
  readCookieContext,
  saveCookie,
} from "./auth.js";
import { runBrowserLogin } from "./browser-login.js";
import { MoneyForwardApiError, MoneyForwardClient } from "./client.js";
import { PACKAGE_VERSION } from "./version.js";

const authStatusSchema = z.object({
  configured: z.boolean(),
  source: z.enum(["env", "config", "none"]),
  message: z.string(),
  suggestedTools: z.array(z.string()).optional(),
});

const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .describe("Calendar month in YYYY-MM format, for example 2026-06");

const accountEntrySchema = z.object({
  accountId: z.string().nullable(),
  institution: z.string(),
  name: z.string(),
  kind: z.enum(["asset", "liability"]),
  category: z.string().nullable(),
  balance: z
    .number()
    .describe("Signed JPY balance: assets positive, liabilities negative"),
  currency: z.literal("JPY"),
  source: z.enum([
    "account_detail",
    "portfolio",
    "liability",
    "account_summary",
  ]),
  registeredAt: z.string().nullable(),
  lastFetchedAt: z.string().nullable(),
  status: z.string().nullable(),
});

const breakdownItemSchema = z.object({
  category: z.string(),
  value: z.number(),
  percentage: z.number(),
});

const portfolioSummarySchema = z.object({
  total: z.number(),
  currency: z.literal("JPY"),
  items: z.array(breakdownItemSchema),
});

const portfolioDetailsSchema = z.array(
  z.object({
    category: z.string(),
    total: z.number(),
    items: z.array(
      z.object({
        name: z.string(),
        value: z.number(),
        institution: z.string().nullable(),
        details: z.record(z.string(), z.string()),
      }),
    ),
  }),
);

const liabilityDetailsSchema = z.array(
  z.object({
    category: z.string(),
    name: z.string(),
    balance: z.number(),
    institution: z.string().nullable(),
  }),
);

const transactionSchema = z.object({
  date: z.string(),
  description: z.string(),
  amount: z
    .number()
    .describe("Signed amount: income positive, expense negative"),
  direction: z.enum(["income", "expense"]),
  calculationTarget: z.boolean(),
  institution: z.string().nullable(),
  majorCategory: z.string().nullable(),
  minorCategory: z.string().nullable(),
  memo: z.string().nullable(),
});

const householdCategorySchema = z.object({
  category: z.string(),
  amount: z.number(),
  percentage: z.number(),
  subcategories: z.array(
    z.object({ category: z.string(), amount: z.number() }),
  ),
});

const cashflowSummarySchema = z.object({
  period: z.string(),
  currency: z.literal("JPY"),
  income: z.number(),
  expense: z.number(),
  balance: z.number(),
  categorySummaries: z.array(
    z.object({
      category: z.string(),
      income: z.number(),
      expense: z.number(),
      balance: z.number(),
    }),
  ),
  incomeCategories: z.array(householdCategorySchema),
  expenseCategories: z.array(householdCategorySchema),
});

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  };
}

function errorResult(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Unknown Money Forward ME error";
  let code = "unknown_error";
  let retryable = false;
  let suggestedTools: string[] | undefined;
  if (error instanceof AuthRequiredError) {
    code = "auth_required";
    suggestedTools = ["money_forward_auth_login", "money_forward_set_cookie"];
  } else if (error instanceof MoneyForwardApiError) {
    if (error.status === 401) {
      code = "auth_expired";
      suggestedTools = ["money_forward_auth_check", "money_forward_auth_login"];
    } else if (message.includes("timed out")) {
      code = "upstream_timeout";
      retryable = true;
    } else if (error.status !== undefined) {
      code = "upstream_http_error";
      retryable = error.status >= 500;
    } else if (
      message.includes("Could not find") ||
      message.includes("Could not parse") ||
      message.includes("invalid format")
    ) {
      code = "page_format_changed";
    } else {
      code = "upstream_error";
    }
  }
  const structuredError = {
    code,
    message,
    retryable,
    ...(suggestedTools ? { suggestedTools } : {}),
  };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(structuredError) }],
    structuredContent: { error: structuredError },
  };
}

function publicAuthStatus(status: Awaited<ReturnType<typeof authStatus>>) {
  return {
    configured: status.configured,
    source: status.source,
    message: status.message,
    ...(status.suggestedTools ? { suggestedTools: status.suggestedTools } : {}),
  };
}

async function withClient<T>(
  operation: (client: MoneyForwardClient) => Promise<T>,
) {
  try {
    const context = await readCookieContext();
    const client = new MoneyForwardClient({
      cookie: context.cookie,
      ...(context.source === "config"
        ? {
            onCookieUpdate: async (cookie: string) => {
              await saveCookie(cookie, {
                configPath: context.configPath,
                env: {},
              });
            },
          }
        : {}),
    });
    return result(await operation(client));
  } catch (error) {
    return errorResult(error);
  }
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "money-forward-mcp-community",
    version: PACKAGE_VERSION,
  });

  server.registerTool(
    "money_forward_auth_status",
    {
      title: "Get Money Forward ME authentication status",
      description:
        "Checks local configuration only; it does not contact Money Forward. Use auth_check to verify that the cookie still works.",
      inputSchema: {},
      outputSchema: { result: authStatusSchema },
      annotations: { readOnlyHint: true },
    },
    async () => result(publicAuthStatus(await authStatus())),
  );

  server.registerTool(
    "money_forward_auth_login",
    {
      title: "Log in to Money Forward ME with a browser",
      description:
        "Opens a Playwright browser login flow and stores Money Forward cookies locally. Use set_cookie for remote servers.",
      inputSchema: {
        headless: z
          .boolean()
          .optional()
          .describe("Defaults to false; headed mode is recommended for MFA"),
      },
      outputSchema: {
        result: z.object({
          authenticated: z.boolean(),
          saved: z.boolean(),
          message: z.string(),
        }),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ headless }) => {
      try {
        const login = await runBrowserLogin(
          headless === undefined ? {} : { headless },
        );
        return result({
          authenticated: login.authenticated,
          saved: login.saved,
          message:
            "Money Forward ME authentication configured from browser login.",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "money_forward_set_cookie",
    {
      title: "Set Money Forward ME cookie",
      description:
        "Verifies and stores a trusted full Cookie header in the local config file. This writes sensitive local state; never request Cookies in an untrusted or retained conversation.",
      inputSchema: {
        cookie: z
          .string()
          .min(1)
          .describe(
            "Full trusted Cookie request header, for example name=value; other=value",
          ),
        verify: z
          .boolean()
          .default(true)
          .describe(
            "When true, contacts Money Forward and saves only after authentication succeeds",
          ),
      },
      outputSchema: { result: authStatusSchema },
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ cookie, verify }) => {
      try {
        if (verify) await new MoneyForwardClient({ cookie }).authCheck();
        return result(publicAuthStatus(await saveCookie(cookie)));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "money_forward_clear_cookie",
    {
      title: "Clear stored Money Forward ME cookie",
      description:
        "Deletes the config-file Cookie and may disable subsequent data tools. Environment-variable Cookies are not modified.",
      inputSchema: {},
      outputSchema: { result: authStatusSchema },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async () => result(publicAuthStatus(await clearStoredCookie())),
  );

  server.registerTool(
    "money_forward_auth_check",
    {
      title: "Check Money Forward ME authentication",
      description:
        "Contacts Money Forward and verifies that the configured cookie can access an authenticated page. Call this when a data tool reports an authentication error.",
      inputSchema: {},
      outputSchema: {
        result: z.object({ authenticated: z.literal(true) }),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => withClient((client) => client.authCheck()),
  );

  server.registerTool(
    "money_forward_get_portfolio_summary",
    {
      title: "Get Money Forward ME portfolio summary",
      description:
        "Returns total assets and asset-class allocation, including zero-balance classes. Prefer this compact tool for net-worth or allocation questions; use portfolio_details only for individual holdings.",
      inputSchema: {},
      outputSchema: { result: portfolioSummarySchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => withClient((client) => client.getAssetBreakdown()),
  );

  server.registerTool(
    "money_forward_get_portfolio_details",
    {
      title: "Get Money Forward ME portfolio details",
      description:
        "Returns individual holdings grouped by asset class, with values, institutions, and source-specific fields. This response is larger; use portfolio_summary when holdings are not required.",
      inputSchema: {},
      outputSchema: { result: portfolioDetailsSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => withClient((client) => client.getAssetDetails()),
  );

  server.registerTool(
    "money_forward_get_liability_summary",
    {
      title: "Get Money Forward ME liability summary",
      description:
        "Returns total liabilities and allocation by liability class. Values are positive amounts owed. Use liability_details for individual loans or card balances.",
      inputSchema: {},
      outputSchema: { result: portfolioSummarySchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => withClient((client) => client.getLiabilityBreakdown()),
  );

  server.registerTool(
    "money_forward_get_liability_details",
    {
      title: "Get Money Forward ME liability details",
      description:
        "Returns individual liabilities with positive amounts owed, category, description, and institution. For a signed flat account view, use money_forward_get_account instead.",
      inputSchema: {},
      outputSchema: { result: liabilityDetailsSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => withClient((client) => client.getLiabilityDetails()),
  );

  server.registerTool(
    "money_forward_get_cashflow_details",
    {
      title: "Get Money Forward ME cashflow details",
      description:
        "Returns individual cashflow rows. Prefer cashflow_summary for totals and category questions. Pass an explicit month for reproducible results; filters reduce response size.",
      inputSchema: {
        month: monthSchema.optional(),
        direction: z
          .enum(["all", "income", "expense"])
          .default("all")
          .describe("Filter by cashflow direction"),
        calculationTargetOnly: z
          .boolean()
          .default(false)
          .describe("Return only rows included in Money Forward calculations"),
      },
      outputSchema: {
        result: z.object({
          periodStart: z.string(),
          periodEnd: z.string(),
          currency: z.literal("JPY"),
          transactions: z.array(transactionSchema),
        }),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ month, direction, calculationTargetOnly }) =>
      withClient(async (client) => {
        const cashflow = await client.getTransactions(month);
        return {
          ...cashflow,
          transactions: cashflow.transactions.filter(
            (transaction) =>
              (direction === "all" || transaction.direction === direction) &&
              (!calculationTargetOnly || transaction.calculationTarget),
          ),
        };
      }),
  );

  server.registerTool(
    "money_forward_get_cashflow_summary",
    {
      title: "Get Money Forward ME cashflow summary",
      description:
        "Returns monthly income, expense, net balance, and category totals. Use this first for monthly analysis; use cashflow_details only when individual rows are needed. Pass month as YYYY-MM for reproducible results.",
      inputSchema: {
        month: monthSchema.optional(),
      },
      outputSchema: { result: cashflowSummarySchema },
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ month }) =>
      withClient((client) => client.getHouseholdBookSummary(month)),
  );

  server.registerTool(
    "money_forward_get_account",
    {
      title: "Get Money Forward ME accounts",
      description:
        "Returns a flat account-entry list across bank accounts, securities, points, cards, and loans. Assets have positive balance; liabilities have negative balance, so summing balance yields net value. source explains where each row came from.",
      inputSchema: {},
      outputSchema: { result: z.array(accountEntrySchema) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => withClient((client) => client.getAccounts()),
  );

  server.registerTool(
    "money_forward_list_manual_accounts",
    {
      title: "List Money Forward ME manual accounts",
      description:
        "Lists only custom/manual accounts. Do not use this for linked banks, cards, securities, or loans; use money_forward_get_account for those.",
      inputSchema: {},
      outputSchema: {
        result: z.array(
          z.object({
            name: z.string(),
            id: z.string(),
          }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => withClient((client) => client.listManualAccounts()),
  );

  server.registerTool(
    "money_forward_list_manual_assets",
    {
      title: "List assets in a Money Forward ME manual account",
      description:
        "Lists assets for one custom/manual account. First call money_forward_list_manual_accounts and pass its id exactly.",
      inputSchema: {
        accountId: z
          .string()
          .min(1)
          .describe("Opaque id returned by money_forward_list_manual_accounts"),
      },
      outputSchema: {
        result: z.array(
          z.object({
            assetId: z.string(),
            assetSubclassId: z.string(),
            name: z.string(),
            value: z.number(),
            entryPrice: z.number().nullable(),
            entryDate: z.string().nullable(),
          }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ accountId }) =>
      withClient((client) => client.listManualAssets(accountId)),
  );

  return server;
}
