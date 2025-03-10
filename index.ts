#!/usr/bin/env node

import { LinearClient, LinearDocument, Issue, User, Team, WorkflowState, IssueLabel } from "@linear/sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequest,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  Tool,
  ResourceTemplate,
  Prompt,
} from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import { z } from 'zod';
import Bottleneck from 'bottleneck';

interface CreateIssueArgs {
  title: string;
  teamId: string;
  description?: string;
  priority?: number;
  status?: string;
}

interface UpdateIssueArgs {
  id: string;
  title?: string;
  description?: string;
  priority?: number;
  status?: string;
}

interface SearchIssuesArgs {
  query?: string;
  teamId?: string;
  limit?: number;
  status?: string;
  assigneeId?: string;
  labels?: string[];
  priority?: number;
  estimate?: number;
  includeArchived?: boolean;
}

interface GetUserIssuesArgs {
  userId?: string;
  includeArchived?: boolean;
  limit?: number;
}

interface AddCommentArgs {
  issueId: string;
  body: string;
  createAsUser?: string;
  displayIconUrl?: string;
}

interface LinearIssueResponse {
  identifier: string;
  title: string;
  priority: number | null;
  status: string | null;
  stateName?: string;
  url: string;
}

class LinearMCPClient {
  private client: LinearClient;

  constructor(apiKey: string) {
    if (!apiKey) throw new Error("LINEAR_API_KEY environment variable is required");
    this.client = new LinearClient({ apiKey });
  }

  private async getIssueDetails(issue: Issue) {
    const [statePromise, assigneePromise, teamPromise] = [
      issue.state,
      issue.assignee,
      issue.team
    ];

    const [state, assignee, team] = await Promise.all([
      statePromise ? await statePromise : null,
      assigneePromise ? await assigneePromise : null,
      teamPromise ? await teamPromise : null
    ]);

    return {
      state,
      assignee,
      team
    };
  }

  async listIssues() {
    const result = await this.client.issues({
      first: 50,
      orderBy: LinearDocument.PaginationOrderBy.UpdatedAt
    });

    const issuesWithDetails = await Promise.all(
      result.nodes.map(async (issue) => {
        const details = await this.getIssueDetails(issue);
        return {
          uri: `linear-issue://${issue.id}`,
          mimeType: "application/json",
          name: issue.title,
          description: `Linear issue ${issue.identifier}: ${issue.title}`,
          metadata: {
            identifier: issue.identifier,
            priority: issue.priority,
            status: details.state ? await details.state.name : undefined,
            assignee: details.assignee ? await details.assignee.name : undefined,
            team: details.team ? await details.team.name : undefined,
          }
        };
      })
    );

    return issuesWithDetails;
  }

  async getIssue(issueId: string) {
    const result = await this.client.issue(issueId);
    if (!result) throw new Error(`Issue ${issueId} not found`);

    const details = await this.getIssueDetails(result);

    return {
      id: result.id,
      identifier: result.identifier,
      title: result.title,
      description: result.description,
      priority: result.priority,
      status: details.state?.name,
      assignee: details.assignee?.name,
      team: details.team?.name,
      url: result.url
    };
  }

  async createIssue(args: CreateIssueArgs) {
    const issuePayload = await this.client.createIssue({
      title: args.title,
      teamId: args.teamId,
      description: args.description,
      priority: args.priority,
      stateId: args.status
    });

    const issue = await issuePayload.issue;
    if (!issue) throw new Error("Failed to create issue");
    return issue;
  }

  async updateIssue(args: UpdateIssueArgs) {
    const issue = await this.client.issue(args.id);
    if (!issue) throw new Error(`Issue ${args.id} not found`);

    const updatePayload = await issue.update({
      title: args.title,
      description: args.description,
      priority: args.priority,
      stateId: args.status
    });

    const updatedIssue = await updatePayload.issue;
    if (!updatedIssue) throw new Error("Failed to update issue");
    return updatedIssue;
  }

  async searchIssues(args: SearchIssuesArgs) {
    const result = await this.client.issues({
      filter: this.buildSearchFilter(args),
      first: args.limit || 10,
      includeArchived: args.includeArchived
    });

    const issuesWithDetails = await Promise.all(result.nodes.map(async (issue) => {
      const [state, assignee, labels] = await Promise.all([
        issue.state as Promise<WorkflowState>,
        issue.assignee as Promise<User>,
        issue.labels() as Promise<{ nodes: IssueLabel[] }>
      ]);

      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        priority: issue.priority,
        estimate: issue.estimate,
        status: state?.name || null,
        assignee: assignee?.name || null,
        labels: labels?.nodes?.map((label: IssueLabel) => label.name) || [],
        url: issue.url
      };
    }));

