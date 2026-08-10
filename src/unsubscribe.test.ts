import { describe, expect, it, vi } from "vitest";
import {
  isPublicAddress,
  hasAuthenticatedOneClick,
  selectOneClickUrl,
  unsubscribeOneClick,
  validateOneClickUrl,
} from "./unsubscribe.js";

describe("selectOneClickUrl", () => {
  it("selects an HTTPS URL only when the RFC 8058 header is present", () => {
    expect(
      selectOneClickUrl(
        ["mailto:leave@example.com", "https://news.example.com/unsubscribe?id=1"],
        "List-Unsubscribe=One-Click"
      )
    ).toBe("https://news.example.com/unsubscribe?id=1");
  });

  it("rejects ordinary web and mailto unsubscribe links", () => {
    expect(selectOneClickUrl(["https://news.example.com/preferences"], null)).toBeNull();
    expect(selectOneClickUrl(["mailto:leave@example.com"], "List-Unsubscribe=One-Click")).toBeNull();
  });

  it("skips malformed URLs", () => {
    expect(
      selectOneClickUrl(["not a url", "https://safe.example.com/leave"], "list-unsubscribe = one-click")
    ).toBe("https://safe.example.com/leave");
  });
});

describe("hasAuthenticatedOneClick", () => {
  it("accepts a passing DKIM domain that signs both unsubscribe headers", () => {
    expect(
      hasAuthenticatedOneClick(
        ["mx.fastmail.com; dkim=pass header.d=mailer.example.com; spf=pass"],
        [
          "v=1; a=rsa-sha256; d=mailer.example.com; s=mail; h=from:to:subject:list-unsubscribe:list-unsubscribe-post; b=abc",
        ]
      )
    ).toBe(true);
  });

  it("rejects failed, mismatched, or incompletely covered signatures", () => {
    expect(
      hasAuthenticatedOneClick(
        ["mx.fastmail.com; dkim=fail header.d=mailer.example.com"],
        ["v=1; d=mailer.example.com; h=list-unsubscribe:list-unsubscribe-post"]
      )
    ).toBe(false);
    expect(
      hasAuthenticatedOneClick(
        ["mx.fastmail.com; dkim=pass header.d=mailer.example.com"],
        ["v=1; d=other.example.com; h=list-unsubscribe:list-unsubscribe-post"]
      )
    ).toBe(false);
    expect(
      hasAuthenticatedOneClick(
        ["mx.fastmail.com; dkim=pass header.d=mailer.example.com"],
        ["v=1; d=mailer.example.com; h=from:list-unsubscribe"]
      )
    ).toBe(false);
  });
});

describe("public-address validation", () => {
  it("accepts globally routable IPv4 and IPv6 addresses", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("rejects loopback, private, link-local, and mapped private addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.1.2",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });
});

describe("validateOneClickUrl", () => {
  it("requires HTTPS, port 443, no credentials, and a public hostname", async () => {
    const resolve = vi.fn().mockResolvedValue([{ address: "203.0.114.20", family: 4 }]);

    await expect(validateOneClickUrl("http://example.com/leave", resolve)).rejects.toThrow("HTTPS");
    await expect(validateOneClickUrl("https://example.com:8443/leave", resolve)).rejects.toThrow("port 443");
    await expect(validateOneClickUrl("https://user:pass@example.com/leave", resolve)).rejects.toThrow("credentials");
    await expect(validateOneClickUrl("https://localhost/leave", resolve)).rejects.toThrow("public hostname");
  });

  it("rejects a hostname if any DNS result is private", async () => {
    const resolve = vi.fn().mockResolvedValue([
      { address: "203.0.114.20", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);

    await expect(validateOneClickUrl("https://example.com/leave", resolve)).rejects.toThrow(
      "non-public address"
    );
  });
});

describe("unsubscribeOneClick", () => {
  it("posts through a pre-resolved public address and returns only audit-safe metadata", async () => {
    const resolve = vi.fn().mockResolvedValue([{ address: "203.0.114.20", family: 4 }]);
    const post = vi.fn().mockResolvedValue(204);

    const result = await unsubscribeOneClick("https://news.example.com/leave?token=secret", {
      resolve,
      post,
    });

    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "news.example.com" }),
      { address: "203.0.114.20", family: 4 }
    );
    expect(result).toEqual({ httpStatus: 204, targetHost: "news.example.com" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("treats redirects and other non-2xx responses as failures", async () => {
    const resolve = vi.fn().mockResolvedValue([{ address: "203.0.114.20", family: 4 }]);
    const post = vi.fn().mockResolvedValue(302);

    await expect(
      unsubscribeOneClick("https://news.example.com/leave", { resolve, post })
    ).rejects.toThrow("HTTP 302");
  });
});
