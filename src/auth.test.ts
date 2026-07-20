import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  authStatus,
  readCookie,
  readCookieContext,
  saveCookie,
} from "./auth.js";

describe("Money Forward authentication config", () => {
  it("prefers an environment cookie over the config file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "money-forward-auth-"));
    const configPath = join(directory, "config.json");
    await saveCookie("stored=cookie", { configPath });

    await expect(
      readCookie({ configPath, env: { MONEY_FORWARD_COOKIE: "env=cookie" } }),
    ).resolves.toBe("env=cookie");
  });

  it("stores the cookie with owner-only permissions and never returns its full value", async () => {
    const directory = await mkdtemp(join(tmpdir(), "money-forward-auth-"));
    const configPath = join(directory, "config.json");
    const cookie = "money_forward_session=very-secret-value";
    const status = await saveCookie(cookie, { configPath });

    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect(status).not.toHaveProperty("cookiePreview");
    expect(await readFile(configPath, "utf8")).toContain(cookie);
    await expect(authStatus({ configPath, env: {} })).resolves.toMatchObject({
      configured: true,
      source: "config",
    });
    await expect(readCookieContext({ configPath, env: {} })).resolves.toEqual({
      cookie,
      source: "config",
      configPath,
    });
  });
});
