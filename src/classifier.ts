import Anthropic from "@anthropic-ai/sdk";
import type { Classification, EmailSummary } from "./types.js";

const anthropic = new Anthropic(); // Uses ANTHROPIC_API_KEY env var

const SYSTEM_PROMPT = `You are an email triage assistant. You classify emails into exactly one of four tiers:

## Tiers

- **auto-delete**: Marketing emails, promotions, spam, newsletters the user doesn't read, mass-mailing list messages with List-Unsubscribe headers that are clearly promotional.
- **auto-archive**: Automated notifications that may be useful to reference later but don't need attention — shipping updates, order confirmations, receipts, CI/CD notifications, GitHub notifications, calendar invites already processed, social media notifications, routine account alerts.
- **confirm**: Semi-important messages that need a quick human decision — could be real communication but might also be noise. Newsletters the user might actually read, ambiguous notifications, messages from unknown senders who might be real people, account security alerts.
- **attention**: Messages that clearly need human attention — personal emails, messages from real people expecting a reply, financial alerts (bank, Stripe, payments), client/customer messages, anything time-sensitive or high-stakes.

## Rules

1. If \`hasListUnsubscribe\` is true AND the sender looks like a business/marketing entity → lean toward auto-delete or auto-archive
2. Subject line patterns like "Your order", "Shipping confirmation", "Receipt" → auto-archive
3. Subject line patterns like "Action required", "Invitation to", or personal-sounding subjects → attention or confirm
4. When in doubt between tiers, choose the MORE cautious tier (attention > confirm > auto-archive > auto-delete)
5. Never classify messages from real individual people as auto-delete

## Personal Rules (customize these)

- Anything from Stripe, payment processors → attention
- GitHub notifications → auto-archive
- Social media (Twitter, LinkedIn, Facebook, Instagram notifications) → auto-archive
- Marketing emails from SaaS companies → auto-delete

## Response Format

Return a JSON array. Each element:
{
  "emailId": "...",
  "tier": "auto-delete" | "auto-archive" | "confirm" | "attention",
  "reason": "One sentence explanation"
}

Return ONLY the JSON array, no markdown fences, no explanation outside the array.`;

export async function classifyBatch(
  emails: EmailSummary[],
  model: string = "claude-sonnet-4-6"
): Promise<Classification[]> {
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
    system: SYSTEM_PROMPT,
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
      receivedAt: original?.receivedAt ?? "",
      tier: r.tier,
      reason: r.reason,
      hasListUnsubscribe: original?.hasListUnsubscribe ?? false,
    };
  });
}
