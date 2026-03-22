import { describe, it, expect } from "bun:test";
import {
  resolveCookieConfig,
  serializeSessionCookie,
  clearSessionCookie,
  parseSessionCookie,
  serializeStateCookie,
  parseCookieValue,
} from "../src/core/cookie.ts";

describe("resolveCookieConfig", () => {
  it("should return defaults when no options provided", () => {
    const config = resolveCookieConfig();
    expect(config.name).toBe("auth_session");
    expect(config.secure).toBe(true);
    expect(config.sameSite).toBe("lax");
    expect(config.path).toBe("/");
    expect(config.domain).toBeUndefined();
  });

  it("should override defaults with provided options", () => {
    const config = resolveCookieConfig({
      name: "my_session",
      secure: false,
      sameSite: "strict",
      domain: "example.com",
      path: "/app",
    });
    expect(config.name).toBe("my_session");
    expect(config.secure).toBe(false);
    expect(config.sameSite).toBe("strict");
    expect(config.domain).toBe("example.com");
    expect(config.path).toBe("/app");
  });

  it("should partially override defaults", () => {
    const config = resolveCookieConfig({ name: "custom" });
    expect(config.name).toBe("custom");
    expect(config.secure).toBe(true);
    expect(config.sameSite).toBe("lax");
  });
});

describe("serializeSessionCookie", () => {
  const config = resolveCookieConfig();

  it("should serialize a session cookie with all attributes", () => {
    const cookie = serializeSessionCookie(config, "my-token", 86400);
    expect(cookie).toContain("auth_session=my-token");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=86400");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
  });

  it("should not include Secure when config.secure is false", () => {
    const insecureConfig = resolveCookieConfig({ secure: false });
    const cookie = serializeSessionCookie(insecureConfig, "tok", 3600);
    expect(cookie).not.toContain("Secure");
  });

  it("should include Domain when set", () => {
    const domainConfig = resolveCookieConfig({ domain: "example.com" });
    const cookie = serializeSessionCookie(domainConfig, "tok", 3600);
    expect(cookie).toContain("Domain=example.com");
  });

  it("should handle custom cookie name", () => {
    const customConfig = resolveCookieConfig({ name: "sid" });
    const cookie = serializeSessionCookie(customConfig, "tok", 3600);
    expect(cookie).toContain("sid=tok");
  });
});

describe("clearSessionCookie", () => {
  it("should set Max-Age to 0 and empty value", () => {
    const config = resolveCookieConfig();
    const cookie = clearSessionCookie(config);
    expect(cookie).toContain("auth_session=");
    expect(cookie).toContain("Max-Age=0");
  });
});

describe("parseSessionCookie", () => {
  const config = resolveCookieConfig();

  it("should parse the session token from cookie header", () => {
    const token = parseSessionCookie(config, "auth_session=abc123");
    expect(token).toBe("abc123");
  });

  it("should parse from multiple cookies", () => {
    const token = parseSessionCookie(
      config,
      "other=foo; auth_session=abc123; bar=baz"
    );
    expect(token).toBe("abc123");
  });

  it("should return null for missing cookie", () => {
    const token = parseSessionCookie(config, "other=foo; bar=baz");
    expect(token).toBeNull();
  });

  it("should return null for null header", () => {
    const token = parseSessionCookie(config, null);
    expect(token).toBeNull();
  });

  it("should return null for empty cookie value", () => {
    const token = parseSessionCookie(config, "auth_session=");
    expect(token).toBeNull();
  });

  it("should handle custom cookie names", () => {
    const customConfig = resolveCookieConfig({ name: "sid" });
    const token = parseSessionCookie(customConfig, "sid=my-token-123");
    expect(token).toBe("my-token-123");
  });
});

describe("serializeStateCookie", () => {
  it("should create a short-lived state cookie", () => {
    const config = resolveCookieConfig();
    const cookie = serializeStateCookie("oauth_state", "state123", config);
    expect(cookie).toContain("oauth_state=state123");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Max-Age=600");
    expect(cookie).toContain("SameSite=Lax");
  });
});

describe("parseCookieValue", () => {
  it("should parse a named cookie value", () => {
    const value = parseCookieValue("oauth_state=abc; other=123", "oauth_state");
    expect(value).toBe("abc");
  });

  it("should return null when cookie not found", () => {
    const value = parseCookieValue("other=123", "oauth_state");
    expect(value).toBeNull();
  });

  it("should return null for null header", () => {
    const value = parseCookieValue(null, "anything");
    expect(value).toBeNull();
  });
});
