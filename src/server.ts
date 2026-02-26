import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  initDb,
  closeDb,
  ensureCorrectionsTable,
  getRecentClassifications,
  insertCorrection,
} from "./db.js";
import type { Tier } from "./types.js";

const TIERS: Tier[] = ["auto-delete", "auto-archive", "confirm", "attention"];
const app = new Hono();

// API: Get recent classifications
app.get("/api/classifications", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50"), 200);
  const offset = parseInt(c.req.query("offset") ?? "0");
  const rows = await getRecentClassifications(limit + offset);
  return c.json(rows.slice(offset));
});

// API: Record a correction
app.post("/api/corrections", async (c) => {
  const body = await c.req.json();
  const { emailId, tier } = body;

  if (!emailId || !TIERS.includes(tier)) {
    return c.json({ error: "Invalid emailId or tier" }, 400);
  }

  const result = await insertCorrection(emailId, tier as Tier);
  if (!result) {
    return c.json({ error: "Classification not found" }, 404);
  }

  return c.json({
    emailId,
    originalTier: result.originalTier,
    correctedTier: tier,
    subject: result.subject,
    from: result.from,
  });
});

// Frontend: Serve inline HTML (placeholder for now — Task 5 will replace this)
app.get("/", (c) => {
  return c.html("<h1>Email Triage</h1><p>Frontend placeholder</p>");
});

// Start
async function start() {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  initDb();
  await ensureCorrectionsTable();

  serve({ fetch: app.fetch, port: 3100 }, (info) => {
    console.log(`Email Triage server running on http://localhost:${info.port}`);
  });

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await closeDb();
    process.exit(0);
  });
}

start().catch((err) => {
  console.error("Server failed to start:", err);
  process.exit(1);
});