    return issuesWithDetails;
  }

  async getUserIssues(args: GetUserIssuesArgs): Promise<LinearIssueResponse[]> {
    try {
      const user = args.userId && typeof args.userId === 'string' ?
        await this.client.user(args.userId as string) :
        await this.client.viewer;

      const result = await user.assignedIssues({
        first: args.limit || 50,
        includeArchived: args.includeArchived
      });

      if (!result?.nodes) {
        return [];
      }

      const issuesWithDetails = await Promise.all(
        result.nodes.map(async (issue) => {
          const state = await issue.state as WorkflowState;
          return {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            description: issue.description,
            priority: issue.priority,
            status: state?.name || null,
            url: issue.url
          };
        })
      );

      return issuesWithDetails;
    } catch (error) {
      console.error(`Error in getUserIssues: ${error}`);
      throw error;
    }
  }

  async addComment(args: AddCommentArgs) {
    const commentPayload = await this.client.createComment({
      issueId: args.issueId,
      body: args.body,
      createAsUser: args.createAsUser,
      displayIconUrl: args.displayIconUrl
    });

    const comment = await commentPayload.comment;
    if (!comment) throw new Error("Failed to create comment");

    const issue = await comment.issue;
    return {
      comment,
      issue
    };
  }

  async getTeamIssues(teamId: string) {
    const team = await this.client.team(teamId);
    if (!team) throw new Error(`Team ${teamId} not found`);

    const { nodes: issues } = await team.issues();

    const issuesWithDetails = await Promise.all(issues.map(async (issue) => {
      const statePromise = issue.state;
      const assigneePromise = issue.assignee;

      const [state, assignee] = await Promise.all([
        statePromise ? await statePromise : null,
        assigneePromise ? await assigneePromise : null
      ]);

      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        priority: issue.priority,
        status: state?.name,
        assignee: assignee?.name,
        url: issue.url
      };
    }));

    return issuesWithDetails;
  }

  async getViewer() {
    const viewer = await this.client.viewer;
    const [teams, organization] = await Promise.all([
      viewer.teams(),
      this.client.organization
    ]);

    return {
      id: viewer.id,
      name: viewer.name,
      email: viewer.email,
      admin: viewer.admin,
      teams: teams.nodes.map(team => ({
        id: team.id,
        name: team.name,
        key: team.key
      })),
      organization: {
        id: organization.id,
        name: organization.name,
        urlKey: organization.urlKey
      }
    };
  }

  async getOrganization() {
    const organization = await this.client.organization;
    const [teams, users] = await Promise.all([
      organization.teams(),
      organization.users()
    ]);

    return {
      id: organization.id,
      name: organization.name,
      urlKey: organization.urlKey,
      teams: teams.nodes.map(team => ({
        id: team.id,
        name: team.name,
        key: team.key
      })),
      users: users.nodes.map(user => ({
        id: user.id,
        name: user.name,
        email: user.email,
        admin: user.admin,
        active: user.active
      }))
    };
  }

  private buildSearchFilter(args: SearchIssuesArgs): any {
    const filter: any = {};

    if (args.query) {
      filter.or = [
        { title: { contains: args.query } },
        { description: { contains: args.query } }
      ];
    }

    if (args.teamId) {
      filter.team = { id: { eq: args.teamId } };
    }

    if (args.status) {
      filter.state = { name: { eq: args.status } };
    }

    if (args.assigneeId) {
      filter.assignee = { id: { eq: args.assigneeId } };
    }

    if (args.labels && args.labels.length > 0) {
      filter.labels = {
        some: {
          name: { in: args.labels }
        }
      };
    }

    if (args.priority) {
      filter.priority = { eq: args.priority };
    }

    if (args.estimate) {
      filter.estimate = { eq: args.estimate };
    }

    return filter;
  }
}

const createIssueTool: Tool = {
  name: "linear_create_issue",
  description: "Creates a new Linear issue with specified details. Use this to create tickets for tasks, bugs, or feature requests. Returns the created issue's identifier and URL. Required fields are title and teamId, with optional description, priority (0-4, where 0 is no priority and 1 is urgent), and status.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Issue title" },
      teamId: { type: "string", description: "Team ID" },
      description: { type: "string", description: "Issue description" },
      priority: { type: "number", description: "Priority (0-4)" },
      status: { type: "string", description: "Issue status" }
    },
    required: ["title", "teamId"]
  }
};

