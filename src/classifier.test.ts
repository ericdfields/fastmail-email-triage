import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn(function (this: Record<string, unknown>) {
    this.messages = { create: mockCreate };
  }),
}));

import { classifyBatch } from "./classifier.js";
import type { EmailSummary } from "./types.js";

function makeEmail(overrides: Partial<EmailSummary> = {}): EmailSummary {
  return {
    id: "email-1",
    threadId: "thread-1",
    subject: "Test subject",
    from: [{ name: "Alice", email: "alice@example.com" }],
    receivedAt: "2024-01-01T00:00:00Z",
    preview: "Hello world",
    hasListUnsubscribe: false,
    listUnsubscribeUrls: null,
    ...overrides,
  };
}

function makeApiResponse(items: { emailId: string; tier: string; reason: string }[], fenced = false) {
  const json = JSON.stringify(items);
  const text = fenced ? `\`\`\`json\n${json}\n\`\`\`` : json;
  return { content: [{ type: "text", text }] };
}

describe("classifyBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses a plain JSON response", async () => {
    const email = makeEmail();
    mockCreate.mockResolvedValue(
      makeApiResponse([{ emailId: "email-1", tier: "attention", reason: "From a real person" }])
    );

    const result = await classifyBatch([email]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      emailId: "email-1",
      tier: "attention",
      reason: "From a real person",
      subject: "Test subject",
      from: "alice@example.com",
      hasListUnsubscribe: false,
    });
  });

  it("parses a markdown-fenced JSON response", async () => {
    const email = makeEmail();
    mockCreate.mockResolvedValue(
      makeApiResponse([{ emailId: "email-1", tier: "auto-archive", reason: "Newsletter" }], true)
    );

    const result = await classifyBatch([email]);

    expect(result[0]?.tier).toBe("auto-archive");
  });

  it("maps from addresses to email-only strings", async () => {
    const email = makeEmail({
      from: [
        { name: "Alice", email: "alice@example.com" },
        { name: null, email: "bob@example.com" },
      ],
    });
    mockCreate.mockResolvedValue(
      makeApiResponse([{ emailId: "email-1", tier: "confirm", reason: "Ambiguous" }])
    );

    const result = await classifyBatch([email]);

    expect(result[0]?.from).toBe("alice@example.com, bob@example.com");
  });

  it("falls back to (unknown) values when email ID not in original list", async () => {
    mockCreate.mockResolvedValue(
      makeApiResponse([{ emailId: "email-999", tier: "confirm", reason: "Ambiguous" }])
    );

    const result = await classifyBatch([makeEmail({ id: "email-1" })]);

    expect(result[0]?.subject).toBe("(unknown)");
    expect(result[0]?.from).toBe("(unknown)");
    expect(result[0]?.hasListUnsubscribe).toBe(false);
  });

  it("handles multiple emails in a single batch", async () => {
    const emails = [
      makeEmail({ id: "email-1", subject: "First" }),
      makeEmail({ id: "email-2", subject: "Second", hasListUnsubscribe: true }),
    ];
    mockCreate.mockResolvedValue(
      makeApiResponse([
        { emailId: "email-1", tier: "attention", reason: "Real person" },
        { emailId: "email-2", tier: "auto-archive", reason: "Newsletter" },
      ])
    );

    const result = await classifyBatch(emails);

    expect(result).toHaveLength(2);
    expect(result[0]?.tier).toBe("attention");
    expect(result[1]?.tier).toBe("auto-archive");
    expect(result[1]?.hasListUnsubscribe).toBe(true);
  });

  it("passes the correct model to the API", async () => {
    mockCreate.mockResolvedValue(
      makeApiResponse([{ emailId: "email-1", tier: "confirm", reason: "Test" }])
    );

    await classifyBatch([makeEmail()], "claude-haiku-4-5-20251001");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5-20251001" })
    );
  });

  it("defaults to claude-sonnet-4-6", async () => {
    mockCreate.mockResolvedValue(
      makeApiResponse([{ emailId: "email-1", tier: "confirm", reason: "Test" }])
    );

    await classifyBatch([makeEmail()]);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-6" })
    );
  });

  it("preserves receivedAt from original email", async () => {
    const email = makeEmail({ receivedAt: "2024-06-15T12:00:00Z" });
    mockCreate.mockResolvedValue(
      makeApiResponse([{ emailId: "email-1", tier: "attention", reason: "r" }])
    );

    const result = await classifyBatch([email]);

    expect(result[0]?.receivedAt).toBe("2024-06-15T12:00:00Z");
  });
});
