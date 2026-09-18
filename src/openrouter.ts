import { emptyUsage, errorType, parseUsage } from "./classifier.js";
import type { ModelAttempt, OpenRouterUsage } from "./classifier.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface JsonCallOptions {
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: object;
  maxTokens: number;
  /** Enable OpenRouter's web plugin with this many results. */
  webResults?: number;
  timeoutMs?: number;
  batchSize?: number;
  attempt?: number;
}

export interface JsonCallResult {
  content: string;
  /** URLs the web plugin actually returned; used to reject uncited claims. */
  citations: string[];
}

export interface CallHooks {
  beforeAttempt?: (model: string) => Promise<void>;
  onAttempt?: (attempt: ModelAttempt) => Promise<void>;
}

type OpenRouterBody = {
  error?: { message?: string };
  choices?: Array<{
    message?: {
      content?: string;
      annotations?: Array<{ type?: string; url_citation?: { url?: string } }>;
    };
  }>;
  usage?: OpenRouterUsage;
};

/** One structured-output OpenRouter call with the same accounting hooks as triage. */
export async function callJson(options: JsonCallOptions, hooks: CallHooks = {}): Promise<JsonCallResult> {
  await hooks.beforeAttempt?.(options.model);

  const startedAt = Date.now();
  let usage = emptyUsage();
  let result: JsonCallResult | undefined;
  let caughtError: unknown;

  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Fastmail Email Triage",
      },
      body: JSON.stringify({
        model: options.model,
        reasoning: { enabled: false },
        max_tokens: options.maxTokens,
        messages: [
          { role: "system", content: options.system },
          { role: "user", content: options.user },
        ],
        ...(options.webResults
          ? { plugins: [{ id: "web", engine: "exa", max_results: options.webResults }] }
          : {}),
        response_format: {
          type: "json_schema",
          json_schema: { name: options.schemaName, strict: true, schema: options.schema },
        },
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 90_000),
    });

    const body = (await response.json()) as OpenRouterBody;
    usage = parseUsage(options.model, body.usage);
    if (!response.ok) {
      throw new Error(`OpenRouter ${response.status}: ${body.error?.message ?? response.statusText}`);
    }

    const message = body.choices?.[0]?.message;
    if (!message?.content) throw new Error("OpenRouter returned no content");
    result = {
      content: message.content,
      citations: (message.annotations ?? [])
        .map((annotation) => annotation.url_citation?.url)
        .filter((url): url is string => typeof url === "string"),
    };
  } catch (error) {
    caughtError = error;
  }

  await hooks.onAttempt?.({
    model: options.model,
    attempt: options.attempt ?? 1,
    success: result !== undefined,
    batchSize: options.batchSize ?? 1,
    latencyMs: Date.now() - startedAt,
    usage,
    ...(caughtError ? { errorType: errorType(caughtError) } : {}),
  });

  if (caughtError) throw caughtError;
  return result!;
}

/** Compare URLs loosely: scheme, "www.", trailing slash, and fragment do not matter. */
export function urlKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.hostname.replace(/^www\./, "").toLowerCase()}${path}${parsed.search}`;
  } catch {
    return null;
  }
}
