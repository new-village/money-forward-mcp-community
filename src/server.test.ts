import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { createServer } from "./server.js";

async function connectedPair() {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "contract-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("MCP contract", () => {
  it("publishes stable agent-facing names, schemas, and version", async () => {
    const { client, server } = await connectedPair();
    try {
      expect(client.getServerVersion()?.version).toBe(packageJson.version);
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toContain("money_forward_get_account");
      expect(names).toContain("money_forward_list_manual_accounts");
      expect(names).toContain("money_forward_list_manual_assets");
      expect(names).not.toContain("money_forward_list_accounts");
      expect(names).not.toContain("money_forward_list_assets");
      for (const tool of tools) {
        expect(tool.outputSchema, tool.name).toBeDefined();
      }
      expect(
        tools.find((tool) => tool.name === "money_forward_clear_cookie")
          ?.annotations?.destructiveHint,
      ).toBe(true);
      expect(
        tools.find((tool) => tool.name === "money_forward_get_cashflow_summary")
          ?.annotations?.readOnlyHint,
      ).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns a structured auth_required error without credential metadata", async () => {
    vi.stubEnv("MONEY_FORWARD_COOKIE", "");
    vi.stubEnv("MF_ME_COOKIE", "");
    vi.stubEnv(
      "MONEY_FORWARD_MCP_COMMUNITY_CONFIG",
      "/tmp/money-forward-mcp-community-nonexistent-contract-test.json",
    );
    const { client, server } = await connectedPair();
    try {
      const response = await client.callTool({
        name: "money_forward_get_account",
        arguments: {},
      });
      expect(response.isError).toBe(true);
      expect(response.structuredContent).toMatchObject({
        error: {
          code: "auth_required",
          retryable: false,
          suggestedTools: [
            "money_forward_auth_login",
            "money_forward_set_cookie",
          ],
        },
      });
      expect(JSON.stringify(response)).not.toContain("cookiePreview");
      expect(JSON.stringify(response)).not.toContain("configPath");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
