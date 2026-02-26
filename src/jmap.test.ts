import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", mockFetch);

import { getSession, getMailboxIds, applyActions, fetchAllUnread, fetchEmailBodies, archiveEmail, applyTierAction } from "./jmap.js";
import type { Classification, JMAPSession, MailboxIds } from "./types.js";

const session: JMAPSession = {
  apiUrl: "https://api.fastmail.com/jmap/api/",
  accountId: "account-123",
};

const mailboxIds: MailboxIds = {
  inbox: "inbox-1",
  archive: "archive-1",
  trash: "trash-1",
};

function makeClassification(overrides: Partial<Classification> = {}): Classification {
  return {
    emailId: "email-1",
    subject: "Test",
    from: "sender@example.com",
    receivedAt: "2024-01-01T00:00:00Z",
    tier: "attention",
    reason: "Real person",
    hasListUnsubscribe: false,
    ...overrides,
  };
}

function makeJmapResponse(methodResponses: unknown[][]) {
  return {
    ok: true,
    json: () => Promise.resolve({ methodResponses }),
  };
}

function makeMailboxResponse() {
  return makeJmapResponse([
    ["Mailbox/query", { ids: ["inbox-1"] }, "inbox"],
    ["Mailbox/query", { ids: ["archive-1"] }, "archive"],
    ["Mailbox/query", { ids: ["trash-1"] }, "trash"],
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// --- getSession ---

describe("getSession", () => {
  it("returns session from a successful response", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          apiUrl: "https://api.fastmail.com/jmap/api/",
          primaryAccounts: { "urn:ietf:params:jmap:mail": "account-123" },
        }),
    });

    const result = await getSession();

    expect(result).toEqual({
      apiUrl: "https://api.fastmail.com/jmap/api/",
      accountId: "account-123",
    });
  });

  it("throws on a non-ok HTTP response", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized" });

    await expect(getSession()).rejects.toThrow("Session error: 401 Unauthorized");
  });
});

// --- jmapRequest retry (tested via getMailboxIds) ---