const updateIssueTool: Tool = {
  name: "linear_update_issue",
  description: "Updates an existing Linear issue's properties. Use this to modify issue details like title, description, priority, or status. Requires the issue ID and accepts any combination of updatable fields. Returns the updated issue's identifier and URL.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Issue ID" },
      title: { type: "string", description: "New title" },
      description: { type: "string", description: "New description" },
      priority: { type: "number", description: "New priority (0-4)" },
      status: { type: "string", description: "New status" }
    },
    required: ["id"]
  }
};

const searchIssuesTool: Tool = {
  name: "linear_search_issues",
  description: "Searches Linear issues using flexible criteria. Supports filtering by any combination of: title/description text, team, status, assignee, labels, priority (1=urgent, 2=high, 3=normal, 4=low), and estimate. Returns up to 10 issues by default (configurable via limit).",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Optional text to search in title and description" },
      teamId: { type: "string", description: "Filter by team ID" },
      status: { type: "string", description: "Filter by status name (e.g., 'In Progress', 'Done')" },
      assigneeId: { type: "string", description: "Filter by assignee's user ID" },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Filter by label names"
      },
      priority: {
        type: "number",
        description: "Filter by priority (1=urgent, 2=high, 3=normal, 4=low)"
      },
      estimate: {
        type: "number",
        description: "Filter by estimate points"
      },
      includeArchived: {
        type: "boolean",
        description: "Include archived issues in results (default: false)"
      },
      limit: {
        type: "number",
        description: "Max results to return (default: 10)"
      }
    }
  }
};

const getUserIssuesTool: Tool = {
  name: "linear_get_user_issues",
  description: "Retrieves issues assigned to a specific user or the authenticated user if no userId is provided. Returns issues sorted by last updated, including priority, status, and other metadata. Useful for finding a user's workload or tracking assigned tasks.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string", description: "Optional user ID. If not provided, returns authenticated user's issues" },
      includeArchived: { type: "boolean", description: "Include archived issues in results" },
      limit: { type: "number", description: "Maximum number of issues to return (default: 50)" }
    }
  }
};

const addCommentTool: Tool = {
  name: "linear_add_comment",
  description: "Adds a comment to an existing Linear issue. Supports markdown formatting in the comment body. Can optionally specify a custom user name and avatar for the comment. Returns the created comment's details including its URL.",
  inputSchema: {
    type: "object",
    properties: {
      issueId: { type: "string", description: "ID of the issue to comment on" },
      body: { type: "string", description: "Comment text in markdown format" },
      createAsUser: { type: "string", description: "Optional custom username to show for the comment" },
      displayIconUrl: { type: "string", description: "Optional avatar URL for the comment" }
    },
    required: ["issueId", "body"]
  }
};

const resourceTemplates: ResourceTemplate[] = [
  {
    uriTemplate: "linear-issue://{issueId}",
    name: "Linear Issue",
    description: "A Linear issue with its details, comments, and metadata. Use this to fetch detailed information about a specific issue.",
    parameters: {
      issueId: {
        type: "string",
        description: "The unique identifier of the Linear issue (e.g., the internal ID)"
      }
    },
    examples: [
      "linear-issue://c2b318fb-95d2-4a81-9539-f3268f34af87"
    ]
  },
  {
    uriTemplate: "linear-team://{teamId}",
    name: "Team Issues",
    description: "All active issues belonging to a specific Linear team, including their status, priority, and assignees.",
    parameters: {
      teamId: {
        type: "string",
        description: "The unique identifier of the Linear team (found in team settings)"
      }
    },
    examples: [
      "linear-team://TEAM-123"
    ]
  },
  {
    uriTemplate: "linear-user://{userId}",
    name: "User Assigned Issues",
    description: "Active issues assigned to a specific Linear user. Returns issues sorted by update date.",
    parameters: {
      userId: {
        type: "string",
        description: "The unique identifier of the Linear user. Use 'me' for the authenticated user"
      }
    },
    examples: [
      "linear-user://USER-123",
      "linear-user://me"
    ]
  },
  {
    uriTemplate: "linear-search://{query}",
    name: "Search Linear Issues",
    description: "Search for Linear issues with a query string",
    parameters: {
      query: {
        type: "string",
        description: "Search query for finding issues"
      }
    },
    examples: [
      "linear-search://bug",
      "linear-search://priority:high"
    ]
  },
  {
    uriTemplate: "linear-priority://{level}",
    name: "Issues by Priority",
    description: "Find Linear issues matching a specific priority level",
    parameters: {
      level: {
        type: "string",
        description: "Priority level (urgent, high, medium, low, or none)"
      }
    },
    examples: [
      "linear-priority://urgent",
      "linear-priority://high"
    ]
  }
];

