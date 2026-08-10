import type { Classification, EmailSummary, Tier } from "./types.js";

export const PRIMARY_MODEL = "openai/gpt-5.6-luna";
export const BACKUP_MODEL = "anthropic/claude-haiku-4.5";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const SYSTEM_PROMPT = `Classify personal email into one tier.

Tiers:
- d (auto-delete): spam, phishing, scams, or clearly promotional marketing.
- a (auto-archive): newsletters, receipts, shipping/order updates, automated notifications, social/GitHub alerts, and other mail requiring no decision.
- c (confirm): ambiguous mail needing a quick human decision.
- n (attention): a real person expects a reply, or the message concerns a bill/payment, order fulfillment, medical care, taxes, or another obligation.

Rules:
- Never delete mail from a real individual person.
- Automated "action required" language alone does not make a message attention.
- Prefer auto-archive over confirm when an automated message requires no response.
- Prefer confirm over attention when genuinely uncertain.
- Stripe failed-payment alerts, bank payment-due notices, medical portal mail, rent reminders, and Squarespace new orders need attention.
- GitHub, LinkedIn, Google account, Netflix, Render, DistroKid, community-organization, and routine Squarespace notifications auto-archive.

Return one result for every input index. For d/a, set r to null. For c/n, give a useful reason of at most 80 characters.`;

const TIER_CODES: Record<string, Tier> = {
  d: "auto-delete",
  a: "auto-archive",
  c: "confirm",
  n: "attention",
};

const MODEL_RATES: Record<string, { input: number; output: number; cachedInput: number }> = {
  [PRIMARY_MODEL]: { input: 0.1, output: 0.6, cachedInput: 0.01 },
  [BACKUP_MODEL]: { input: 1, output: 5, cachedInput: 0.1 },
};

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface ModelAttempt {
  model: string;
  attempt: number;
  success: boolean;
  batchSize: number;
  latencyMs: number;
  usage: ModelUsage;
  errorType?: string;
}

export interface ClassificationHooks {
  beforeAttempt?: (model: string, attempt: number) => Promise<void>;
  onAttempt?: (attempt: ModelAttempt) => Promise<void>;
}

type OpenRouterUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cost?: number | string;
  prompt_tokens_details?: { cached_tokens?: number };
};

function emptyUsage(): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
}

function parseUsage(model: string, raw: OpenRouterUsage | undefined): ModelUsage {
  const inputTokens = raw?.prompt_tokens ?? 0;
  const outputTokens = raw?.completion_tokens ?? 0;
  const cacheReadTokens = raw?.prompt_tokens_details?.cached_tokens ?? raw?.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = raw?.cache_creation_input_tokens ?? 0;
  const reportedCost = Number(raw?.cost);

  if (Number.isFinite(reportedCost) && reportedCost >= 0) {
    return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd: reportedCost };
  }

  const rates = MODEL_RATES[model];
  const uncachedInput = Math.max(0, inputTokens - cacheReadTokens);
  const estimatedCost = rates
    ? (uncachedInput * rates.input + cacheReadTokens * rates.cachedInput + outputTokens * rates.output) / 1_000_000
    : 0;

  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd: estimatedCost };
}

function errorType(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  return "UnknownError";
}

function localReason(tier: Tier, generatedReason: unknown): string {
  if (tier === "auto-delete") return "Promotional or unsafe automated mail";
  if (tier === "auto-archive") return "Automated mail requiring no response";

  if (typeof generatedReason !== "string" || generatedReason.trim().length === 0) {
    throw new Error(`Missing reason for ${tier} classification`);
  }
  return generatedReason.trim().slice(0, 80);
}

function parseClassifications(content: string, emails: EmailSummary[]): Classification[] {
  const parsed = JSON.parse(content) as { classifications?: unknown };
  if (!Array.isArray(parsed.classifications) || parsed.classifications.length !== emails.length) {
    throw new Error(`Expected ${emails.length} classifications`);
  }

  const seen = new Set<number>();
  const results: Classification[] = [];

  for (const item of parsed.classifications) {
    if (typeof item !== "object" || item === null) throw new Error("Invalid classification item");
    const candidate = item as { i?: unknown; t?: unknown; r?: unknown };
    if (!Number.isInteger(candidate.i) || typeof candidate.i !== "number") {
      throw new Error("Classification index is missing or invalid");
    }
    if (candidate.i < 0 || candidate.i >= emails.length || seen.has(candidate.i)) {
      throw new Error(`Classification index ${candidate.i} is out of range or duplicated`);
    }

    const tier = typeof candidate.t === "string" ? TIER_CODES[candidate.t] : undefined;
    if (!tier) throw new Error(`Invalid tier code for index ${candidate.i}`);

    const email = emails[candidate.i];
    if (!email) throw new Error(`Email missing for index ${candidate.i}`);
    seen.add(candidate.i);
    results.push({
      emailId: email.id,
      subject: email.subject,
      from: email.from.map((from) => from.email).join(", "),
      receivedAt: email.receivedAt,
      tier,
      reason: localReason(tier, candidate.r),
      hasListUnsubscribe: email.hasListUnsubscribe,
    });
  }

  return results.sort((left, right) => {
    const leftIndex = emails.findIndex((email) => email.id === left.emailId);
    const rightIndex = emails.findIndex((email) => email.id === right.emailId);
    return leftIndex - rightIndex;
  });
}

