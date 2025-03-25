# Linear MCP Server

[![npm version](https://img.shields.io/npm/v/linear-mcp-server.svg)](https://www.npmjs.com/package/linear-mcp-server) [![smithery badge](https://smithery.ai/badge/linear-mcp-server)](https://smithery.ai/server/linear-mcp-server)

A [Model Context Protocol](https://github.com/modelcontextprotocol) server for the [Linear API](https://developers.linear.app/docs/graphql/working-with-the-graphql-api).

This server provides integration with Linear's issue tracking system through MCP, allowing LLMs to interact with Linear issues.

## Installation

### Automatic Installation

To install the Linear MCP server for Claude Desktop automatically via [Smithery](https://smithery.ai/protocol/linear-mcp-server):

```bash
npx @smithery/cli install linear-mcp-server --client claude
```

### Manual Installation

1. Create or get a Linear API key for your team: [https://linear.app/YOUR-TEAM/settings/api](https://linear.app/YOUR-TEAM/settings/api)

2. Add server config to Claude Desktop:
   - MacOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "linear": {
      "command": "npx",
      "args": [
        "-y",
        "linear-mcp-server"
      ],
      "env": {
        "LINEAR_API_KEY": "your_linear_api_key_here"
      }
    }
  }
}
```

## Components

### Tools

1. **`linear_create_issue`**: Create a new Linear issue
   - Required inputs:
     - `title` (string): Issue title
     - `teamId` (string): Team ID to create issue in
   - Optional inputs:
     - `description` (string): Issue description (markdown supported)
     - `priority` (number, 0-4): Priority level (0-4, where lower is higher priority)
     - `status` (string): Initial status name

2. **`linear_update_issue`**: Update existing issues
   - Required inputs:
     - `id` (string): Issue ID to update
   - Optional inputs:
     - `title` (string): New title
     - `description` (string): New description
     - `priority` (number, 0-4): New priority
     - `status` (string): New status name

3. **`linear_search_issues`**: Search issues with flexible filtering
   - Optional inputs:
     - `query` (string): Text to search in title/description
     - `identifier` (string): Search by specific ticket identifier (e.g., 'ABC-123')
     - `teamId` (string): Filter by team
     - `status` (string): Filter by status name (e.g., 'In Progress', 'Done')
     - `assigneeId` (string): Filter by assignee's user ID
     - `labels` (string[]): Filter by label names
     - `priority` (number): Filter by priority (1=urgent, 2=high, 3=normal, 4=low)
     - `estimate` (number): Filter by estimate points
     - `includeArchived` (boolean): Include archived issues
     - `limit` (number, default: 10): Max results

4. **`linear_get_user_issues`**: Get issues assigned to a user
   - Optional inputs:
     - `userId` (string): User ID (omit for authenticated user)
     - `includeArchived` (boolean): Include archived issues
     - `limit` (number, default: 50): Max results

5. **`linear_add_comment`**: Add comments to issues
   - Required inputs:
     - `identifier` (string): Linear issue identifier (e.g., 'ABC-123')
     - `body` (string): Comment text (markdown supported)
   - Optional inputs:
     - `createAsUser` (string): Custom username
     - `displayIconUrl` (string): Custom avatar URL

### Resources

- `linear-issue://{issueId}` - View individual issue details
- `linear-team://{teamId}` - View team issues
- `linear-user://{userId}` - View user's assigned issues
- `linear-search://{query}` - Search for issues with a query string or ticket identifier
- `linear-priority://{level}` - Find issues matching a specific priority level
- `linear-organization://` - View organization info
- `linear-viewer://` - View current user context
- `linear-my-issues://` - View all issues assigned to you
- `linear-my-backlog://` - View your backlog issues
- `linear-my-planned://` - View your planned issues for current cycle
- `linear-my-in-progress://` - View your in-progress issues
- `linear-my-under-review://` - View your issues under review
- `linear-my-high-priority://` - View your high priority issues

## Usage examples

Some example prompts you can use with Claude Desktop to interact with Linear:

1. "Show me all my high-priority issues" → execute the `linear_search_issues` tool and/or `linear-my-high-priority://` to find issues assigned to you with high priority

2. "Based on what I've told you about this bug already, make a bug report for the authentication system" → use `linear_create_issue` to create a new issue with appropriate details and status tracking

3. "Find all in progress frontend tasks" → use `linear_search_issues` to locate frontend-related issues with in progress status

4. "Give me a summary of recent updates on the issues for mobile app development" → use `linear_search_issues` to identify the relevant issue(s), then `linear-issue://{issueId}` fetch the issue details and show recent activity and comments

5. "What's the current workload for the mobile team?" → use `linear-team://{teamId}` to analyze issue distribution and priorities across the mobile team

6. "Look up ticket FE-123" → use `linear_search_issues` with the `identifier` parameter or `linear-search://FE-123` to find a specific Linear ticket by its identifier

## Development

1. Install dependencies:

```bash
npm install
```

2. Configure Linear API key in `.env`:

```bash
LINEAR_API_KEY=your_api_key_here
```

3. Build the server:

```bash
npm run build
```

For development with auto-rebuild:

```bash
npm run watch
```

## License

This MCP server is licensed under the MIT License. This means you are free to use, modify, and distribute the software, subject to the terms and conditions of the MIT License. For more details, please see the LICENSE file in the project repository.