const createIssuePrompt: Prompt = {
  name: "create-issue",
  description: "Create a well-structured Linear issue with all necessary details",
  arguments: [
    {
      name: "issueType",
      description: "Type of issue (bug, feature, task, etc.)",
      required: false
    },
    {
      name: "component",
      description: "Component or area affected (UI, API, backend, etc.)",
      required: false
    }
  ]
};

const bugReportPrompt: Prompt = {
  name: "bug-report",
  description: "File a detailed bug report with reproduction steps",
  arguments: [
    {
      name: "severity",
      description: "How severe is this bug (critical, high, medium, low)",
      required: false
    },
    {
      name: "browser",
      description: "Browser info if relevant",
      required: false
    },
    {
      name: "platform",
      description: "Platform info if relevant (OS, device, etc.)",
      required: false
    }
  ]
};

const sprintPlanningPrompt: Prompt = {
  name: "sprint-planning",
  description: "Analyze and organize issues for sprint planning",
  arguments: [
    {
      name: "teamId",
      description: "ID of the team planning the sprint",
      required: true
    },
    {
      name: "sprintDuration",
      description: "Duration of the sprint in weeks",
      required: false
    },
    {
      name: "sprintGoals",
      description: "Primary goals for this sprint",
      required: false
    }
  ]
};

const workStatusPrompt: Prompt = {
  name: "work-status",
  description: "Generate a status report of work items and progress",
  arguments: [
    {
      name: "timeframe",
      description: "Timeframe to report on (today, week, sprint)",
      required: false
    },
    {
      name: "userId",
      description: "User ID to report on (defaults to current user)",
      required: false
    },
    {
      name: "format",
      description: "Report format (summary, detailed)",
      required: false
    }
  ]
};

const searchHelperPrompt: Prompt = {
  name: "search-helper",
  description: "Find issues with guided search parameters",
  arguments: [
    {
      name: "keywords",
      description: "Keywords to search for",
      required: false
    },
    {
      name: "status",
      description: "Issue status to filter by",
      required: false
    },
    {
      name: "assignee",
      description: "Filter by assignee (username or 'me')",
      required: false
    },
    {
      name: "priority",
      description: "Priority level (urgent, high, normal, low)",
      required: false
    }
  ]
};

const linearPrompts = [
  createIssuePrompt,
  bugReportPrompt,
  sprintPlanningPrompt,
  workStatusPrompt,
  searchHelperPrompt
];

// Zod schemas for tool argument validation
const CreateIssueArgsSchema = z.object({
  title: z.string().describe("Issue title"),
  teamId: z.string().describe("Team ID"),
  description: z.string().optional().describe("Issue description"),
  priority: z.number().min(0).max(4).optional().describe("Priority (0-4)"),
  status: z.string().optional().describe("Issue status")
});

const UpdateIssueArgsSchema = z.object({
  id: z.string().describe("Issue ID"),
  title: z.string().optional().describe("New title"),
  description: z.string().optional().describe("New description"),
  priority: z.number().optional().describe("New priority (0-4)"),
  status: z.string().optional().describe("New status")
});

const SearchIssuesArgsSchema = z.object({
  query: z.string().optional().describe("Optional text to search in title and description"),
  teamId: z.string().optional().describe("Filter by team ID"),
  status: z.string().optional().describe("Filter by status name (e.g., 'In Progress', 'Done')"),
  assigneeId: z.string().optional().describe("Filter by assignee's user ID"),
  labels: z.array(z.string()).optional().describe("Filter by label names"),
  priority: z.number().optional().describe("Filter by priority (1=urgent, 2=high, 3=normal, 4=low)"),
  estimate: z.number().optional().describe("Filter by estimate points"),
  includeArchived: z.boolean().optional().describe("Include archived issues in results (default: false)"),
  limit: z.number().optional().describe("Max results to return (default: 10)")
});

const GetUserIssuesArgsSchema = z.object({
  userId: z.string().optional().describe("Optional user ID. If not provided, returns authenticated user's issues"),
  includeArchived: z.boolean().optional().describe("Include archived issues in results"),
  limit: z.number().optional().describe("Maximum number of issues to return (default: 50)")
});

