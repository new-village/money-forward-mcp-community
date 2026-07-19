#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { authStatus, clearStoredCookie, saveCookie } from "./auth.js";
import { runBrowserLogin } from "./browser-login.js";
import { MoneyForwardClient } from "./client.js";
import { createServer } from "./server.js";

const command = process.argv[2] ?? "serve";

async function main(): Promise<void> {
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(
      `money-forward-mcp-community\n\nUsage:\n  money-forward-mcp-community serve\n  money-forward-mcp-community auth [--status|--clear|--headless|--headed]\n  money-forward-mcp-community set-cookie '<COOKIE_HEADER>'\n\nEnvironment:\n  MONEY_FORWARD_COOKIE\n  MONEY_FORWARD_MCP_COMMUNITY_CONFIG\n  MONEY_FORWARD_REQUEST_TIMEOUT_MS\n`,
    );
    return;
  }
  if (command === "auth") {
    const args = process.argv.slice(3);
    if (args.includes("--status")) return print(await authStatus());
    if (args.includes("--clear")) return print(await clearStoredCookie());
    const headless = args.includes("--headless")
      ? true
      : args.includes("--headed")
        ? false
        : undefined;
    process.stderr.write(
      "Opening Money Forward ME login in a browser. Complete login and MFA there.\n",
    );
    return print(
      await runBrowserLogin(headless === undefined ? {} : { headless }),
    );
  }
  if (command === "set-cookie") {
    const cookie = process.argv[3];
    if (!cookie)
      throw new Error("set-cookie requires a Cookie header argument.");
    await new MoneyForwardClient({ cookie }).authCheck();
    return print(await saveCookie(cookie));
  }
  if (command !== "serve") throw new Error(`Unknown command: ${command}`);

  const server = createServer();
  await server.connect(new StdioServerTransport());
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`money-forward-mcp-community: ${message}\n`);
  process.exitCode = 1;
});
