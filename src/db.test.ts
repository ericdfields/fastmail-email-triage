import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());
const mockEnd = vi.hoisted(() => vi.fn());

vi.mock("pg", () => ({
  default: {
    Pool: vi.fn(function (this: Record<string, unknown>) {
      this.query = mockQuery;
      this.end = mockEnd;
    }),
  },
}));

import {
  initDb,
  closeDb,
  insertClassifications,
  findIncompleteRun,
  markActionsApplied,
  insertCorrection,
  ensureOptimizationTables,
  getPreviouslyClassifiedEmailIds,
  getSenderRules,
  getTodayModelSpend,
  recordModelCall,
  ensureAttentionActionsTable,
  getAttentionQueue,
  getAttentionQueueCount,
  recordAttentionAction,
} from "./db.js";
import type { Classification } from "./types.js";

function makeClassification(overrides: Partial<Classification> = {}): Classification {
  return {
    emailId: "email-1",
    subject: "Test subject",
    from: "sender@example.com",
    receivedAt: "2024-01-01T00:00:00Z",
    tier: "attention",
    reason: "Real person",
    hasListUnsubscribe: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DATABASE_URL = "postgresql://test:test@localhost/test";
  initDb();
});

// --- insertClassifications ---

describe("insertClassifications", () => {
  it("does nothing when given an empty array", async () => {
    await insertClassifications(1, []);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("inserts a single classification with correct placeholders", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await insertClassifications(1, [makeClassification()]);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("($1, $2, $3, $4, $5, $6, $7, $8)");
    expect(params).toHaveLength(8);
    expect(params[0]).toBe("email-1"); // emailId
    expect(params[1]).toBe(1);         // runId
  });

  it("inserts two classifications with sequential placeholders", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await insertClassifications(1, [
      makeClassification({ emailId: "email-1" }),
      makeClassification({ emailId: "email-2" }),
    ]);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("($1, $2, $3, $4, $5, $6, $7, $8)");
    expect(sql).toContain("($9, $10, $11, $12, $13, $14, $15, $16)");
    expect(params).toHaveLength(16);
    expect(params[0]).toBe("email-1");
    expect(params[8]).toBe("email-2");
  });

  it("uses ON CONFLICT DO NOTHING for idempotency", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await insertClassifications(1, [makeClassification()]);

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toContain("ON CONFLICT");
    expect(sql).toContain("DO NOTHING");
  });
});

// --- findIncompleteRun ---

describe("findIncompleteRun", () => {
  it("returns null when no incomplete run exists", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await findIncompleteRun();

    expect(result).toBeNull();
  });

  it("returns the run with classifications and alreadyActed set", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ run_id: 42 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            email_id: "e1",
            subject: "S1",
            sender: "s@s.com",
            received_at: "2024-01-01T00:00:00Z",
            tier: "attention",
            reason: "Real person",
            has_list_unsubscribe: false,
            acted_at: null,
          },
          {
            email_id: "e2",
            subject: "S2",
            sender: "s@s.com",
            received_at: "2024-01-01T00:00:00Z",
            tier: "auto-archive",
            reason: "Newsletter",
            has_list_unsubscribe: true,
            acted_at: "2024-01-01T01:00:00Z",
          },
        ],
      });

    const result = await findIncompleteRun();

    expect(result?.runId).toBe(42);
    expect(result?.classifications).toHaveLength(2);
    expect(result?.classifications[0]?.emailId).toBe("e1");
    expect(result?.alreadyActed.has("e2")).toBe(true);
    expect(result?.alreadyActed.has("e1")).toBe(false);
  });

  it("maps DB columns to Classification shape correctly", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ run_id: 1 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            email_id: "e1",
            subject: "Hello",
            sender: "alice@example.com",
            received_at: "2024-06-01T10:00:00Z",
            tier: "confirm",
            reason: "Ambiguous sender",
            has_list_unsubscribe: false,
            acted_at: null,
          },
        ],
      });

    const result = await findIncompleteRun();
    const classification = result?.classifications[0];

    expect(classification?.emailId).toBe("e1");
    expect(classification?.from).toBe("alice@example.com");
    expect(classification?.tier).toBe("confirm");
    expect(classification?.reason).toBe("Ambiguous sender");
  });
});

