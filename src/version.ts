import { createRequire } from "node:module";

const packageJson = createRequire(import.meta.url)("../package.json") as {
  version?: unknown;
};

export const PACKAGE_VERSION =
  typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
export const USER_AGENT = `money-forward-mcp-community/${PACKAGE_VERSION}`;
