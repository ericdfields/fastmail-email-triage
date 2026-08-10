import { describe, expect, it } from "vitest";
import { normalizeSender, routeDeterministically, senderKey } from "./routing.js";
import type { EmailSummary } from "./types.js";

function makeEmail(overrides: Partial<EmailSummary> = {}): EmailSummary {
  return {
    id: "email-1",
    threadId: "thread-1",
    subject: "Test",
    from: [{ name: "Sender", email: "Sender@Example.com" }],
    receivedAt: "2026-01-01T00:00:00Z",
    preview: "Preview",
    hasListUnsubscribe: false,
    listUnsubscribeUrls: null,
    ...overrides,
  };
}

describe("deterministic routing", () => {
  it("normalizes exact sender keys", () => {
    expect(normalizeSender(" Sender@Example.COM ")).toBe("sender@example.com");
    expect(senderKey(makeEmail())).toBe("sender@example.com");
  });

  it("applies an exact sender rule before List-Unsubscribe", () => {
    const email = makeEmail({ hasListUnsubscribe: true });
    const routed = routeDeterministically(email ? [email] : [], new Map([
      ["sender@example.com", "auto-delete"],
    ]));

    expect(routed.modelEmails).toEqual([]);
    expect(routed.deterministic[0]).toMatchObject({
      tier: "auto-delete",
      reason: "Exact sender rule",
    });
  });

  it("auto-archives List-Unsubscribe mail without a model call", () => {
    const routed = routeDeterministically(
      [makeEmail({ hasListUnsubscribe: true })],
      new Map()
    );

    expect(routed.modelEmails).toEqual([]);
    expect(routed.deterministic[0]).toMatchObject({
      tier: "auto-archive",
      reason: "List-Unsubscribe header",
    });
  });

  it("sends unmatched mail to the model", () => {
    const email = makeEmail();
    const routed = routeDeterministically([email], new Map());

    expect(routed.deterministic).toEqual([]);
    expect(routed.modelEmails).toEqual([email]);
  });
});
