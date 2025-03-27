# MCP Inspector CLI

A command-line interface for the Model Context Protocol (MCP) Inspector.

## Installation

```bash
npm install -g mcp-inspector-cli
```

## Usage

### Connect to an MCP Server

Connect to a local MCP server via STDIO:

```bash
mcp-inspector-cli connect --transport stdio --command node --args "your-server.js"
```

Connect to a remote MCP server via SSE:

```bash
mcp-inspector-cli connect --transport sse --url "http://example.com/sse" --bearer-token "your-token"
```

### Interactive Mode

Start in interactive mode for a more user-friendly experience:

```bash
mcp-inspector-cli interactive
```

Or simply:

```bash
mcp-inspector-cli i
```

### Resources

List available resources:

```bash
mcp-inspector-cli resources list
```

Read a specific resource:

```bash
mcp-inspector-cli resources read "resource-uri"
```

List resource templates:

```bash
mcp-inspector-cli resources templates
```

### Prompts

List available prompts:

```bash
mcp-inspector-cli prompts list
```

Get a specific prompt:

```bash
mcp-inspector-cli prompts get "prompt-name" --arg "param1=value1" --arg "param2=value2"
```

### Tools

List available tools:

```bash
mcp-inspector-cli tools list
```

Call a specific tool:

```bash
mcp-inspector-cli tools call "tool-name" --param "param1=value1" --json-param "param2={'key':'value'}"
```

### Ping

Ping the MCP server:

```bash
mcp-inspector-cli ping
```

## Interactive Mode Commands

When in interactive mode, the following commands are available:

- `help`: Show available commands
- `exit`, `quit`: Exit interactive mode
- `capabilities`: Show server capabilities
- `ping`: Ping the server
- `resources`: List available resources
- `read <uri>`: Read a specific resource
- `templates`: List resource templates
- `template <name>`: Use a resource template
- `subscribe <uri>`: Subscribe to resource updates
- `unsubscribe <uri>`: Unsubscribe from resource updates
- `prompts`: List available prompts
- `prompt <name>`: Get a specific prompt
- `tools`: List available tools
- `tool <name>`: Call a specific tool
- `roots`: List current roots
- `roots add <uri>`: Add a root directory
- `roots remove <index>`: Remove a root directory
- `roots update`: Apply root changes
- `log level`: Show current log level
- `log level <level>`: Set log level (debug, info, warn, error)

## Authentication

For SSE connections, you can provide a bearer token for authentication:

```bash
mcp-inspector-cli connect --transport sse --url "http://example.com/sse" --bearer-token "your-token"
```

## Environment Variables

For STDIO connections, you can provide environment variables as JSON:

```bash
mcp-inspector-cli connect --transport stdio --command node --args "your-server.js" --env '{"VAR1":"value1","VAR2":"value2"}'
```

## License

MIT
