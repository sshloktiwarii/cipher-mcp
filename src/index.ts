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
import path from "node:path";
import fs from "node:fs";

// Initialize stateless MCP server instance
const server = new Server(
  {
    name: "stateless-mcp-github-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Helper to instantiate SimpleGit for a specific directory
function getGitInstance(targetDir?: string): SimpleGit {
  const repoPath = targetDir ? path.resolve(targetDir) : process.cwd();

  if (!fs.existsSync(repoPath)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Specified repository path does not exist: ${repoPath}`
    );
  }

  const options: Partial<SimpleGitOptions> = {
    baseDir: repoPath,
    binary: "git",
    maxConcurrentProcesses: 4,
    trimmed: true,
  };

  return simpleGit(options);
}

// Conventional commit validation regex
const CONVENTIONAL_COMMIT_REGEX =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9_-]+\))?!?: .+/i;

// 1. Tool Definitions Handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "git_status",
        description:
          "Reads the current local git status, active branch name, staged/unstaged files, and unified git diff.",
        inputSchema: {
          type: "object",
          properties: {
            repo_path: {
              type: "string",
              description:
                "Absolute or relative path to the git repository root. Defaults to current working directory.",
            },
            include_diff: {
              type: "boolean",
              description: "Whether to include full unified git diff in the output. Defaults to true.",
            },
          },
          required: [],
        },
      },
      {
        name: "git_commit",
        description:
          "Stages modified files and creates a git commit using Conventional Commit standards.",
        inputSchema: {
          type: "object",
          properties: {
            repo_path: {
              type: "string",
              description:
                "Path to the git repository root. Defaults to current working directory.",
            },
            message: {
              type: "string",
              description:
                "Commit message following Conventional Commits format, e.g. 'feat(auth): add OAuth2 provider'",
            },
            files: {
              type: "array",
              items: { type: "string" },
              description:
                "Specific files to stage and commit. Defaults to all modified/untracked files ('.').",
            },
          },
          required: ["message"],
        },
      },
    ],
  };
});

// 2. Tool Execution Handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "git_status": {
        const repoPath = (args?.repo_path as string) || process.cwd();
        const includeDiff = args?.include_diff !== false;
        const git = getGitInstance(repoPath);

        const isRepo = await git.checkIsRepo();
        if (!isRepo) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Directory is not a valid git repository: ${repoPath}`
          );
        }

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
          ahead: status.ahead,
          behind: status.behind,
        };

        let responseText = `### Git Status Summary\n\`\`\`json\n${JSON.stringify(
          summary,
          null,
          2
        )}\n\`\`\`\n`;

        if (includeDiff && diffOutput.trim().length > 0) {
          responseText += `\n### Unified Working Tree Diff\n\`\`\`diff\n${diffOutput}\n\`\`\``;
        } else if (includeDiff) {
          responseText += `\n*No working tree diff (working tree clean)*`;
        }

        return {
          content: [
            {
              type: "text",
              text: responseText,
            },
          ],
        };
      }

      case "git_commit": {
        const repoPath = (args?.repo_path as string) || process.cwd();
        const message = args?.message as string;
        const files = (args?.files as string[]) || ["."];

        if (!message || message.trim() === "") {
          throw new McpError(ErrorCode.InvalidParams, "Commit message cannot be empty.");
        }

        // Validate Conventional Commit format
        if (!CONVENTIONAL_COMMIT_REGEX.test(message.trim())) {
          return {
            content: [
              {
                type: "text",
                text: `[REJECTED] Commit message does not satisfy Conventional Commit specifications: '${message}'\n` +
                  `Expected pattern: <type>(<scope>): <subject>, e.g., 'feat(router): add latency thresholding'`,
              },
            ],
            isError: true,
          };
        }

        const git = getGitInstance(repoPath);
        const isRepo = await git.checkIsRepo();
        if (!isRepo) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Directory is not a valid git repository: ${repoPath}`
          );
        }

        // Stage files
        await git.add(files);

        // Verify there is staged content
        const statusBefore = await git.status();
        if (statusBefore.staged.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No changes staged for commit. Working tree may already be clean.",
              },
            ],
            isError: false,
          };
        }

        // Perform commit
        const commitResult = await git.commit(message);

        const resultPayload = {
          status: "committed",
          branch: commitResult.branch,
          commit_sha: commitResult.commit,
          summary: commitResult.summary,
          staged_files_count: statusBefore.staged.length,
          message: message,
        };

        return {
          content: [
            {
              type: "text",
              text: `### Git Commit Successful\n\`\`\`json\n${JSON.stringify(
                resultPayload,
                null,
                2
              )}\n\`\`\``,
            },
          ],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool requested: ${name}`);
    }
  } catch (error: any) {
    if (error instanceof McpError) {
      throw error;
    }
    return {
      content: [
        {
          type: "text",
          text: `Git operation failure: ${error?.message || String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

// Boot Stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[INIT] Stateless MCP GitHub Operations Server running on stdio transport");
}

main().catch((err) => {
  console.error("[FATAL] Server initialization failed:", err);
  process.exit(1);
});