describe("JMAP retry logic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeEtimedout() {
    return Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } });
  }

  it("retries on ETIMEDOUT and succeeds on the next attempt", async () => {
    mockFetch.mockRejectedValueOnce(makeEtimedout()).mockResolvedValue(makeMailboxResponse());

    const promise = getMailboxIds(session);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.inbox).toBe("inbox-1");
  });

  it("retries twice and succeeds on the third attempt", async () => {
    mockFetch
      .mockRejectedValueOnce(makeEtimedout())
      .mockRejectedValueOnce(makeEtimedout())
      .mockResolvedValue(makeMailboxResponse());

    const promise = getMailboxIds(session);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result.inbox).toBe("inbox-1");
  });

  it("throws after exhausting all 3 attempts", async () => {
    mockFetch.mockRejectedValue(makeEtimedout());

    const promise = getMailboxIds(session);
    const assertion = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry on non-network errors", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: "Internal Server Error" });

    const promise = getMailboxIds(session);
    const assertion = expect(promise).rejects.toThrow("JMAP error: 500");
    await vi.runAllTimersAsync();
    await assertion;

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// --- getMailboxIds ---

describe("getMailboxIds", () => {
  it("returns mailbox IDs from response", async () => {
    mockFetch.mockResolvedValue(makeMailboxResponse());

    const result = await getMailboxIds(session);

    expect(result).toEqual({ inbox: "inbox-1", archive: "archive-1", trash: "trash-1" });
  });

  it("throws when a mailbox has no IDs", async () => {
    mockFetch.mockResolvedValue(
      makeJmapResponse([
        ["Mailbox/query", { ids: [] }, "inbox"],
        ["Mailbox/query", { ids: ["archive-1"] }, "archive"],
        ["Mailbox/query", { ids: ["trash-1"] }, "trash"],
      ])
    );

    await expect(getMailboxIds(session)).rejects.toThrow("Could not find inbox mailbox");
  });
});

// --- applyActions ---

describe("applyActions", () => {
  function makeSetResponse(
    updated: Record<string, unknown> = {},
    notUpdated: Record<string, unknown> = {}
  ) {
    return makeJmapResponse([["Email/set", { updated, notUpdated }, "actions0"]]);
  }

  it("sends correct update for auto-delete tier", async () => {
    mockFetch.mockResolvedValue(makeSetResponse({ "email-1": {} }));

    await applyActions(session, mailboxIds, [makeClassification({ tier: "auto-delete" })]);

    const body = JSON.parse((mockFetch.mock.calls[0] as any[])[1].body);
    const update = body.methodCalls[0][1].update;
    expect(update["email-1"]).toMatchObject({
      "mailboxIds/inbox-1": null,
      "mailboxIds/trash-1": true,
    });
    expect(update["email-1"]["mailboxIds/archive-1"]).toBeUndefined();
  });

  it("sends correct update for auto-archive tier", async () => {
    mockFetch.mockResolvedValue(makeSetResponse({ "email-1": {} }));

    await applyActions(session, mailboxIds, [makeClassification({ tier: "auto-archive" })]);

    const body = JSON.parse((mockFetch.mock.calls[0] as any[])[1].body);
    const update = body.methodCalls[0][1].update;
    expect(update["email-1"]).toMatchObject({
      "mailboxIds/inbox-1": null,
      "mailboxIds/archive-1": true,
      "keywords/$seen": true,
    });
  });

  it("sends correct update for confirm tier (mark read, stay in inbox)", async () => {
    mockFetch.mockResolvedValue(makeSetResponse({ "email-1": {} }));

    await applyActions(session, mailboxIds, [makeClassification({ tier: "confirm" })]);

    const body = JSON.parse((mockFetch.mock.calls[0] as any[])[1].body);
    const update = body.methodCalls[0][1].update;
    expect(update["email-1"]).toEqual({ "keywords/$seen": true });
  });

  it("omits attention emails from the update map", async () => {
    mockFetch.mockResolvedValue(makeSetResponse({ "email-2": {} }));

    await applyActions(session, mailboxIds, [
      makeClassification({ emailId: "email-1", tier: "attention" }),
      makeClassification({ emailId: "email-2", tier: "confirm" }),
    ]);

    const body = JSON.parse((mockFetch.mock.calls[0] as any[])[1].body);
    const update = body.methodCalls[0][1].update;
    expect(update["email-1"]).toBeUndefined();
    expect(update["email-2"]).toBeDefined();
  });

  it("skips the API call when all emails are attention tier", async () => {
    const results = await applyActions(session, mailboxIds, [
      makeClassification({ tier: "attention" }),
    ]);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ emailId: "email-1", tier: "attention", success: true });
  });

  it("reports success for attention emails regardless of API result", async () => {
    mockFetch.mockResolvedValue(makeSetResponse({ "email-2": {} }));

    const results = await applyActions(session, mailboxIds, [
      makeClassification({ emailId: "email-1", tier: "attention" }),
      makeClassification({ emailId: "email-2", tier: "confirm" }),
    ]);

    expect(results.find((r) => r.emailId === "email-1")?.success).toBe(true);
  });

  it("reports failure for emails in notUpdated", async () => {
    mockFetch.mockResolvedValue(
      makeSetResponse(
        {},
        { "email-1": { type: "notFound", description: "Email does not exist" } }
      )
    );

    const results = await applyActions(session, mailboxIds, [
      makeClassification({ tier: "auto-delete" }),
    ]);

    expect(results[0]).toMatchObject({
      emailId: "email-1",
      success: false,
      error: expect.stringContaining("notFound"),
    });
  });
});

// --- fetchAllUnread ---

