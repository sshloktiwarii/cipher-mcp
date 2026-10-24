# cipher-mcp: The Plain-English Guide

## What does this do?

Modern AI assistants (like Claude, Cursor, and ChatGPT) need a way to take actions on your computer—such as running a test or searching a folder.

The industry standard for how AI connects to tools is called the **Model Context Protocol (MCP)**. It works like a standardized adapter plug: the AI asks for a specific action, and the MCP server executes it safely and returns structured output.

`cipher-mcp` is a lightweight, pure Go MCP server that provides four tools to AI assistants:
1. **`execute_sandbox_code`**: Allows the AI to test code safely inside an isolated temporary sandbox.
2. **`query_neural_memory`**: Allows the AI to search your local Markdown notes for relevant documentation and past bug fixes.
3. **`inspect_security_waf`**: Allows the AI to verify whether text contains leaked passwords or forbidden commands.
4. **`verify_audit_chain`**: Allows the AI to verify the cryptographic integrity of its own activity logs.

---

## What happens if I don't use this?

Most MCP servers are written in Node.js or Python, which require downloading hundreds of megabytes of `node_modules` or configuring virtual environments. If a dependency breaks, your AI loses access to its tools. `cipher-mcp` is a single compiled Go file that starts instantly with zero setup.

---

## Frequently Asked Questions

#### Which AI assistants can connect to this?
Any assistant that supports the Model Context Protocol, including Claude Desktop, Cursor, and Antigravity.

#### How do I add it to Claude Desktop?
Add the following block to your `claude_desktop_config.json`:
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

#### How do I run it?
In the full Cipher system, `cipher appliance` starts `cipher-mcp` automatically. To run it alone:
```bash
./cipher-mcp --port 8085
```
