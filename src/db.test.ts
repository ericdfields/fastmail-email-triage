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
      .mockResolvedValueOnce({ rows: [] });

    await insertCorrection("email-abc", "attention");

    const [sql, params] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO corrections");
    expect(params).toEqual(["email-abc", 7, "confirm", "attention"]);
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