// --- markActionsApplied ---

describe("markActionsApplied", () => {
  it("does nothing when given an empty array", async () => {
    await markActionsApplied(1, []);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("generates correct placeholders for multiple email IDs", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await markActionsApplied(1, ["e1", "e2", "e3"]);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("$2, $3, $4");
    expect(params).toEqual([1, "e1", "e2", "e3"]);
  });

  it("uses run_id as $1 in all cases", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await markActionsApplied(99, ["e1"]);

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe(99);
  });
});

// --- insertCorrection ---

describe("insertCorrection", () => {
  it("returns null when the email has no classification", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await insertCorrection("nonexistent-id", "attention");

    expect(result).toBeNull();
  });

  it("inserts correction and returns original classification info", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ run_id: 5, tier: "auto-archive", subject: "Newsletter", sender: "news@example.com" }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await insertCorrection("email-1", "attention");

    expect(result).toEqual({
      originalTier: "auto-archive",
      runId: 5,
      subject: "Newsletter",
      from: "news@example.com",
    });
  });

  it("passes correct values to the correction INSERT", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ run_id: 7, tier: "confirm", subject: "S", sender: "s@s.com" }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await insertCorrection("email-abc", "attention");

    const [sql, params] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO corrections");
    expect(params).toEqual(["email-abc", 7, "confirm", "attention"]);
  });

  it("upserts an exact normalized sender rule", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ run_id: 7, tier: "confirm", subject: "S", sender: " Sender@Example.COM " }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await insertCorrection("email-abc", "auto-archive");

    const [sql, params] = mockQuery.mock.calls[2] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO sender_rules");
    expect(sql).toContain("ON CONFLICT");
    expect(params).toEqual(["sender@example.com", "auto-archive"]);
  });
});

// --- token-efficiency persistence ---

describe("ensureOptimizationTables", () => {
  it("creates sender rules, model calls, and migrates correction history", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await ensureOptimizationTables();

    const sql = mockQuery.mock.calls.map((call) => call[0]).join("\n");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS sender_rules");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS model_calls");
    expect(sql).toContain("INSERT INTO sender_rules");
  });
});

describe("getPreviouslyClassifiedEmailIds", () => {
  it("returns genuine classifications and excludes legacy fallback rows in SQL", async () => {
    mockQuery.mockResolvedValue({ rows: [{ email_id: "e1" }, { email_id: "e3" }] });

    const ids = await getPreviouslyClassifiedEmailIds(["e1", "e2", "e3"]);

    expect([...ids]).toEqual(["e1", "e3"]);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("reason <>");
    expect(params).toEqual([["e1", "e2", "e3"]]);
  });

  it("does not query for an empty batch", async () => {
    await expect(getPreviouslyClassifiedEmailIds([])).resolves.toEqual(new Set());
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("getSenderRules", () => {
  it("normalizes and deduplicates sender keys", async () => {
    mockQuery.mockResolvedValue({ rows: [{ sender: "sender@example.com", tier: "attention" }] });

    const rules = await getSenderRules([" Sender@Example.com ", "sender@example.com"]);

    expect(rules.get("sender@example.com")).toBe("attention");
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([["sender@example.com"]]);
  });
});

describe("model call accounting", () => {
  it("records one model attempt", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await recordModelCall(42, {
      model: "model-a",
      attempt: 1,
      success: true,
      batchSize: 10,
      latencyMs: 250,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 50,
        cacheWriteTokens: 0,
        costUsd: 0.0002,
      },
    });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO model_calls");
    expect(params).toEqual([42, "model-a", 1, "success", 10, 100, 20, 50, 0, 0.0002, 250, null]);
  });

  it("returns today's accumulated model spend", async () => {
    mockQuery.mockResolvedValue({ rows: [{ cost: "0.4321" }] });
    await expect(getTodayModelSpend()).resolves.toBe(0.4321);
  });
});

// --- closeDb ---

describe("closeDb", () => {
  it("calls pool.end()", async () => {
    mockEnd.mockResolvedValue(undefined);
    await closeDb();
    expect(mockEnd).toHaveBeenCalledOnce();
  });
});

// --- ensureAttentionActionsTable ---

describe("ensureAttentionActionsTable", () => {
  it("issues a CREATE TABLE IF NOT EXISTS for attention_actions", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await ensureAttentionActionsTable();

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS attention_actions");
  });

  it("includes a UNIQUE constraint on (email_id, run_id)", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await ensureAttentionActionsTable();

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toContain("UNIQUE (email_id, run_id)");
  });
});

