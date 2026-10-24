# Foundry Airgap: Stateless MCP Git Operations Server

A high-performance Model Context Protocol (MCP) server that exposes local Git operations and version control actions directly to AI coding agents via standard MCP Stdio transport.

## Exposed Tools
1. **`git_status`**:
   - Inspects current branch, tracking status, staged, modified, and untracked files.
   - Includes unified git working tree diff.
2. **`git_commit`**:
   - Enforces Conventional Commit specifications (`feat`, `fix`, `refactor`, etc.).
   - Stages target files and creates an atomic git commit.

## Installation & Build
```bash
npm install
npm run build
```

## Adding to Antigravity / Claude Desktop / Cursor MCP Config
```json
{
  "mcpServers": {
    "git-operations": {
      "command": "node",
      "args": ["/path/to/foundry-airgap/dist/index.js"]
    }
  }
}
```
