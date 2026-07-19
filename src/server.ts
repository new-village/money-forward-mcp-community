import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  authStatus,
  clearStoredCookie,
  readCookie,
  saveCookie,
} from "./auth.js";
import { runBrowserLogin } from "./browser-login.js";
import { MoneyForwardClient } from "./client.js";

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  };
}

function errorResult(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Unknown Money Forward ME error";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

async function withClient<T>(
  operation: (client: MoneyForwardClient) => Promise<T>,
) {
  try {
    return result(
      await operation(new MoneyForwardClient({ cookie: await readCookie() })),
    );
  } catch (error) {
    return errorResult(error);
  }
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "money-forward-mcp-community",
    version: "0.1.0",
  });

  server.registerTool(
    "money_forward_auth_status",
    {
      title: "Get Money Forward ME authentication status",
      description:
        "Checks whether a Money Forward ME cookie is configured from env or config file.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => result(await authStatus()),
  );

  server.registerTool(
    "money_forward_auth_login",
    {
      title: "Log in to Money Forward ME with a browser",
      description:
        "Opens a Playwright browser login flow and stores Money Forward cookies locally. Use set_cookie for remote servers.",
      inputSchema: { headless: z.boolean().optional() },
    },
    async ({ headless }) => {
      try {
        return result(
          await runBrowserLogin(headless === undefined ? {} : { headless }),
        );
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
        "Verifies and stores a trusted Money Forward Cookie header in the local config file.",
      inputSchema: {
        cookie: z.string().min(1),
        verify: z.boolean().default(true),
      },
    },
    async ({ cookie, verify }) => {
      try {
        if (verify) await new MoneyForwardClient({ cookie }).authCheck();
        return result(await saveCookie(cookie));
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
        "Deletes the config-file cookie. Environment variables are not modified.",
      inputSchema: {},
    },
    async () => result(await clearStoredCookie()),
  );

  server.registerTool(
    "money_forward_auth_check",
    {
      title: "Check Money Forward ME authentication",
      description:
        "Verifies that the configured cookie can access the authenticated accounts page.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => withClient((client) => client.authCheck()),
  );

  server.registerTool(
    "money_forward_list_accounts",
    {
      title: "List Money Forward ME manual accounts",
      description:
        "Lists custom/manual accounts from the authenticated Money Forward ME accounts page.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => withClient((client) => client.listAccounts()),
  );

  server.registerTool(
    "money_forward_list_assets",
    {
      title: "List Money Forward ME manual assets",
      description: "Lists assets in a custom/manual account.",
      inputSchema: {
        accountString: z
          .string()
          .min(1)
          .describe("accountString returned by money_forward_list_accounts"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ accountString }) =>
      withClient((client) => client.listAssets(accountString)),
  );

  return server;
}