// --- getAttentionQueue ---

describe("getAttentionQueue", () => {
  it("returns empty array when no rows match", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await getAttentionQueue(5);

    expect(result).toEqual([]);
  });

  it("passes limit as the query parameter", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await getAttentionQueue(10);

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([10]);
  });

  it("maps DB columns to AttentionQueueRow shape correctly", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          email_id: "e1",
          run_id: 42,
          subject: "Hello",
          sender: "alice@example.com",
          received_at: "2024-06-01T10:00:00Z",
          reason: "Real person",
        },
      ],
    });

    const result = await getAttentionQueue(5);

    expect(result[0]).toEqual({
      emailId: "e1",
      runId: 42,
      subject: "Hello",
      from: "alice@example.com",
      receivedAt: "2024-06-01T10:00:00Z",
      reason: "Real person",
    });
  });

  it("converts Date objects to ISO string for receivedAt", async () => {
    const date = new Date("2024-06-01T10:00:00.000Z");
    mockQuery.mockResolvedValue({
      rows: [
        {
          email_id: "e1",
          run_id: 1,
          subject: "S",
          sender: "s@s.com",
          received_at: date,
          reason: "R",
        },
      ],
    });

    const result = await getAttentionQueue(5);

    expect(typeof result[0]?.receivedAt).toBe("string");
    expect(result[0]?.receivedAt).toContain("2024-06-01");
  });

  it("queries using DISTINCT ON and LEFT JOIN attention_actions", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await getAttentionQueue(5);

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toContain("DISTINCT ON");
    expect(sql).toContain("attention_actions");
    expect(sql).toContain("LEFT JOIN");
  });
});

// --- getAttentionQueueCount ---

describe("getAttentionQueueCount", () => {
  it("returns 0 when no attention emails are pending", async () => {
    mockQuery.mockResolvedValue({ rows: [{ count: "0" }] });

    const result = await getAttentionQueueCount();

    expect(result).toBe(0);
  });

  it("parses count string to a number", async () => {
    mockQuery.mockResolvedValue({ rows: [{ count: "42" }] });

    const result = await getAttentionQueueCount();

    expect(result).toBe(42);
  });
});

// --- recordAttentionAction ---

describe("recordAttentionAction", () => {
  it("inserts an acted record with null note and snoozedUntil when not provided", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await recordAttentionAction("e1", 5, "acted");

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO attention_actions");
    expect(params).toEqual(["e1", 5, "acted", null, null]);
  });

  it("passes note as the fourth parameter when provided", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await recordAttentionAction("e1", 5, "acted", "Called them back");

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[3]).toBe("Called them back");
    expect(params[4]).toBeNull();
  });

  it("inserts a snoozed record with snoozedUntil date", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const until = new Date("2024-12-01T00:00:00.000Z");

    await recordAttentionAction("e1", 5, "snoozed", undefined, until);

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[2]).toBe("snoozed");
    expect(params[3]).toBeNull();
    expect(params[4]).toBe(until);
  });

  it("uses ON CONFLICT DO NOTHING for idempotency", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await recordAttentionAction("e1", 5, "acted");

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toContain("ON CONFLICT DO NOTHING");
  });
});