describe("fetchAllUnread", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  function makeEmailBatch(emails: { id: string; hasUnsub: boolean }[]) {
    return makeJmapResponse([
      ["Email/query", { total: emails.length, ids: emails.map((e) => e.id) }, "query0"],
      [
        "Email/get",
        {
          list: emails.map((e) => ({
            id: e.id,
            threadId: `thread-${e.id}`,
            subject: `Subject ${e.id}`,
            from: [{ name: "Sender", email: "sender@example.com" }],
            receivedAt: "2024-01-01T00:00:00Z",
            preview: "Preview text",
            "header:List-Unsubscribe:asURLs": e.hasUnsub ? ["https://unsub.example.com"] : null,
          })),
        },
        "get0",
      ],
    ]);
  }

  it("yields a single batch and stops", async () => {
    mockFetch.mockResolvedValue(makeEmailBatch([{ id: "e1", hasUnsub: false }]));

    const batches: Awaited<ReturnType<typeof fetchAllUnread>>[] = [];
    for await (const batch of fetchAllUnread(session, "inbox-1")) {
      batches.push(batch);
    }

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0]![0]!.id).toBe("e1");
  });

  it("sets hasListUnsubscribe correctly based on header presence", async () => {
    mockFetch.mockResolvedValue(
      makeEmailBatch([
        { id: "e1", hasUnsub: false },
        { id: "e2", hasUnsub: true },
      ])
    );

    const batches: Awaited<ReturnType<typeof fetchAllUnread>>[] = [];
    for await (const batch of fetchAllUnread(session, "inbox-1")) {
      batches.push(batch);
    }

    expect(batches[0]![0]!.hasListUnsubscribe).toBe(false);
    expect(batches[0]![1]!.hasListUnsubscribe).toBe(true);
    expect(batches[0]![1]!.listUnsubscribeUrls).toEqual(["https://unsub.example.com"]);
  });

  it("yields multiple batches for large mailboxes", async () => {
    // Simulate 51 total emails: first batch returns 50, second returns 1
    const firstBatch = Array.from({ length: 50 }, (_, i) => ({ id: `e${i}`, hasUnsub: false }));
    const secondBatch = [{ id: "e50", hasUnsub: false }];

    // First response includes total=51 (triggers second fetch)
    mockFetch
      .mockResolvedValueOnce(
        makeJmapResponse([
          ["Email/query", { total: 51, ids: firstBatch.map((e) => e.id) }, "query0"],
          [
            "Email/get",
            {
              list: firstBatch.map((e) => ({
                id: e.id,
                threadId: `t-${e.id}`,
                subject: `S`,
                from: [],
                receivedAt: "2024-01-01T00:00:00Z",
                preview: "",
                "header:List-Unsubscribe:asURLs": null,
              })),
            },
            "get0",
          ],
        ])
      )
      .mockResolvedValueOnce(makeEmailBatch(secondBatch));

    const batches: Awaited<ReturnType<typeof fetchAllUnread>>[] = [];
    for await (const batch of fetchAllUnread(session, "inbox-1")) {
      batches.push(batch);
    }

    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(50);
    expect(batches[1]).toHaveLength(1);
  });
});

// --- fetchEmailBodies ---

describe("fetchEmailBodies", () => {
  it("returns an empty Map and skips the network call when emailIds is empty", async () => {
    const result = await fetchEmailBodies(session, []);

    expect(result.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("requests the correct properties for the given email IDs", async () => {
    mockFetch.mockResolvedValue(
      makeJmapResponse([["Email/get", { list: [] }, "bodies0"]])
    );

    await fetchEmailBodies(session, ["e1", "e2"]);

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, { body: string }])[1].body);
    const mc = body.methodCalls[0][1];
    expect(mc.ids).toEqual(["e1", "e2"]);
    expect(mc.properties).toContain("textBody");
    expect(mc.properties).toContain("bodyValues");
    expect(mc.fetchTextBodyValues).toBe(true);
    expect(mc.maxBodyValueBytes).toBe(2048);
  });

  it("extracts text from the textBody part", async () => {
    mockFetch.mockResolvedValue(
      makeJmapResponse([
        [
          "Email/get",
          {
            list: [
              {
                id: "e1",
                textBody: [{ partId: "1" }],
                htmlBody: [],
                bodyValues: { "1": { value: "Hello from text body" } },
              },
            ],
          },
          "bodies0",
        ],
      ])
    );

    const result = await fetchEmailBodies(session, ["e1"]);

    expect(result.get("e1")).toBe("Hello from text body");
  });

  it("falls back to htmlBody with tag stripping when textBody is absent", async () => {
    mockFetch.mockResolvedValue(
      makeJmapResponse([
        [
          "Email/get",
          {
            list: [
              {
                id: "e1",
                textBody: [],
                htmlBody: [{ partId: "1" }],
                bodyValues: { "1": { value: "<p>Hello <b>world</b></p>" } },
              },
            ],
          },
          "bodies0",
        ],
      ])
    );

    const result = await fetchEmailBodies(session, ["e1"]);

    expect(result.get("e1")).toBe("Hello world");
  });

  it("prefers textBody over htmlBody when both are present", async () => {
    mockFetch.mockResolvedValue(
      makeJmapResponse([
        [
          "Email/get",
          {
            list: [
              {
                id: "e1",
                textBody: [{ partId: "txt" }],
                htmlBody: [{ partId: "html" }],
                bodyValues: {
                  txt: { value: "Plain text version" },
                  html: { value: "<p>HTML version</p>" },
                },
              },
            ],
          },
          "bodies0",
        ],
      ])
    );

    const result = await fetchEmailBodies(session, ["e1"]);

    expect(result.get("e1")).toBe("Plain text version");
  });

  it("trims body text to 500 characters with ellipsis", async () => {
    const longText = "a".repeat(600);
    mockFetch.mockResolvedValue(
      makeJmapResponse([
        [
          "Email/get",
          {
            list: [
              {
                id: "e1",
                textBody: [{ partId: "1" }],
                htmlBody: [],
                bodyValues: { "1": { value: longText } },
              },
            ],
          },
          "bodies0",
        ],
      ])
    );

    const result = await fetchEmailBodies(session, ["e1"]);

    expect(result.get("e1")).toHaveLength(500);
    expect(result.get("e1")?.endsWith("...")).toBe(true);
  });

  it("returns empty string for emails with no body parts", async () => {
    mockFetch.mockResolvedValue(
      makeJmapResponse([
        [
          "Email/get",
          {
            list: [
              {
                id: "e1",
                textBody: [],
                htmlBody: [],
                bodyValues: {},
              },
            ],
          },
          "bodies0",
        ],
      ])
    );

    const result = await fetchEmailBodies(session, ["e1"]);

    expect(result.get("e1")).toBe("");
  });
});

