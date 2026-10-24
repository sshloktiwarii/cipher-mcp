# 🔌 cipher-mcp — Go Model Context Protocol (MCP) Server

[![Language](https://img.shields.io/badge/Language-Go%201.24-00ADD8?style=flat-square&logo=go)](https://go.dev/)
[![Protocol](https://img.shields.io/badge/Protocol-MCP%20JSON--RPC%202.0-blueviolet?style=flat-square)](https://modelcontextprotocol.io/)
[![Status](https://img.shields.io/badge/Status-Production%20Ready-brightgreen?style=flat-square)](#)

A high-performance, pure Go **Model Context Protocol (MCP)** server providing AI assistants (Claude, Cursor, Antigravity) with structured, isolated tools across code execution, neural memory, security WAF inspection, and cryptographic audit proofs. Backed by a SQLite WAL action queue. Zero Node.js required.

---

### 💡 For Non-Techies: What does this do?
> Think of `cipher-mcp` as a universal adapter plug between an AI assistant and your computer.
>
> When you ask an AI model like Claude or ChatGPT to "run this code" or "check my notes", the AI doesn't know how to talk directly to your computer's files. `cipher-mcp` provides a safe set of tools the AI can call, while keeping your computer safe and recording every action in a tamper-proof log.
>
> Built in Go: zero Node.js, zero `node_modules`, zero setup.

---

## Registered MCP Tools

| Tool Name | Description |
| :--- | :--- |
| **`execute_sandbox_code`** | Runs code inside the kernel-isolated execution sandbox. |
| **`query_neural_memory`** | Performs semantic vector search across notes and incident post-mortems. |
| **`inspect_security_waf`** | Tests prompts against the semantic firewall to detect leaked credentials. |
| **`verify_audit_chain`** | Cryptographically verifies the SHA-256 Merkle audit trail. |

---

## Quickstart

### Build Standalone Binary
```bash
go build -o cipher-mcp .
```

### Run Standalone
```bash
./cipher-mcp --port 8085 --socket /tmp/cipher/mcp.sock
```

### Adding to Claude Desktop / Cursor / Antigravity MCP Config
```json
{
  "mcpServers": {
    "cipher": {
      "command": "/path/to/cipher-mcp",
      "args": ["--port", "8085"]
    }
  }
}
```

---

## License
MIT © [Shlok Tiwari](https://github.com/sshloktiwarii)