async function classifyWithModel(
  emails: EmailSummary[],
  model: string,
  attemptNumber: number,
  hooks: ClassificationHooks
): Promise<Classification[]> {
  try {
    await hooks.beforeAttempt?.(model, attemptNumber);
  } catch (error) {
    if (error instanceof Error && error.name === "DailyBudgetExceededError") throw error;
    const preflightError = new Error("Model-call preflight failed", { cause: error });
    preflightError.name = "ModelPreflightError";
    throw preflightError;
  }

  const startedAt = Date.now();
  let usage = emptyUsage();
  let classifications: Classification[] | undefined;
  let caughtError: unknown;

  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

    const emailPayload = emails.map((email, index) => ({
      i: index,
      s: email.subject,
      f: email.from.map((from) => from.name ? `${from.name} <${from.email}>` : from.email).join(", "),
      p: email.preview.replace(/\s+/g, " ").trim().slice(0, 160),
    }));

    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Fastmail Email Triage",
      },
      body: JSON.stringify({
        model,
        reasoning: { enabled: false },
        max_tokens: Math.max(256, Math.min(2500, emails.length * 45)),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(emailPayload) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "email_classifications",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                classifications: {
                  type: "array",
                  minItems: emails.length,
                  maxItems: emails.length,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      i: { type: "integer", minimum: 0, maximum: Math.max(0, emails.length - 1) },
                      t: { type: "string", enum: ["d", "a", "c", "n"] },
                      r: { type: ["string", "null"] },
                    },
                    required: ["i", "t", "r"],
                  },
                },
              },
              required: ["classifications"],
            },
          },
        },
      }),
      signal: AbortSignal.timeout(60_000),
    });

    const body = await response.json() as {
      error?: { message?: string };
      choices?: Array<{ message?: { content?: string } }>;
      usage?: OpenRouterUsage;
    };
    usage = parseUsage(model, body.usage);

    if (!response.ok) {
      throw new Error(`OpenRouter ${response.status}: ${body.error?.message ?? response.statusText}`);
    }

    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenRouter returned no classification content");
    classifications = parseClassifications(content, emails);
  } catch (error) {
    caughtError = error;
  }

  const attempt: ModelAttempt = {
    model,
    attempt: attemptNumber,
    success: classifications !== undefined,
    batchSize: emails.length,
    latencyMs: Date.now() - startedAt,
    usage,
    ...(caughtError ? { errorType: errorType(caughtError) } : {}),
  };
  try {
    await hooks.onAttempt?.(attempt);
  } catch (error) {
    const accountingError = new Error("Failed to persist model-call accounting", { cause: error });
    accountingError.name = "ModelAccountingError";
    throw accountingError;
  }

  if (caughtError) throw caughtError;
  return classifications!;
}

export async function classifyBatch(
  emails: EmailSummary[],
  hooks: ClassificationHooks = {}
): Promise<Classification[]> {
  if (emails.length === 0) return [];

  let primaryError: unknown;
  try {
    return await classifyWithModel(emails, PRIMARY_MODEL, 1, hooks);
  } catch (error) {
    if (
      error instanceof Error &&
      ["DailyBudgetExceededError", "ModelPreflightError", "ModelAccountingError"].includes(error.name)
    ) {
      throw error;
    }
    primaryError = error;
    console.error(`  Primary model ${PRIMARY_MODEL} failed:`, error);
  }

  try {
    return await classifyWithModel(emails, BACKUP_MODEL, 2, hooks);
  } catch (backupError) {
    throw new AggregateError(
      [primaryError, backupError],
      `Classification failed with both ${PRIMARY_MODEL} and ${BACKUP_MODEL}`
    );
  }
}
