// mcp.ts — the Model Context Protocol surface (POST /mcp, era 2026-07-28).
// JSON-RPC 2.0 over HTTP. Every response echoes the request id. Unknown tools and bad
// arguments are JSON-RPC errors, never HTTP 500. Auth is checked by app.ts before dispatch.

import { VIEWER_LOGIN, type Forge } from './store.ts';
import { issueJson, repoJson } from './rest.ts';

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get an issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        issue_number: { type: 'integer', description: 'Issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function strArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function numArg(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return Number.NaN;
}

function textResult(result: unknown): { content: Array<{ type: string; text: string }>; structuredContent: unknown; isError: false } {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError: false,
  };
}

function errorResult(message: string): { content: Array<{ type: string; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): { result?: unknown; error?: string } {
  const def = TOOLS.find((tool) => tool.name === name);
  if (!def) return { error: `unknown tool ${name}` };
  for (const required of def.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { result: errorResult(`missing required argument: ${required}`) };
    }
  }

  if (name === 'create_repo') {
    const created = forge.createRepo(strArg(args, 'name'), args.private === true, strArg(args, 'description'));
    if (created.error || !created.repo) return { result: errorResult(created.error ?? 'could not create repository') };
    const out = repoJson(forge, created.repo);
    return { result: textResult(out) };
  }

  const owner = strArg(args, 'owner');
  const repoName = strArg(args, 'repo');
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return { result: errorResult(`repository ${owner}/${repoName} not found`) };

  if (name === 'get_repo') {
    return { result: textResult(repoJson(forge, repo)) };
  }
  if (name === 'create_issue') {
    const created = forge.createIssue(repo, strArg(args, 'title'), strArg(args, 'body'), []);
    if (created.error || !created.issue) return { result: errorResult(created.error ?? 'could not create issue') };
    return { result: textResult(issueJson(forge, repo, created.issue)) };
  }
  if (name === 'list_issues') {
    const state = strArg(args, 'state') || 'open';
    const issues = forge.listIssues(repo, state, 'desc');
    return { result: textResult(issues.map((issue) => issueJson(forge, repo, issue))) };
  }
  if (name === 'create_pull_request') {
    const created = forge.createPull(repo, {
      head: strArg(args, 'head'),
      base: strArg(args, 'base'),
      title: strArg(args, 'title'),
      body: strArg(args, 'body'),
    });
    if (created.error || !created.pull) return { result: errorResult(created.error ?? 'could not create pull request') };
    return {
      result: textResult({
        number: created.pull.number,
        state: created.pull.state,
        title: created.pull.title,
        head: { ref: created.pull.headRef, sha: created.pull.headSha },
        base: { ref: created.pull.baseRef, sha: created.pull.baseSha },
      }),
    };
  }
  if (name === 'merge_pull_request') {
    const number = numArg(args, 'pull_number');
    const pull = repo.pulls.get(number);
    if (!pull) return { result: errorResult(`pull request ${number} not found`) };
    const merged = forge.mergePull(repo, pull);
    if (merged.error) return { result: errorResult(merged.error) };
    return { result: textResult({ merged: true, sha: merged.sha, number }) };
  }
  if (name === 'get_issue') {
    const number = numArg(args, 'issue_number');
    const issue = repo.issues.get(number);
    if (!issue) return { result: errorResult(`issue ${number} not found`) };
    return { result: textResult(issueJson(forge, repo, issue)) };
  }
  if (name === 'list_pull_requests') {
    const state = strArg(args, 'state') || 'open';
    const pulls = forge.listPulls(repo, state);
    return {
      result: textResult(pulls.map((pull) => ({
        number: pull.number,
        state: pull.state,
        merged: pull.merged,
        title: pull.title,
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
      }))),
    };
  }
  return { error: `unknown tool ${name}` };
}

export function handleMcp(forge: Forge, bodyText: string): { status: number; body: string } {
  let request: unknown;
  try {
    request = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: request body is not valid JSON' },
      }),
    };
  }
  if (!isRecord(request) || typeof request.method !== 'string') {
    return {
      status: 400,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: isRecord(request) ? request.id ?? null : null,
        error: { code: -32600, message: 'Invalid Request' },
      }),
    };
  }
  const id = request.id ?? null;
  const method = request.method;
  const params = isRecord(request.params) ? request.params : {};

  // Notifications get no response body.
  if (method.startsWith('notifications/')) {
    return { status: 202, body: '' };
  }

  const respond = (result: unknown): { status: number; body: string } => ({
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id, result }),
  });
  const respondError = (code: number, message: string): { status: number; body: string } => ({
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
  });

  if (method === 'ping') return respond({});

  if (method === 'server/discover') {
    return respond({
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const protocolVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
    return respond({
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'tools/list') {
    return respond({ tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const { result, error } = callTool(forge, toolName, args);
    if (error !== undefined) return respondError(-32602, error);
    return respond(result);
  }

  return respondError(-32601, `Method not found: ${method}`);
}

export { VIEWER_LOGIN };
