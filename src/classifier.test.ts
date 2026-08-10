import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKUP_MODEL,
  PRIMARY_MODEL,
  classifyBatch,
} from "./classifier.js";
import type { EmailSummary } from "./types.js";

const mockFetch = vi.fn();

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

function apiResponse(
  classifications: Array<{ i: number; t: string; r: string | null }>,
  options: { status?: number; usage?: Record<string, unknown> } = {}
) {
  const status = options.status ?? 200;
  return Promise.resolve(new Response(JSON.stringify({
    ...(status >= 400 ? { error: { message: "provider failed" } } : {}),
    choices: [{ message: { content: JSON.stringify({ classifications }) } }],
    usage: options.usage ?? { prompt_tokens: 100, completion_tokens: 25, cost: 0.001 },
  }), { status }));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPENROUTER_API_KEY = "test-key";
  vi.stubGlobal("fetch", mockFetch);
});

describe("classifyBatch", () => {
  it("classifies through the primary model", async () => {
    mockFetch.mockImplementationOnce(() => apiResponse([{ i: 0, t: "n", r: "A person expects a reply" }]));

    const result = await classifyBatch([makeEmail()]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      emailId: "email-1",
      tier: "attention",
      reason: "A person expects a reply",
      from: "alice@example.com",
    });
    const request = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
    expect(request.model).toBe(PRIMARY_MODEL);
    expect(request.response_format.type).toBe("json_schema");
  });

  it("uses compact indexed input without timestamps or unsubscribe metadata", async () => {
    mockFetch.mockImplementationOnce(() => apiResponse([{ i: 0, t: "c", r: "Ambiguous sender" }]));
    await classifyBatch([makeEmail({ preview: "x".repeat(300) })]);

    const request = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
    const payload = JSON.parse(request.messages[1].content);
    expect(payload[0]).toEqual({
      i: 0,
      s: "Test subject",
      f: "Alice <alice@example.com>",
      p: "x".repeat(160),
    });
  });

  it("uses local fixed reasons for automated tiers", async () => {
    mockFetch.mockImplementationOnce(() => apiResponse([
      { i: 0, t: "d", r: null },
      { i: 1, t: "a", r: null },
    ]));

    const result = await classifyBatch([
      makeEmail({ id: "email-1" }),
      makeEmail({ id: "email-2" }),
    ]);

    expect(result[0]?.reason).toBe("Promotional or unsafe automated mail");
    expect(result[1]?.reason).toBe("Automated mail requiring no response");
  });

  it("retries once with the backup model", async () => {
    mockFetch
      .mockImplementationOnce(() => apiResponse([], { status: 503 }))
      .mockImplementationOnce(() => apiResponse([{ i: 0, t: "a", r: null }]));
    const onAttempt = vi.fn(async () => {});

    const result = await classifyBatch([makeEmail()], { onAttempt });

    expect(result[0]?.tier).toBe("auto-archive");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstRequest = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
    const secondRequest = JSON.parse(mockFetch.mock.calls[1]![1].body as string);
    expect(firstRequest.model).toBe(PRIMARY_MODEL);
    expect(secondRequest.model).toBe(BACKUP_MODEL);
    expect(onAttempt).toHaveBeenNthCalledWith(1, expect.objectContaining({ success: false, attempt: 1 }));
    expect(onAttempt).toHaveBeenNthCalledWith(2, expect.objectContaining({ success: true, attempt: 2 }));
  });

  it("throws after both model attempts fail", async () => {
    mockFetch
      .mockImplementationOnce(() => apiResponse([], { status: 503 }))
      .mockImplementationOnce(() => apiResponse([], { status: 503 }));

    await expect(classifyBatch([makeEmail()])).rejects.toBeInstanceOf(AggregateError);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the daily budget check fails", async () => {
    const budgetError = new Error("budget reached");
    budgetError.name = "DailyBudgetExceededError";
    const beforeAttempt = vi.fn(async () => { throw budgetError; });

    await expect(classifyBatch([makeEmail()], { beforeAttempt })).rejects.toMatchObject({
      name: "DailyBudgetExceededError",
    });
    expect(beforeAttempt).toHaveBeenCalledOnce();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not call either model when preflight accounting fails", async () => {
    const beforeAttempt = vi.fn(async () => { throw new Error("database unavailable"); });

    await expect(classifyBatch([makeEmail()], { beforeAttempt })).rejects.toMatchObject({
      name: "ModelPreflightError",
    });
    expect(beforeAttempt).toHaveBeenCalledOnce();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not spend on the backup when usage persistence fails", async () => {
    mockFetch.mockImplementationOnce(() => apiResponse([{ i: 0, t: "n", r: "Reply needed" }]));
    const onAttempt = vi.fn(async () => { throw new Error("database unavailable"); });

    await expect(classifyBatch([makeEmail()], { onAttempt })).rejects.toMatchObject({
      name: "ModelAccountingError",
    });
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("records token, cache, cost, and latency metadata", async () => {
    mockFetch.mockImplementationOnce(() => apiResponse(
      [{ i: 0, t: "c", r: "Needs review" }],
      {
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 80 },
          cost: 0.00042,
        },
      }
    ));
    const onAttempt = vi.fn(async () => {});

    await classifyBatch([makeEmail()], { onAttempt });

    expect(onAttempt).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      model: PRIMARY_MODEL,
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 80,
        cacheWriteTokens: 0,
        costUsd: 0.00042,
      },
    }));
  });

  it("rejects incomplete structured output and retries", async () => {
    mockFetch
      .mockImplementationOnce(() => apiResponse([{ i: 0, t: "a", r: null }]))
      .mockImplementationOnce(() => apiResponse([
        { i: 0, t: "a", r: null },
        { i: 1, t: "c", r: "Needs review" },
      ]));

    const result = await classifyBatch([
      makeEmail({ id: "email-1" }),
      makeEmail({ id: "email-2" }),
    ]);

    expect(result).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not call OpenRouter for an empty model batch", async () => {
    await expect(classifyBatch([])).resolves.toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
