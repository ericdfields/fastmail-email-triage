export interface EmailSummary {
  id: string;
  threadId: string;
  subject: string;
  from: { name: string | null; email: string }[];
  receivedAt: string; // ISO 8601
  preview: string; // ~256 char snippet from JMAP
  hasListUnsubscribe: boolean;
  listUnsubscribeUrls: string[] | null;
}

export type Tier = "auto-delete" | "auto-archive" | "confirm" | "attention";

export interface Classification {
  emailId: string;
  subject: string;
  from: string;
  receivedAt: string;
  tier: Tier;
  reason: string; // One-line explanation
  hasListUnsubscribe: boolean;
}

export interface JMAPSession {
  apiUrl: string;
  accountId: string;
}

export interface MailboxIds {
  inbox: string;
  archive: string;
  trash: string;
}

export interface ActionResult {
  emailId: string;
  tier: Tier;
  success: boolean;
  error?: string;
}
