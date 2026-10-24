# cipher-mcp

Model Context Protocol (MCP) server exposing local operational tools via JSON-RPC 2.0.

Written in pure Go and backed by SQLite WAL storage. Implements the standard Model Context Protocol over stdio, HTTP, and Unix domain sockets (`/tmp/cipher/mcp.sock`).

---

## Exposed MCP Tools

| Tool | Parameters | Description |
| :--- | :--- | :--- |
| `execute_sandbox_code` | `language`, `code`, `timeout_seconds` | Dispatches untrusted code to the Seatbelt sandbox (`cipher-exec`). |
| `query_neural_memory` | `query`, `top_k` | Queries the Obsidian vector store (`cipher-mem`) for relevant context. |
| `inspect_security_waf` | `prompt` | Evaluates prompts against regex and Shannon entropy rules (`cipher-sec`). |
| `verify_audit_chain` | *(none)* | Queries `cipher-log` for SHA-256 Merkle root verification proof. |

---

## Build

```bash
go build -o cipher-mcp .
```

---

## Usage

```bash
./cipher-mcp --port 8085 --socket /tmp/cipher/mcp.sock
```

### Protocol Usage

#### 1. Tool Discovery (`tools/list`)
```bash
curl -X POST http://localhost:8085/ \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}'
```

#### 2. Tool Invocation (`tools/call`)
```bash
curl -X POST http://localhost:8085/ \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "verify_audit_chain",
      "arguments": {}
    }
  }'
```

### Claude Desktop / Cursor MCP Configuration

```json
{
  "mcpServers": {
    "cipher": {
      "command": "/usr/local/bin/cipher-mcp",
      "args": ["--port", "8085"]
    }
  }
}
```

---

## License

MIT License. Copyright (c) 2026 Shlok Tiwari.
