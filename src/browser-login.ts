import { saveCookie, type AuthStatus } from "./auth.js";
import { MoneyForwardClient } from "./client.js";

interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
}

export interface BrowserLoginOptions {
  timeoutMs?: number;
  headless?: boolean;
  save?: boolean;
}

export interface BrowserLoginResult {
  authenticated: boolean;
  saved: boolean;
  cookiePreview: string;
  message: string;
  configPath?: string;
}

export function cookiesToHeader(cookies: BrowserCookie[]): string {
  const selected = cookies.filter((cookie) =>
    isMoneyForwardDomain(cookie.domain),
  );
  if (selected.length === 0) {
    throw new Error(
      "No moneyforward.com cookies were found in the browser session.",
    );
  }
  return selected.map(({ name, value }) => `${name}=${value}`).join("; ");
}

export async function runBrowserLogin(
  options: BrowserLoginOptions = {},
): Promise<BrowserLoginResult> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const headless =
    options.headless ??
    process.env.MONEY_FORWARD_MCP_COMMUNITY_HEADLESS === "true";
  const { chromium } = await importPlaywright();
  let browser;
  try {
    browser = await chromium.launch({ headless });
  } catch (error) {
    throw toBrowserLoginError(error);
  }

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("https://moneyforward.com/users/sign_in", {
      waitUntil: "domcontentloaded",
    });
    const deadline = Date.now() + timeoutMs;
    let lastCookie = "";

    while (Date.now() < deadline) {
      await page.waitForTimeout(2_000);
      const browserCookies = await context.cookies();
      try {
        lastCookie = cookiesToHeader(browserCookies);
        const client = new MoneyForwardClient({ cookie: lastCookie });
        await client.authCheck();
        const shouldSave = options.save ?? true;
        const status = shouldSave ? await saveCookie(lastCookie) : undefined;
        return buildResult(lastCookie, shouldSave, status);
      } catch {
        // The user may still be entering credentials or completing MFA.
      }
    }

    throw new Error(
      lastCookie
        ? "Timed out waiting for Money Forward ME authentication to become valid."
        : "Timed out waiting for Money Forward ME login cookies.",
    );
  } finally {
    await browser.close();
  }
}

async function importPlaywright(): Promise<typeof import("playwright")> {
  try {
    return await import("playwright");
  } catch (error) {
    throw new Error(
      `Browser login requires the optional playwright package. Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function buildResult(
  cookie: string,
  saved: boolean,
  status?: Pick<AuthStatus, "configPath" | "cookiePreview">,
): BrowserLoginResult {
  return {
    authenticated: true,
    saved,
    ...(status?.configPath ? { configPath: status.configPath } : {}),
    cookiePreview: status?.cookiePreview ?? previewCookie(cookie),
    message: status?.configPath
      ? `Money Forward ME authentication configured. Cookie saved to ${status.configPath}.`
      : "Money Forward ME authentication configured from browser login.",
  };
}

function toBrowserLoginError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("Executable doesn't exist") ||
    message.includes("playwright install")
  ) {
    return new Error(
      [
        "Playwright Chromium is not installed.",
        "Run: npx -p playwright playwright install chromium",
        "For a remote server, use MONEY_FORWARD_COOKIE or MONEY_FORWARD_MCP_COMMUNITY_CONFIG instead.",
      ].join("\n"),
    );
  }
  return error instanceof Error ? error : new Error(message);
}

function isMoneyForwardDomain(domain: string): boolean {
  const normalized = domain.replace(/^\./, "").toLowerCase();
  return (
    normalized === "moneyforward.com" ||
    normalized.endsWith(".moneyforward.com")
  );
}

function previewCookie(cookie: string): string {
  if (cookie.length <= 8) return "********";
  return `${cookie.slice(0, 4)}…${cookie.slice(-4)}`;
}