// --- archiveEmail ---

describe("archiveEmail", () => {
  it("sends Email/set to remove from inbox, add to archive, and mark read", async () => {
    mockFetch.mockResolvedValue(
      makeJmapResponse([
        ["Email/set", { updated: { "email-1": {} }, notUpdated: {} }, "archive0"],
      ])
    );

    await archiveEmail(session, mailboxIds, "email-1");

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, { body: string }])[1].body);
    const update = body.methodCalls[0][1].update;
    expect(update["email-1"]).toEqual({
      "mailboxIds/inbox-1": null,
      "mailboxIds/archive-1": true,
      "keywords/$seen": true,
    });
  });

  it("includes both JMAP core and mail capabilities", async () => {
    mockFetch.mockResolvedValue(
      makeJmapResponse([
        ["Email/set", { updated: { "email-1": {} }, notUpdated: {} }, "archive0"],
      ])
    );

    await archiveEmail(session, mailboxIds, "email-1");

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, { body: string }])[1].body);
    expect(body.using).toContain("urn:ietf:params:jmap:core");
    expect(body.using).toContain("urn:ietf:params:jmap:mail");
  });

  it("only updates the specified email ID", async () => {
    mockFetch.mockResolvedValue(
      makeJmapResponse([
        ["Email/set", { updated: { "email-xyz": {} }, notUpdated: {} }, "archive0"],
      ])
    );

    await archiveEmail(session, mailboxIds, "email-xyz");

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, { body: string }])[1].body);
    const update = body.methodCalls[0][1].update;
    expect(Object.keys(update)).toEqual(["email-xyz"]);
  });
});

// --- applyTierAction ---

describe("applyTierAction", () => {
  it("sends correct Email/set for auto-delete", async () => {
    mockFetch.mockResolvedValue(
      makeJmapResponse([["Email/set", { updated: { "email-1": {} }, notUpdated: {} }, "tier0"]])
    );

    await applyTierAction(session, mailboxIds, "email-1", "auto-delete");

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, { body: string }])[1].body);
    expect(body.methodCalls[0][1].update["email-1"]).toEqual({
      "mailboxIds/inbox-1": null,
      "mailboxIds/trash-1": true,
    });
  });

  it("sends correct Email/set for auto-archive", async () => {
    mockFetch.mockResolvedValue(
      makeJmapResponse([["Email/set", { updated: { "email-1": {} }, notUpdated: {} }, "tier0"]])
    );

    await applyTierAction(session, mailboxIds, "email-1", "auto-archive");

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, { body: string }])[1].body);
    expect(body.methodCalls[0][1].update["email-1"]).toEqual({
      "mailboxIds/inbox-1": null,
      "mailboxIds/archive-1": true,
      "keywords/$seen": true,
    });
  });

  it("sends correct Email/set for confirm", async () => {
    mockFetch.mockResolvedValue(
      makeJmapResponse([["Email/set", { updated: { "email-1": {} }, notUpdated: {} }, "tier0"]])
    );

    await applyTierAction(session, mailboxIds, "email-1", "confirm");

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, { body: string }])[1].body);
    expect(body.methodCalls[0][1].update["email-1"]).toEqual({
      "keywords/$seen": true,
    });
  });

  it("uses the correct JMAP method call ID 'tier0'", async () => {
    mockFetch.mockResolvedValue(
      makeJmapResponse([["Email/set", { updated: { "email-1": {} }, notUpdated: {} }, "tier0"]])
    );

    await applyTierAction(session, mailboxIds, "email-1", "confirm");

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, { body: string }])[1].body);
    expect(body.methodCalls[0][2]).toBe("tier0");
  });
});