const AddCommentArgsSchema = z.object({
  issueId: z.string().describe("ID of the issue to comment on"),
  body: z.string().describe("Comment text in markdown format"),
  createAsUser: z.string().optional().describe("Optional custom username to show for the comment"),
  displayIconUrl: z.string().optional().describe("Optional avatar URL for the comment")
});

async function main() {
  try {
    dotenv.config();

    const apiKey = process.env.LINEAR_API_KEY;
    if (!apiKey) {
      console.error("LINEAR_API_KEY environment variable is required");
      process.exit(1);
    }

    console.error("Starting Linear MCP Server...");
    const linearClient = new LinearMCPClient(apiKey);

    const server = new Server(
      {
        name: "linear-mcp-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          prompts: {},
          resources: {
            templates: true,
            read: true
          },
          tools: {},
        },
      }
    );

    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      // Only include direct, parameterless resources
      const resources = [
        // User profile resource
        {
          uri: "linear-viewer://",
          name: "Linear User Profile",
          description: "Your Linear user profile information, including teams and permissions",
          mimeType: "application/json"
        },
        // Organization resource
        {
          uri: "linear-organization://",
          name: "Linear Organization",
          description: "Details about your Linear organization, including teams and settings",
          mimeType: "application/json"
        },
        // My issues resource
        {
          uri: "linear-my-issues://",
          name: "My Linear Issues",
          description: "All issues currently assigned to you",
          mimeType: "application/json"
        },
        // My backlog issues
        {
          uri: "linear-my-backlog://",
          name: "My Backlog Issues",
          description: "Issues assigned to you in the Backlog",
          mimeType: "application/json"
        },
        // My planned issues
        {
          uri: "linear-my-planned://",
          name: "My Planned Issues",
          description: "Issues assigned to you that are Planned this Cycle",
          mimeType: "application/json"
        },
        // My in-progress issues
        {
          uri: "linear-my-in-progress://",
          name: "My In-Progress Issues",
          description: "Issues assigned to you that are currently in progress",
          mimeType: "application/json"
        },
        // My under review issues
        {
          uri: "linear-my-under-review://",
          name: "My Under Review Issues",
          description: "Issues assigned to you that are under review",
          mimeType: "application/json"
        },
        // My high priority issues
        {
          uri: "linear-my-high-priority://",
          name: "My High Priority Issues",
          description: "High priority issues assigned to you",
          mimeType: "application/json"
        }
      ];

      return {
        resources,
        resourceTemplates
      };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      // Handle custom URI formats that don't work well with the URL constructor
      const uri = request.params.uri;

      // Parse protocol and path manually for better handling of custom schemes
      const protocolMatch = uri.match(/^([^:]+):\/\/(.*)/);

      if (!protocolMatch) {
        throw new Error(`Invalid URI format: ${uri}`);
      }

      const [, protocol, path] = protocolMatch;

      // Handle fixed resources
      if (protocol === 'linear-organization') {
        const organization = await linearClient.getOrganization();
        return {
          contents: [{
            uri: "linear-organization://",
            mimeType: "application/json",
            text: JSON.stringify(organization)
          }]
        };
      }

      if (protocol === 'linear-viewer') {
        const viewer = await linearClient.getViewer();
        return {
          contents: [{
            uri: "linear-viewer://",
            mimeType: "application/json",
            text: JSON.stringify(viewer)
          }]
        };
      }

      // Handle strategic collection resources
      if (protocol === 'linear-my-issues') {
        const issues = await linearClient.getUserIssues({
          userId: undefined // current user
        });
        return {
          contents: [{
            uri: "linear-my-issues://",
            mimeType: "application/json",
            text: JSON.stringify(issues)
          }]
        };
      }

      if (protocol === 'linear-my-backlog') {
        // Get the current user's ID
        const viewer = await linearClient.getViewer();

        // Search for issues with the current user as assignee and "Backlog" status
        const issues = await linearClient.searchIssues({
          assigneeId: viewer.id,
          status: "Backlog"
        });

        return {
          contents: [{
            uri: "linear-my-backlog://",
            mimeType: "application/json",
            text: JSON.stringify(issues)
          }]
        };
      }

      if (protocol === 'linear-my-planned') {
        // Get the current user's ID
        const viewer = await linearClient.getViewer();

        // Search for issues with the current user as assignee and "Planned this Cycle" status
        const issues = await linearClient.searchIssues({
          assigneeId: viewer.id,
          status: "Planned this Cycle"
        });

        return {
          contents: [{
            uri: "linear-my-planned://",
            mimeType: "application/json",
            text: JSON.stringify(issues)
          }]
        };
      }

      if (protocol === 'linear-my-in-progress') {
        // Get the current user's ID
        const viewer = await linearClient.getViewer();

        // Search for issues with the current user as assignee and "In Progress" status
        const issues = await linearClient.searchIssues({
          assigneeId: viewer.id,
          status: "In Progress"
        });

        return {
          contents: [{
            uri: "linear-my-in-progress://",
            mimeType: "application/json",
            text: JSON.stringify(issues)
          }]
        };
      }

      if (protocol === 'linear-my-under-review') {
        // Get the current user's ID
        const viewer = await linearClient.getViewer();

        // Search for issues with the current user as assignee and "Under Review" status
        const issues = await linearClient.searchIssues({
          assigneeId: viewer.id,
          status: "Under Review"
        });

        return {
          contents: [{
            uri: "linear-my-under-review://",
            mimeType: "application/json",
            text: JSON.stringify(issues)
          }]
        };
      }

      if (protocol === 'linear-my-high-priority') {
        // Get the current user's ID
        const viewer = await linearClient.getViewer();

        // Search for high priority (1) issues with the current user as assignee
        const urgentIssues = await linearClient.searchIssues({
          assigneeId: viewer.id,
          priority: 1
        });

        // Search for high priority (2) issues with the current user as assignee
        const highIssues = await linearClient.searchIssues({
          assigneeId: viewer.id,
          priority: 2
        });

        // Combine both sets of issues
        const issues = [...urgentIssues, ...highIssues];

        return {
          contents: [{
            uri: "linear-my-high-priority://",
            mimeType: "application/json",
            text: JSON.stringify(issues)
          }]
        };
      }

      if (protocol === 'linear-recent-issues') {
        // This is removed from resources list, but keeping the handler for backward compatibility
        const issues = await linearClient.listIssues();
        return {
          contents: [{
            uri: "linear-recent-issues://",
            mimeType: "application/json",
            text: JSON.stringify(issues)
          }]
        };
      }

      // Handle templated resources
      if (protocol === 'linear-issue') {
        const issueId = path;
        if (!issueId) {
          throw new Error("Issue ID is required for linear-issue resource");
        }

        const issue = await linearClient.getIssue(issueId);
        return {
          contents: [{
            uri: `linear-issue://${issueId}`,
            mimeType: "application/json",
            text: JSON.stringify(issue)
          }]
        };
      }

      if (protocol === 'linear-team') {
        const teamId = path;
        if (!teamId) {
          throw new Error("Team ID is required for linear-team resource");
        }

        const issues = await linearClient.getTeamIssues(teamId);
        return {
          contents: [{
            uri: `linear-team://${teamId}`,
            mimeType: "application/json",
            text: JSON.stringify(issues)
          }]
        };
      }

      if (protocol === 'linear-user') {
        const userId = path;
        if (!userId) {
          throw new Error("User ID is required for linear-user resource");
        }

        const issues = await linearClient.getUserIssues({
          userId: userId === 'me' ? undefined : userId
        });
        return {
          contents: [{
            uri: `linear-user://${userId}`,
            mimeType: "application/json",
            text: JSON.stringify(issues)
          }]
        };
      }

      if (protocol === 'linear-search') {
        const query = path;
        if (!query) {
          throw new Error("Search query is required for linear-search resource");
        }

        const issues = await linearClient.searchIssues({ query });
        return {
          contents: [{
            uri: `linear-search://${query}`,
            mimeType: "application/json",
            text: JSON.stringify(issues)
          }]
        };
      }

      if (protocol === 'linear-priority') {
        const level = path;
        if (!level) {
          throw new Error("Priority level is required for linear-priority resource");
        }

        // Map priority levels to Linear's numeric priority values
        const priorityMap: Record<string, number> = {
          'urgent': 1,
          'high': 2,
          'medium': 3,
          'low': 4,
          'none': 0
        };

        const priority = priorityMap[level.toLowerCase()];
        if (priority === undefined) {
          throw new Error(`Invalid priority level: ${level}. Valid values are: urgent, high, medium, low, none`);
        }

        const issues = await linearClient.searchIssues({ priority });
        return {
          contents: [{
            uri: `linear-priority://${level}`,
            mimeType: "application/json",
            text: JSON.stringify(issues)
          }]
        };
      }

      throw new Error(`Unsupported resource URI: ${uri}`);
    });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [createIssueTool, updateIssueTool, searchIssuesTool, getUserIssuesTool, addCommentTool]
    }));

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      return {
        resourceTemplates: resourceTemplates
      };
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => {
      return {
        prompts: linearPrompts
      };
    });

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      console.error("GetPromptRequestSchema", JSON.stringify(request));

      if (request.params.name === createIssuePrompt.name) {
        const issueType = request.params.arguments?.issueType || "task";
        const component = request.params.arguments?.component || "";

        return {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `I need to create a new ${issueType} in Linear${component ? ` for the ${component} component` : ""}.`
              }
            },
            {
              role: "assistant",
              content: {
                type: "text",
                text: `I'll help you create a new ${issueType}${component ? ` for ${component}` : ""}. Let's gather the necessary details:

1. What should be the title of this ${issueType}?
2. Please provide a description with all relevant details${issueType === "bug" ? ", including reproduction steps" : ""}.
3. Which team should this be assigned to?
4. What priority level would you assign (urgent, high, normal, low)?
5. Any specific status you want to set initially?`
              }
            }
          ]
        };
      }

      if (request.params.name === bugReportPrompt.name) {
        const severity = request.params.arguments?.severity || "medium";
        const browser = request.params.arguments?.browser || "";
        const platform = request.params.arguments?.platform || "";

        return {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `I need to file a ${severity} severity bug report${browser ? ` affecting ${browser}` : ""}${platform ? ` on ${platform}` : ""}.`
              }
            },
            {
              role: "assistant",
              content: {
                type: "text",
                text: `I'll help you create a detailed bug report. Please provide the following information:

1. Bug title: (Brief summary of the issue)
2. Reproduction steps:
   - Step 1:
   - Step 2:
   - ...
3. Expected behavior:
4. Actual behavior:
5. Screenshots/videos: (if available)
6. Additional context:${browser ? `\n7. Browser: ${browser}` : ""}${platform ? `\n8. Platform: ${platform}` : ""}

Once you provide this information, I'll help you create a well-structured bug report in Linear with the appropriate priority level (${severity}).`
              }
            }
          ]
        };
      }

      if (request.params.name === sprintPlanningPrompt.name) {
        const teamId = request.params.arguments?.teamId;
        const sprintDuration = request.params.arguments?.sprintDuration || "2";
        const sprintGoals = request.params.arguments?.sprintGoals || "";

        return {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `I need help planning a ${sprintDuration}-week sprint for team ${teamId}${sprintGoals ? ` with these goals: ${sprintGoals}` : ""}.`
              }
            },
            {
              role: "assistant",
              content: {
                type: "text",
                text: `I'll help you plan your ${sprintDuration}-week sprint for team ${teamId}. Let me gather some information about the current backlog and in-progress work.

First, I'll need to:
1. Check existing issues for team ${teamId}
2. Analyze current workload distribution
3. Review any carried-over work from previous sprints

${sprintGoals ? `Based on your sprint goals (${sprintGoals}), ` : ""}Would you like me to:
- Suggest issues to include in this sprint?
- Help prioritize existing backlog items?
- Analyze team capacity?
- Create sprint planning meeting notes?`
              }
            }
          ]
        };
      }

      if (request.params.name === workStatusPrompt.name) {
        const timeframe = request.params.arguments?.timeframe || "week";
        const userId = request.params.arguments?.userId || "me";
        const format = request.params.arguments?.format || "summary";

        return {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `Generate a ${format} work status report for ${userId === "me" ? "my" : userId + "'s"} tasks over the past ${timeframe}.`
              }
            },
            {
              role: "assistant",
              content: {
                type: "text",
                text: `I'll generate a ${format} work status report for ${userId === "me" ? "your" : userId + "'s"} tasks over the past ${timeframe}.

I'll analyze:
- Completed issues
- In-progress work
- Upcoming/planned tasks
- Any blockers or dependencies

Would you like me to include any specific information in this report, such as time estimates or specific projects?`
              }
            }
          ]
        };
      }

      if (request.params.name === searchHelperPrompt.name) {
        const keywords = request.params.arguments?.keywords || "";
        const status = request.params.arguments?.status || "";
        const assignee = request.params.arguments?.assignee || "";
        const priority = request.params.arguments?.priority || "";

        let searchQuery = "I need to find issues";
        if (keywords) searchQuery += ` containing "${keywords}"`;
        if (status) searchQuery += ` with status "${status}"`;
        if (assignee) searchQuery += ` assigned to ${assignee === "me" ? "me" : assignee}`;
        if (priority) searchQuery += ` with ${priority} priority`;

        return {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: searchQuery
              }
            },
            {
              role: "assistant",
              content: {
                type: "text",
                text: `I'll help you search for issues in Linear with these criteria:
${keywords ? `- Keywords: "${keywords}"\n` : ""}${status ? `- Status: "${status}"\n` : ""}${assignee ? `- Assignee: ${assignee === "me" ? "You" : assignee}\n` : ""}${priority ? `- Priority: ${priority}\n` : ""}

Would you like to:
1. Add any other search filters?
2. Sort results in a specific way?
3. Limit the number of results?
4. Include archived issues?`
              }
            }
          ]
        };
      }

      throw new Error(`Prompt not found: ${request.params.name}`);
    });

    server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
      try {
        const { name, arguments: args } = request.params;
        if (!args) throw new Error("Missing arguments");

        switch (name) {
          case "linear_create_issue": {
            const validatedArgs = CreateIssueArgsSchema.parse(args);
            const issue = await linearClient.createIssue(validatedArgs);
            return {
              content: [{
                type: "text",
                text: `Created issue ${issue.identifier}: ${issue.title}\nURL: ${issue.url}`,
              }]
            };
          }

          case "linear_update_issue": {
            const validatedArgs = UpdateIssueArgsSchema.parse(args);
            const issue = await linearClient.updateIssue(validatedArgs);
            return {
              content: [{
                type: "text",
                text: `Updated issue ${issue.identifier}\nURL: ${issue.url}`,
              }]
            };
          }

          case "linear_search_issues": {
            const validatedArgs = SearchIssuesArgsSchema.parse(args);
            const issues = await linearClient.searchIssues(validatedArgs);
            return {
              content: [{
                type: "text",
                text: `Found ${issues.length} issues:\n${
                  issues.map((issue: LinearIssueResponse) =>
                    `- ${issue.identifier}: ${issue.title}\n  Priority: ${issue.priority || 'None'}\n  Status: ${issue.status || 'None'}\n  ${issue.url}`
                  ).join('\n')
                }`,
              }]
            };
          }

          case "linear_get_user_issues": {
            const validatedArgs = GetUserIssuesArgsSchema.parse(args);
            const issues = await linearClient.getUserIssues(validatedArgs);

            return {
              content: [{
                type: "text",
                text: `Found ${issues.length} issues:\n${
                  issues.map((issue: LinearIssueResponse) =>
                    `- ${issue.identifier}: ${issue.title}\n  Priority: ${issue.priority || 'None'}\n  Status: ${issue.status || 'None'}\n  ${issue.url}`
                  ).join('\n')
                }`,
              }]
            };
          }

          case "linear_add_comment": {
            const validatedArgs = AddCommentArgsSchema.parse(args);
            const { comment, issue } = await linearClient.addComment(validatedArgs);

            return {
              content: [{
                type: "text",
                text: `Added comment to issue ${issue?.identifier}\nURL: ${comment.url}`,
              }]
            };
          }

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        console.error("Error executing tool:", error);

        if (error instanceof z.ZodError) {
          const formattedErrors = error.errors.map(err => ({
            path: err.path,
            message: err.message,
            code: 'VALIDATION_ERROR'
          }));

          return {
            content: [{
              type: "text",
              text: {
                error: {
                  type: 'VALIDATION_ERROR',
                  message: 'Invalid request parameters',
                  details: formattedErrors
                }
              },
            }],
            metadata: {
              error: true
            }
          };
        }

        if (error instanceof Error && 'response' in error) {
          return {
            error: {
              code: "linear_api_error",
              content: [
                {
                  type: "text",
                  text: {
                    message: error.message,
                    details: {
                      status: (error.response as any)?.status,
                      data: (error.response as any)?.data
                    }
                  }
                }
              ]
            }
          };
        }

        return {
          content: [{
            type: "text",
            text: {
              error: {
                type: 'UNKNOWN_ERROR',
                message: error instanceof Error ? error.message : String(error)
              }
            },
          }],
          metadata: {
            error: true
          }
        };
      }
    });

    const transport = new StdioServerTransport();
    console.error("Connecting server to transport...");
    await server.connect(transport);
    console.error("Linear MCP Server running on stdio");
  } catch (error) {
    console.error(`Fatal error in main(): ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error("Fatal error in main():", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
