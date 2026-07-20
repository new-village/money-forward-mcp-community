import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const COOKIE_ENV_KEYS = ["MONEY_FORWARD_COOKIE", "MF_ME_COOKIE"] as const;
const CONFIG_ENV_KEY = "MONEY_FORWARD_MCP_COMMUNITY_CONFIG";

interface StoredConfig {
  cookie?: string;
  updatedAt?: string;
}

export interface AuthOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  configPath?: string;
}

export interface AuthStatus {
  configured: boolean;
  source: "env" | "config" | "none";
  configPath: string;
  message: string;
  suggestedTools?: string[];
}

export interface CookieContext {
  cookie: string;
  source: "env" | "config";
  configPath: string;
}

export class AuthRequiredError extends Error {
  constructor(message = "Money Forward ME authentication is not configured.") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

export async function readCookie(options: AuthOptions = {}): Promise<string> {
  return (await readCookieContext(options)).cookie;
}

export async function readCookieContext(
  options: AuthOptions = {},
): Promise<CookieContext> {
  const configPath = resolveConfigPath(options);
  const envCookie = readCookieFromEnv(options.env ?? process.env);
  if (envCookie) return { cookie: envCookie, source: "env", configPath };

  const storedCookie = await readCookieFromConfig(options);
  if (storedCookie) {
    return { cookie: storedCookie, source: "config", configPath };
  }

  throw new AuthRequiredError(
    "Money Forward ME cookie is not configured. Use money_forward_auth_login, money_forward_set_cookie, or MONEY_FORWARD_COOKIE.",
  );
}

export async function authStatus(
  options: AuthOptions = {},
): Promise<AuthStatus> {
  const configPath = resolveConfigPath(options);
  const envCookie = readCookieFromEnv(options.env ?? process.env);
  if (envCookie) {
    return {
      configured: true,
      source: "env",
      configPath,
      message:
        "Money Forward ME cookie is configured from an environment variable.",
    };
  }

  const storedCookie = await readCookieFromConfig(options);
  if (storedCookie) {
    return {
      configured: true,
      source: "config",
      configPath,
      message:
        "Money Forward ME cookie is configured from the local config file.",
    };
  }

  return {
    configured: false,
    source: "none",
    configPath,
    message: "Money Forward ME cookie is not configured.",
    suggestedTools: ["money_forward_auth_login", "money_forward_set_cookie"],
  };
}

export async function saveCookie(
  cookie: string,
  options: AuthOptions = {},
): Promise<AuthStatus> {
  const trimmed = cookie.trim();
  if (!trimmed) throw new Error("Cookie must not be empty.");
  if (!trimmed.includes("="))
    throw new Error("Cookie must be a Cookie header such as name=value.");

  const configPath = resolveConfigPath(options);
  await mkdir(dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify({ cookie: trimmed, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await rename(temporaryPath, configPath);
  return authStatus({ ...options, env: {} });
}

export async function clearStoredCookie(
  options: AuthOptions = {},
): Promise<AuthStatus> {
  await rm(resolveConfigPath(options), { force: true });
  return authStatus({ ...options, env: {} });
}

export function resolveConfigPath(options: AuthOptions = {}): string {
  const env = options.env ?? process.env;
  return (
    options.configPath ??
    env[CONFIG_ENV_KEY] ??
    join(homedir(), ".config", "money-forward-mcp-community", "config.json")
  );
}

function readCookieFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string | null {
  for (const key of COOKIE_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return null;
}

async function readCookieFromConfig(
  options: AuthOptions,
): Promise<string | null> {
  try {
    const raw = await readFile(resolveConfigPath(options), "utf8");
    const parsed = JSON.parse(raw) as StoredConfig;
    return parsed.cookie?.trim() || null;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}
