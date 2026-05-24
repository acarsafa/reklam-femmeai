/**
 * Marpany MCP Server entry point.
 *
 * Hosts an HTTP server that implements the MCP Streamable HTTP transport.
 * claude.ai connects to this server, authenticates with MCP_SERVER_TOKEN,
 * and invokes Meta Marketing API tools scoped to Asra Pırlanta.
 */

import express from "express";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MetaClient, MetaApiError } from "./meta-client.js";
import { ALL_TOOLS, type Guardrails } from "./tools.js";

// ============ CONFIG ============

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`FATAL: ${name} environment variable is not set`);
    process.exit(1);
  }
  return v;
}

const META_ACCESS_TOKEN = requireEnv("META_ACCESS_TOKEN");
const ASRA_AD_ACCOUNT_ID = requireEnv("ASRA_AD_ACCOUNT_ID");
const MCP_SERVER_TOKEN = requireEnv("MCP_SERVER_TOKEN");
const PORT = parseInt(process.env.PORT ?? "3000", 10);

const guardrails: Guardrails = {
  maxDailyBudgetCents: parseInt(process.env.MAX_DAILY_BUDGET_TRY ?? "5000", 10) * 100,
  maxBudgetIncreasePercent: parseInt(process.env.MAX_BUDGET_INCREASE_PERCENT ?? "50", 10),
};

// Validate ASRA_AD_ACCOUNT_ID looks numeric (defense against misconfiguration)
if (!/^\d+$/.test(ASRA_AD_ACCOUNT_ID)) {
  console.error(`FATAL: ASRA_AD_ACCOUNT_ID must be numeric (no "act_" prefix). Got: ${ASRA_AD_ACCOUNT_ID}`);
  process.exit(1);
}

const metaClient = new MetaClient({
  accessToken: META_ACCESS_TOKEN,
  adAccountId: ASRA_AD_ACCOUNT_ID,
});

console.log(`[startup] Marpany MCP server starting`);
console.log(`[startup] Ad account: act_${ASRA_AD_ACCOUNT_ID}`);
console.log(`[startup] Guardrails: maxDailyBudget=${guardrails.maxDailyBudgetCents / 100} TRY, maxIncrease=${guardrails.maxBudgetIncreasePercent}%`);
console.log(`[startup] Tools loaded: ${ALL_TOOLS.length}`);

// ============ MCP SERVER FACTORY ============

function createMcpServer(): Server {
  const server = new Server(
    { name: "marpany-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const tool = ALL_TOOLS.find((t) => t.name === name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    }
    try {
      const result = await tool.handler(args ?? {}, metaClient, guardrails);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const msg =
        err instanceof MetaApiError
          ? `Meta API error: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      console.error(`[tool=${name}] error:`, msg);
      return {
        isError: true,
        content: [{ type: "text", text: msg }],
      };
    }
  });

  return server;
}

// ============ HTTP SERVER ============

const app = express();
app.use(express.json({ limit: "4mb" }));

// Health check (no auth - for Railway/uptime monitoring)
app.get("/health", (_req, res) => {
  res.json({ ok: true, account: `act_${ASRA_AD_ACCOUNT_ID}`, tools: ALL_TOOLS.length });
});

// MCP endpoint - Streamable HTTP transport
// Token is in the URL path: /mcp/<MCP_SERVER_TOKEN>
// This avoids the OAuth requirement of claude.ai's custom connector form.
const transports = new Map<string, StreamableHTTPServerTransport>();

app.all("/mcp/:token", async (req, res) => {
  // Validate token in URL path
  if (req.params.token !== MCP_SERVER_TOKEN) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else if (!sessionId && req.method === "POST") {
      // New session
      const newSessionId = randomUUID();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        onsessioninitialized: (id) => {
          transports.set(id, transport);
          console.log(`[mcp] session initialized: ${id}`);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
          console.log(`[mcp] session closed: ${transport.sessionId}`);
        }
      };
      const server = createMcpServer();
      await server.connect(transport);
    } else {
      res.status(400).json({ error: "Invalid session" });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] handler error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" });
    }
  }
});

app.listen(PORT, () => {
  console.log(`[startup] Marpany MCP server listening on port ${PORT}`);
  console.log(`[startup] MCP endpoint: /mcp/<token> (token in URL path)`);
  console.log(`[startup] Health endpoint: /health`);
});
