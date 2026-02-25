import type { ActionResult, Classification, EmailSummary, JMAPSession, MailboxIds } from "./types.js";

const BATCH_SIZE = 50;

export async function getSession(): Promise<JMAPSession> {
  const response = await fetch("https://api.fastmail.com/jmap/session", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${process.env.FASTMAIL_API_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Session error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return {
    apiUrl: data.apiUrl,
    accountId: data.primaryAccounts["urn:ietf:params:jmap:mail"],
  };
}

const MAX_RETRIES = 3;

async function jmapRequest(session: JMAPSession, body: object): Promise<any> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(session.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.FASTMAIL_API_TOKEN}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`JMAP error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      // Check for method-level errors
      for (const [name, result, id] of data.methodResponses) {
        if (name === "error") {
          throw new Error(
            `JMAP method error (${id}): ${(result as any).type} - ${(result as any).description}`
          );
        }
      }

      return data;
    } catch (err) {
      const isNetworkError = err instanceof TypeError && (err as any).cause?.code === "ETIMEDOUT";
      if (!isNetworkError || attempt === MAX_RETRIES) throw err;
      const delay = attempt * 2000;
      console.warn(`  JMAP request timed out, retrying in ${delay / 1000}s (attempt ${attempt}/${MAX_RETRIES})...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export async function getMailboxIds(session: JMAPSession): Promise<MailboxIds> {
  const data = await jmapRequest(session, {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [
      [
        "Mailbox/query",
        { accountId: session.accountId, filter: { role: "inbox" } },
        "inbox",
      ],
      [
        "Mailbox/query",
        { accountId: session.accountId, filter: { role: "archive" } },
        "archive",
      ],
      [
        "Mailbox/query",
        { accountId: session.accountId, filter: { role: "trash" } },
        "trash",
      ],
    ],
  });

  const get = (idx: number, label: string): string => {
    const ids = data.methodResponses[idx][1].ids;
    if (!ids || ids.length === 0) throw new Error(`Could not find ${label} mailbox`);
    return ids[0];
  };

  return {
    inbox: get(0, "inbox"),
    archive: get(1, "archive"),
    trash: get(2, "trash"),
  };
}

function buildBatchRequest(
  accountId: string,
  inboxId: string,
  position: number
) {
  return {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [
      [
        "Email/query",
        {
          accountId,
          filter: {
            inMailbox: inboxId,
            notKeyword: "$seen",
          },
          sort: [{ property: "receivedAt", isAscending: false }],
          position,
          limit: BATCH_SIZE,
          calculateTotal: position === 0,
        },
        "query0",
      ],
      [
        "Email/get",
        {
          accountId,
          properties: [
            "id",
            "threadId",
            "subject",
            "from",
            "receivedAt",
            "preview",
            "header:List-Unsubscribe:asURLs",
          ],
          "#ids": {
            resultOf: "query0",
            name: "Email/query",
            path: "/ids",
          },
        },
        "get0",
      ],
    ],
  };
}

export async function* fetchAllUnread(
  session: JMAPSession,
  inboxId: string
): AsyncGenerator<EmailSummary[]> {
  let position = 0;
  let total: number | null = null;

  while (true) {
    const request = buildBatchRequest(session.accountId, inboxId, position);
    const response = await jmapRequest(session, request);

    const queryResult = response.methodResponses[0][1];
    const getResult = response.methodResponses[1][1];

    if (total === null) {
      total = queryResult.total;
      console.log(`Total unread messages: ${total}`);
    }

    const emails: EmailSummary[] = getResult.list.map((email: any) => ({
      id: email.id,
      threadId: email.threadId,
      subject: email.subject || "(no subject)",
      from: email.from || [],
      receivedAt: email.receivedAt || new Date().toISOString(),
      preview: email.preview || "",
      hasListUnsubscribe:
        email["header:List-Unsubscribe:asURLs"] !== null,
      listUnsubscribeUrls: email["header:List-Unsubscribe:asURLs"],
    }));

    yield emails;

    position += BATCH_SIZE;
    if (position >= (total ?? 0) || emails.length < BATCH_SIZE) {
      break;
    }
  }
}

export async function applyActions(
  session: JMAPSession,
  mailboxIds: MailboxIds,
  classifications: Classification[]
): Promise<ActionResult[]> {
  // Build Email/set update map from tier→action mapping
  const update: Record<string, object> = {};

  for (const c of classifications) {
    switch (c.tier) {
      case "auto-delete":
        // Move to Trash (remove from Inbox)
        update[c.emailId] = {
          [`mailboxIds/${mailboxIds.inbox}`]: null,
          [`mailboxIds/${mailboxIds.trash}`]: true,
        };
        break;
      case "auto-archive":
        // Move to Archive + mark as read
        update[c.emailId] = {
          [`mailboxIds/${mailboxIds.inbox}`]: null,
          [`mailboxIds/${mailboxIds.archive}`]: true,
          "keywords/$seen": true,
        };
        break;
      case "confirm":
        // Mark as read (keep in Inbox)
        update[c.emailId] = {
          "keywords/$seen": true,
        };
        break;
      case "attention":
        // No action — skip entirely
        break;
    }
  }

  if (Object.keys(update).length === 0) {
    return classifications.map((c) => ({ emailId: c.emailId, tier: c.tier, success: true }));
  }

  const data = await jmapRequest(session, {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [
      [
        "Email/set",
        {
          accountId: session.accountId,
          update,
        },
        "actions0",
      ],
    ],
  });

  const setResult = data.methodResponses[0][1];
  const updated: Record<string, unknown> = setResult.updated ?? {};
  const notUpdated: Record<string, { type: string; description?: string }> = setResult.notUpdated ?? {};

  return classifications.map((c) => {
    if (c.tier === "attention") {
      return { emailId: c.emailId, tier: c.tier, success: true };
    }
    const failure = notUpdated[c.emailId];
    if (failure) {
      return {
        emailId: c.emailId,
        tier: c.tier,
        success: false,
        error: `${failure.type}: ${failure.description ?? ""}`,
      };
    }
    return { emailId: c.emailId, tier: c.tier, success: true };
  });
}

/** Fetch plain-text body for a batch of email IDs. */
export async function fetchEmailBodies(
  session: JMAPSession,
  emailIds: string[]
): Promise<Map<string, string>> {
  if (emailIds.length === 0) return new Map();

  const data = await jmapRequest(session, {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [
      [
        "Email/get",
        {
          accountId: session.accountId,
          ids: emailIds,
          properties: ["id", "textBody", "htmlBody", "bodyValues"],
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
          maxBodyValueBytes: 2048,
        },
        "bodies0",
      ],
    ],
  });

  const result = new Map<string, string>();
  const emails: any[] = data.methodResponses[0][1].list ?? [];

  for (const email of emails) {
    const bodyValues: Record<string, { value: string }> = email.bodyValues ?? {};

    // Prefer text/plain part
    let text = "";
    if (email.textBody && email.textBody.length > 0) {
      const partId = email.textBody[0].partId;
      text = bodyValues[partId]?.value ?? "";
    } else if (email.htmlBody && email.htmlBody.length > 0) {
      const partId = email.htmlBody[0].partId;
      const html = bodyValues[partId]?.value ?? "";
      // Strip HTML tags
      text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }

    // Trim to 500 chars
    result.set(email.id, text.length > 500 ? text.substring(0, 497) + "..." : text);
  }

  return result;
}

/** Move a single email to archive and mark as read. */
export async function archiveEmail(
  session: JMAPSession,
  mailboxIds: MailboxIds,
  emailId: string
): Promise<void> {
  await jmapRequest(session, {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [
      [
        "Email/set",
        {
          accountId: session.accountId,
          update: {
            [emailId]: {
              [`mailboxIds/${mailboxIds.inbox}`]: null,
              [`mailboxIds/${mailboxIds.archive}`]: true,
              "keywords/$seen": true,
            },
          },
        },
        "archive0",
      ],
    ],
  });
}
