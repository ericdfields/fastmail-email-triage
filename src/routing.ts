import type { Classification, EmailSummary, Tier } from "./types.js";

export function normalizeSender(sender: string): string {
  return sender.trim().toLowerCase();
}

export function senderKey(email: EmailSummary): string {
  return normalizeSender(email.from.map((from) => from.email).join(", "));
}

function localClassification(email: EmailSummary, tier: Tier, reason: string): Classification {
  return {
    emailId: email.id,
    subject: email.subject,
    from: email.from.map((from) => from.email).join(", "),
    receivedAt: email.receivedAt,
    tier,
    reason,
    hasListUnsubscribe: email.hasListUnsubscribe,
  };
}

export function routeDeterministically(
  emails: EmailSummary[],
  senderRules: Map<string, Tier>
): { deterministic: Classification[]; modelEmails: EmailSummary[] } {
  const deterministic: Classification[] = [];
  const modelEmails: EmailSummary[] = [];

  for (const email of emails) {
    const ruleTier = senderRules.get(senderKey(email));
    if (ruleTier) {
      deterministic.push(localClassification(email, ruleTier, "Exact sender rule"));
    } else if (email.hasListUnsubscribe) {
      deterministic.push(localClassification(email, "auto-archive", "List-Unsubscribe header"));
    } else {
      modelEmails.push(email);
    }
  }

  return { deterministic, modelEmails };
}
