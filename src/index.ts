#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { simpleGit, SimpleGit, SimpleGitOptions } from "simple-git";
import { DatabaseSync } from "node:sqlite";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const DB_PATH = path.resolve(process.cwd(), "pending_actions.db");
const HTTP_PORT = parseInt(process.env.HITL_PORT || "8085", 10);

// Initialize SQLite database with WAL mode for HITL queue
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS pending_actions (
    id TEXT PRIMARY KEY,
    repo_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    message TEXT NOT NULL,
    files TEXT NOT NULL,
    status TEXT NOT NULL,
    commit_sha TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

function getGitInstance(targetDir?: string): SimpleGit {
  const repoPath = targetDir ? path.resolve(targetDir) : process.cwd();
  if (!fs.existsSync(repoPath)) {
    throw new McpError(ErrorCode.InvalidParams, `Repository path does not exist: ${repoPath}`);
  }
  const options: Partial<SimpleGitOptions> = {
    baseDir: repoPath,
    binary: "git",
    maxConcurrentProcesses: 4,
    trimmed: true,
  };
  return simpleGit(options);
}

const CONVENTIONAL_COMMIT_REGEX =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9_-]+\))?!?: .+/i;

// 1. MCP Server Setup
const server = new Server(
  {
    name: "hitl-mcp-github-server",
    version: "2.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "git_status",
        description: "Reads local git status, branch, modified files, and unified git diff.",
        inputSchema: {
          type: "object",
          properties: {
            repo_path: { type: "string", description: "Path to git repository root" },
            include_diff: { type: "boolean", description: "Include unified diff (default true)" },
          },
        },
      },
      {
        name: "git_commit",
        description:
          "Prepares a Conventional Commit and queues it into the Human-in-the-Loop (HITL) approval database for human review.",
        inputSchema: {
          type: "object",
          properties: {
            repo_path: { type: "string", description: "Target git repository path" },
            message: { type: "string", description: "Conventional commit message" },
            files: { type: "array", items: { type: "string" }, description: "Files to stage" },
          },
          required: ["message"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "git_status": {
        const repoPath = (args?.repo_path as string) || process.cwd();
        const includeDiff = args?.include_diff !== false;
        const git = getGitInstance(repoPath);

        const status = await git.status();
        let diffOutput = "";
        if (includeDiff) {
          diffOutput = await git.diff();
        }

        const summary = {
          current_branch: status.current,
          tracking_branch: status.tracking || "none",
          is_clean: status.isClean(),
          staged: status.staged,
          modified: status.modified,
          deleted: status.deleted,
          untracked: status.not_added,
        };

        let responseText = `### Git Status\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\``;
        if (includeDiff && diffOutput.trim()) {
          responseText += `\n### Diff\n\`\`\`diff\n${diffOutput}\n\`\`\``;
        }

        return { content: [{ type: "text", text: responseText }] };
      }

      case "git_commit": {
        const repoPath = (args?.repo_path as string) || process.cwd();
        const message = args?.message as string;
        const files = (args?.files as string[]) || ["."];

        if (!message || !message.trim()) {
          throw new McpError(ErrorCode.InvalidParams, "Commit message cannot be empty.");
        }

        if (!CONVENTIONAL_COMMIT_REGEX.test(message.trim())) {
          return {
            content: [
              {
                type: "text",
                text: `[REJECTED] Commit message does not satisfy Conventional Commits: '${message}'`,
              },
            ],
            isError: true,
          };
        }

        const git = getGitInstance(repoPath);
        const status = await git.status();
        const branch = status.current || "unknown";

        // Generate Action ID and insert into SQLite queue
        const actionId = `act_${crypto.randomBytes(6).toString("hex")}`;
        const now = new Date().toISOString();

        const insertStmt = db.prepare(`
          INSERT INTO pending_actions (id, repo_path, branch, message, files, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'pending_approval', ?, ?)
        `);
        insertStmt.run(actionId, repoPath, branch, JSON.stringify(files), now, now);

        const approvalUrl = `http://localhost:${HTTP_PORT}/ui`;

        return {
          content: [
            {
              type: "text",
              text: `### [HITL INTERCEPT] Commit Queued for Human Approval\n` +
                `- **Action ID**: \`${actionId}\`\n` +
                `- **Repository**: \`${repoPath}\`\n` +
                `- **Branch**: \`${branch}\`\n` +
                `- **Proposed Message**: \`${message}\`\n` +
                `- **Files**: \`${JSON.stringify(files)}\`\n` +
                `- **Status**: \`pending_approval\`\n\n` +
                `**Review & Approve here**: ${approvalUrl}\n` +
                `Or via API: \`POST http://localhost:${HTTP_PORT}/actions/${actionId}/approve\``,
            },
          ],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

// 2. Secondary Local HTTP Server (HITL Approval API & Web UI)
const httpServer = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // List all actions
  if (url.pathname === "/actions" && req.method === "GET") {
    const rows = db.prepare("SELECT * FROM pending_actions ORDER BY created_at DESC").all();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(rows));
    return;
  }

  // Approve action
  if (url.pathname.startsWith("/actions/") && url.pathname.endsWith("/approve") && req.method === "POST") {
    const id = url.pathname.split("/")[2];
    const action = db.prepare("SELECT * FROM pending_actions WHERE id = ?").get(id) as any;

    if (!action) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Action not found" }));
      return;
    }

    try {
      const git = getGitInstance(action.repo_path);
      const files = JSON.parse(action.files);
      await git.add(files);
      const commitRes = await git.commit(action.message);

      const now = new Date().toISOString();
      db.prepare("UPDATE pending_actions SET status = 'approved', commit_sha = ?, updated_at = ? WHERE id = ?").run(
        commitRes.commit,
        now,
        id
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "approved", commit_sha: commitRes.commit, action_id: id }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Reject action
  if (url.pathname.startsWith("/actions/") && url.pathname.endsWith("/reject") && req.method === "POST") {
    const id = url.pathname.split("/")[2];
    const now = new Date().toISOString();
    db.prepare("UPDATE pending_actions SET status = 'rejected', updated_at = ? WHERE id = ?").run(now, id);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "rejected", action_id: id }));
    return;
  }

function escapeHtml(str: string): string {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

  // Web UI for Review and Approval
  if (url.pathname === "/ui") {
    const rows = db.prepare("SELECT * FROM pending_actions ORDER BY created_at DESC").all() as any[];
    const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>HITL MCP Git Approval Intercept</title>
        <style>
          body { font-family: -apple-system, sans-serif; background: #0f172a; color: #f8fafc; margin: 40px auto; max-width: 900px; padding: 0 20px; }
          h1 { font-size: 24px; border-bottom: 1px solid #334155; padding-bottom: 12px; }
          .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
          .badge { padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; text-transform: uppercase; }
          .pending { background: #eab308; color: #000; }
          .approved { background: #22c55e; color: #000; }
          .rejected { background: #ef4444; color: #fff; }
          button { padding: 8px 16px; border-radius: 6px; border: none; cursor: pointer; font-weight: 600; margin-right: 8px; }
          .btn-approve { background: #22c55e; color: #000; }
          .btn-reject { background: #ef4444; color: #fff; }
        </style>
      </head>
      <body>
        <h1>🛡️ Human-in-the-Loop (HITL) Git Approval Queue</h1>
        <p style="color:#94a3b8">Pending commits generated by autonomous AI agents awaiting your confirmation.</p>
        ${rows.length === 0 ? "<p>No pending actions recorded.</p>" : ""}
        ${rows.map((row) => `
          <div class="card">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <strong>ID: <code>${escapeHtml(row.id)}</code></strong>
              <span class="badge ${row.status.includes('pending') ? 'pending' : row.status === 'approved' ? 'approved' : 'rejected'}">${escapeHtml(row.status)}</span>
            </div>
            <p style="margin: 8px 0; font-size: 16px;"><strong>Message:</strong> ${escapeHtml(row.message)}</p>
            <p style="margin: 4px 0; color: #94a3b8; font-size: 13px;">Repo: ${escapeHtml(row.repo_path)} | Branch: ${escapeHtml(row.branch)}</p>
            <p style="margin: 4px 0; color: #94a3b8; font-size: 13px;">Files: <code>${escapeHtml(row.files)}</code></p>
            ${row.commit_sha ? `<p style="color:#4ade80; font-size:13px;">SHA: <code>${escapeHtml(row.commit_sha)}</code></p>` : ""}
            ${row.status === 'pending_approval' ? `
              <div style="margin-top: 16px;">
                <button class="btn-approve" onclick="fetch('/actions/${encodeURIComponent(row.id)}/approve', {method:'POST'}).then(() => location.reload())">Approve & Commit</button>
                <button class="btn-reject" onclick="fetch('/actions/${encodeURIComponent(row.id)}/reject', {method:'POST'}).then(() => location.reload())">Reject</button>
              </div>
            ` : ""}
          </div>
        `).join("")}
      </body>
    </html>
    `;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

async function main() {
  httpServer.listen(HTTP_PORT, () => {
    console.error(`[INIT] HITL Approval Web UI & API active on http://localhost:${HTTP_PORT}/ui`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[INIT] Stateless MCP Server connected via stdio transport");
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
