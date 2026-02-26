import Anthropic from "@anthropic-ai/sdk";
import type { Classification, EmailSummary } from "./types.js";

const anthropic = new Anthropic(); // Uses ANTHROPIC_API_KEY env var

const SYSTEM_PROMPT = `You are an email triage assistant. You classify emails into exactly one of four tiers:

## Tiers

- **auto-delete**: Spam, phishing, scams, marketing emails, promotions, mass-mailing list messages with List-Unsubscribe headers that are clearly promotional.
- **auto-archive**: Newsletters, Substack posts, Patreon updates, automated notifications, receipts, shipping updates, order confirmations, CI/CD notifications, GitHub notifications, social media notifications, routine account alerts, community organization mass emails, service notifications. If it's automated and doesn't require a decision, it's auto-archive.
- **confirm**: Messages that need a quick human decision but aren't urgent — ambiguous messages from unknown senders who might be real people, messages that could be either personal or automated.
- **attention**: Messages from real people expecting a reply, financial obligations (bills, rent, payments due), new business orders requiring fulfillment, medical messages, tax documents, messages from known personal contacts.

## Rules

1. If \`hasListUnsubscribe\` is true → auto-archive or auto-delete. Never confirm or attention.
2. Newsletters, Substacks, Patreon content, Ghost publications → always auto-archive, never confirm
3. Phishing and scam patterns → auto-delete. Watch for: sender domain doesn't match claimed company, suspicious domains (.th, .br, .mx for English financial emails), fake wallet/crypto security alerts, "order activation" scams, urgency language from unrecognized senders
4. Repeated automated notifications from the same service (payment reminders, subscription alerts) → auto-archive
5. "Action required" in subject does NOT automatically mean attention — evaluate whether it's from an automated system or a real person
6. When in doubt between auto-archive and confirm → prefer auto-archive
7. When in doubt between confirm and attention → prefer confirm
8. Never classify messages from real individual people as auto-delete

## Personal Rules

- Stripe payment notifications, failed payment alerts → attention
- GitHub notifications → auto-archive
- LinkedIn (job alerts, messages, digests) → auto-archive
- Google account notifications → auto-archive
- Netflix, Render, DistroKid automated alerts → auto-archive
- Community organizations (JCC, synagogue, Audubon, nonprofits) mass emails → auto-archive
- Squarespace new order notifications (Brookfield Blooms) → attention
- Squarespace everything else → auto-archive
- Bank/credit card statements and payment due notices → attention
- Medical portal messages (MyChart, eClinicalMail) → attention
- Property management (AppFolio rent reminders) → attention
- Marketing emails from SaaS companies → auto-delete

## Response Format

Return a JSON array. Each element:
{
  "emailId": "...",
  "tier": "auto-delete" | "auto-archive" | "confirm" | "attention",
  "reason": "One sentence explanation"
}

Return ONLY the JSON array, no markdown fences, no explanation outside the array.`;

export interface CorrectionExample {
  sender: string;
  subject: string;
  hasListUnsubscribe: boolean;
  originalTier: string;
  correctedTier: string;
}

export async function classifyBatch(
  emails: EmailSummary[],
  model: string = "claude-sonnet-4-6",
  corrections: CorrectionExample[] = []
): Promise<Classification[]> {
  let systemPrompt = SYSTEM_PROMPT;

  if (corrections.length > 0) {
    const lines = corrections.map(
      (c) =>
        `- "${c.subject}" from ${c.sender}${c.hasListUnsubscribe ? " (has List-Unsubscribe)" : ""} was corrected from ${c.originalTier} → ${c.correctedTier}`
    );
    systemPrompt += `\n\n## Recent Corrections (learn from these)\n\nThe following classifications were manually corrected. Apply these patterns:\n${lines.join("\n")}`;
  }

  const userMessage = emails.map((e) => ({
    emailId: e.id,
    subject: e.subject,
    from: e.from
      .map((f) => (f.name ? `${f.name} <${f.email}>` : f.email))
      .join(", "),
    receivedAt: e.receivedAt,
    preview: e.preview.substring(0, 200),
    hasListUnsubscribe: e.hasListUnsubscribe,
  }));

  const response = await anthropic.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: `Classify these ${emails.length} emails:\n\n${JSON.stringify(userMessage, null, 2)}`,
      },
    ],
  });

  const firstBlock = response.content[0];
  const text = firstBlock?.type === "text" ? firstBlock.text : "";

  // Parse response — handle potential markdown fences
  const cleaned = text
    .replace(/```json?\n?/g, "")
    .replace(/```/g, "")
    .trim();
  const results = JSON.parse(cleaned);

  // Merge classification with original email data
  return results.map((r: any) => {
    const original = emails.find((e) => e.id === r.emailId);
    return {
      emailId: r.emailId,
      subject: original?.subject ?? "(unknown)",
      from: original?.from.map((f) => f.email).join(", ") ?? "(unknown)",
      receivedAt: original?.receivedAt ?? new Date().toISOString(),
      tier: r.tier,
      reason: r.reason,
      hasListUnsubscribe: original?.hasListUnsubscribe ?? false,
    };
  });
}
