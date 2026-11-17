// graphql.ts — a small GraphQL executor for POST /api/graphql.
// It parses the documents gh and github-mcp-server actually send (queries, mutations,
// variables, inline enums/input objects/lists, aliases, inline fragments, batched arrays)
// and resolves them against the forge. Unknown fields are reported as GraphQL errors
// (HTTP 200 with an errors array), never as an HTTP 400.

import {
  VIEWER_LOGIN,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// parser (the subset the suite's documents use)
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  name: string;
  alias?: string;
  args: Record<string, ValueNode>;
  selection: FieldNode[];
  /** Set for `... on Type { ... }` fragments. */
  fragmentType?: string;
}

interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  fields: FieldNode[];
}

class ParseError extends Error {}

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():![]=@$'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new ParseError('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new ParseError(`expected ${token}, got ${got}`);
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.next();
      if (token === 'query' || token === 'mutation') {
        let name: string | undefined;
        if (this.peek() !== undefined && this.peek() !== '{' && this.peek() !== '(') name = this.next();
        if (this.peek() === '(') this.skipParens();
        this.expect('{');
        const fields = this.parseSelection();
        operations.push({ kind: token, name, fields });
      } else if (token === '{') {
        const fields = this.parseSelection();
        operations.push({ kind: 'query', fields });
      } else {
        throw new ParseError(`unexpected token ${token} at document level`);
      }
    }
    return operations;
  }

  private skipParens(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token === '(') depth += 1;
      else if (token === ')') depth -= 1;
    }
  }

  private parseSelection(): FieldNode[] {
    const fields: FieldNode[] = [];
    for (;;) {
      const token = this.next();
      if (token === '}') return fields;
      if (token === '...') {
        if (this.peek() === 'on') {
          this.next();
          const typeName = this.next();
          this.expect('{');
          const inner = this.parseSelection();
          fields.push({ name: '', fragmentType: typeName, args: {}, selection: inner });
          continue;
        }
        throw new ParseError('named fragments are not supported');
      }
      let name = token;
      let alias: string | undefined;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args: Record<string, ValueNode> = {};
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args[argName] = this.parseValue();
        }
        this.next();
      }
      let selection: FieldNode[] = [];
      if (this.peek() === '{') {
        this.next();
        selection = this.parseSelection();
      }
      fields.push({ name, alias, args, selection });
    }
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const items: ValueNode[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: Record<string, ValueNode> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields[key] = this.parseValue();
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?[0-9]+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    return { kind: 'enum', value: token };
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------------------
// schema: the fields each type carries (for validation and introspection)
// -------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  User: ['login'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private',
  ],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'title', 'body'],
  PullRequestConnection: ['nodes'],
  PullRequestChangedFileConnection: ['nodes'],
  PullRequestChangedFile: ['path'],
  __Type: ['fields', 'enumValues', 'name'],
  __Field: ['name'],
  __EnumValue: ['name'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'TOPIC', 'PACKAGE', 'MARKETPLACE', 'WIKI'];

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

type Source = Record<string, unknown> & { __typename: string };

interface GqlCtx {
  forge: Forge;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function repoSource(forge: Forge, repo: Repo): Source {
  return {
    __typename: 'Repository',
    __repo: repo,
    id: forge.repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    private: repo.isPrivate,
  };
}

function issueSource(forge: Forge, repo: Repo, issue: Issue): Source {
  return {
    __typename: 'Issue',
    __repo: repo,
    __issue: issue,
    id: forge.issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  };
}

function pullSource(forge: Forge, repo: Repo, pull: Pull): Source {
  return {
    __typename: 'PullRequest',
    __repo: repo,
    __pull: pull,
    id: forge.pullGlobalId(repo, pull),
    number: pull.number,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    title: pull.title,
    body: pull.body,
  };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const parsed = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isInteger(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolveField(ctx: GqlCtx, source: Source, field: FieldNode, variables: Record<string, unknown>): unknown {
  const args: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(field.args)) args[key] = resolveValue(node, variables);
  const typeName = source.__typename;
  const forge = ctx.forge;

  if (field.name === '__typename') return typeName;

  if (typeName === 'Query') {
    if (field.name === 'viewer') {
      return { __typename: 'User', login: VIEWER_LOGIN };
    }
    if (field.name === 'repository') {
      const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? repoSource(forge, repo) : null;
    }
    if (field.name === 'node') {
      const found = forge.findByGlobalId(String(args.id ?? ''));
      if (!found) return null;
      if (found.kind === 'R') return repoSource(forge, found.repo);
      if (found.kind === 'I') return issueSource(forge, found.repo, found.issue!);
      if (found.kind === 'P') return pullSource(forge, found.repo, found.pull!);
      if (found.kind === 'C') {
        return { __typename: 'IssueComment', id: found.comment!.id, body: found.comment!.body };
      }
      return null;
    }
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      if (name === 'SearchType') {
        return { __typename: '__Type', __typeName: name, __isEnum: true, name };
      }
      if (TYPE_FIELDS[name] !== undefined) {
        return { __typename: '__Type', __typeName: name, __isEnum: false, name };
      }
      return null;
    }
  }

  if (typeName === 'Repository') {
    const repo = source.__repo as Repo;
    if (field.name === 'owner') return { __typename: 'User', login: repo.owner };
    if (field.name === 'defaultBranchRef') return { __typename: 'Ref', name: repo.defaultBranch };
    if (field.name === 'issue') {
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueSource(forge, repo, issue) : null;
    }
    if (field.name === 'issues') {
      let issues = [...repo.issues.values()];
      const states = args.states;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((entry) => String(entry)));
        issues = issues.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
      }
      const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
      const direction = String(orderBy.direction ?? 'ASC');
      issues.sort((a, b) => (direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
      const afterNumber = numberFromCursor(args.after as string | null | undefined);
      if (afterNumber !== null) {
        const index = issues.findIndex((issue) => issue.number === afterNumber);
        if (index >= 0) issues = issues.slice(index + 1);
      }
      const first = typeof args.first === 'number' ? args.first : issues.length;
      const page = issues.slice(0, Math.max(0, first));
      const hasNext = issues.length > page.length;
      const endCursor = page.length ? cursorFor(page[page.length - 1]!.number) : null;
      return {
        __typename: 'IssueConnection',
        nodes: page.map((issue) => issueSource(forge, repo, issue)),
        pageInfo: { __typename: 'PageInfo', hasNextPage: hasNext, endCursor },
      };
    }
    if (field.name === 'pullRequests') {
      let pulls = [...repo.pulls.values()].filter((pull) => pull.state === 'open');
      pulls.sort((a, b) => a.createdSeq - b.createdSeq);
      const first = typeof args.first === 'number' ? args.first : pulls.length;
      pulls = pulls.slice(0, Math.max(0, first));
      return { __typename: 'PullRequestConnection', nodes: pulls.map((pull) => pullSource(forge, repo, pull)) };
    }
    if (field.name === 'pullRequest') {
      const pull = repo.pulls.get(Number(args.number));
      return pull ? pullSource(forge, repo, pull) : null;
    }
    return source[field.name];
  }

  if (typeName === 'PullRequest') {
    const repo = source.__repo as Repo;
    const pull = source.__pull as Pull;
    if (field.name === 'mergeable') return forge.mergeable(repo, pull);
    if (field.name === 'files') {
      const files = forge.pullFiles(repo, pull);
      const first = typeof args.first === 'number' ? args.first : files.length;
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: files.slice(0, Math.max(0, first)).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename })),
      };
    }
    return source[field.name];
  }

  if (typeName === '__Type') {
    if (field.name === 'fields') {
      const typeName2 = String(source.__typeName ?? '');
      const names = TYPE_FIELDS[typeName2] ?? [];
      return names.map((name) => ({ __typename: '__Field', name }));
    }
    if (field.name === 'enumValues') {
      if (source.__isEnum === true) {
        return SEARCH_TYPE_VALUES.map((name) => ({ __typename: '__EnumValue', name }));
      }
      return [];
    }
    return source[field.name];
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') {
    return source[field.name];
  }

  return source[field.name];
}

class ExecutionError extends Error {}

function executeSelection(
  ctx: GqlCtx,
  source: Source,
  fields: FieldNode[],
  variables: Record<string, unknown>,
  errors: Array<{ message: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.fragmentType !== undefined) {
      if (field.fragmentType !== source.__typename) continue;
      const inner = executeSelection(ctx, source, field.selection, variables, errors);
      Object.assign(out, inner);
      continue;
    }
    const allowed = TYPE_FIELDS[source.__typename] ?? [];
    if (field.name !== '__typename' && !allowed.includes(field.name)) {
      errors.push({ message: `Cannot query field "${field.name}" on type "${source.__typename}".` });
      continue;
    }
    const key = field.alias ?? field.name;
    let value: unknown;
    try {
      value = resolveField(ctx, source, field, variables);
    } catch (err) {
      throw new ExecutionError(err instanceof Error ? err.message : String(err));
    }
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (field.selection.length === 0) {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((entry) => {
        if (isRecord(entry) && typeof entry.__typename === 'string') {
          return executeSelection(ctx, entry as Source, field.selection, variables, errors);
        }
        return entry;
      });
      continue;
    }
    if (isRecord(value) && typeof value.__typename === 'string') {
      out[key] = executeSelection(ctx, value as Source, field.selection, variables, errors);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function executeOperation(ctx: GqlCtx, operation: Operation, variables: Record<string, unknown>): { data?: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const errors: Array<{ message: string }> = [];
  if (operation.kind === 'mutation') {
    return executeMutation(ctx, operation, variables);
  }
  const source: Source = { __typename: 'Query' };
  const data = executeSelection(ctx, source, operation.fields, variables, errors);
  if (errors.length) return { data: null, errors };
  return { data };
}

function executeMutation(ctx: GqlCtx, operation: Operation, variables: Record<string, unknown>): { data?: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const errors: Array<{ message: string }> = [];
  const forge = ctx.forge;
  const data: Record<string, unknown> = {};

  /** Resolve a payload selection like `issue { number id }` against a payload object. */
  const pickPayload = (payload: Record<string, unknown>, field: FieldNode): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const sub of field.selection) {
      const key = sub.alias ?? sub.name;
      const value = payload[sub.name];
      if (value === undefined) {
        errors.push({ message: `Cannot query field "${sub.name}" on this payload.` });
        continue;
      }
      if (sub.selection.length === 0) {
        out[key] = value;
        continue;
      }
      if (isRecord(value) && typeof value.__typename === 'string') {
        out[key] = executeSelection(ctx, value as Source, sub.selection, variables, errors);
        continue;
      }
      if (isRecord(value)) {
        out[key] = pickPayload(value, sub);
        continue;
      }
      out[key] = value;
    }
    return out;
  };

  for (const field of operation.fields) {
    const args: Record<string, unknown> = {};
    for (const [key, node] of Object.entries(field.args)) args[key] = resolveValue(node, variables);
    const input = isRecord(args.input) ? args.input : {};
    const key = field.alias ?? field.name;
    try {
      if (field.name === 'createIssue') {
        const found = forge.findByGlobalId(String(input.repositoryId ?? ''));
        if (!found || found.kind !== 'R') throw new ExecutionError('repository not found');
        const created = forge.createIssue(found.repo, String(input.title ?? ''), String(input.body ?? ''), []);
        if (created.error || !created.issue) throw new ExecutionError(created.error ?? 'could not create issue');
        const issue = issueSource(forge, found.repo, created.issue);
        data[key] = field.selection.length
          ? pickPayload({ __typename: 'CreateIssuePayload', issue }, field)
          : {};
      } else if (field.name === 'closeIssue') {
        const found = forge.findByGlobalId(String(input.issueId ?? ''));
        if (!found || found.kind !== 'I' || !found.issue) throw new ExecutionError('issue not found');
        found.issue.state = 'closed';
        found.issue.updatedSeq = forge.stamp();
        const issue = issueSource(forge, found.repo, found.issue);
        data[key] = field.selection.length
          ? pickPayload({ __typename: 'CloseIssuePayload', issue }, field)
          : {};
      } else if (field.name === 'createPullRequest') {
        const found = forge.findByGlobalId(String(input.repositoryId ?? ''));
        if (!found || found.kind !== 'R') throw new ExecutionError('repository not found');
        const created = forge.createPull(found.repo, {
          head: String(input.headRefName ?? ''),
          base: String(input.baseRefName ?? ''),
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
        });
        if (created.error || !created.pull) throw new ExecutionError(created.error ?? 'could not create pull request');
        const pull = pullSource(forge, found.repo, created.pull);
        data[key] = field.selection.length
          ? pickPayload({ __typename: 'CreatePullRequestPayload', pullRequest: pull }, field)
          : {};
      } else if (field.name === 'mergePullRequest') {
        const found = forge.findByGlobalId(String(input.pullRequestId ?? ''));
        if (!found || found.kind !== 'P' || !found.pull) throw new ExecutionError('pull request not found');
        const merged = forge.mergePull(found.repo, found.pull);
        if (merged.error) throw new ExecutionError(merged.error);
        const pull = pullSource(forge, found.repo, found.pull);
        data[key] = field.selection.length
          ? pickPayload({ __typename: 'MergePullRequestPayload', pullRequest: pull }, field)
          : {};
      } else if (field.name === 'addComment') {
        const found = forge.findByGlobalId(String(input.subjectId ?? ''));
        if (!found || found.kind !== 'I' || !found.issue) throw new ExecutionError('issue not found');
        const created = forge.addComment(found.repo, found.issue.number, String(input.body ?? ''));
        if (created.error || !created.comment) throw new ExecutionError(created.error ?? 'could not add comment');
        const node: Source = {
          __typename: 'IssueComment',
          id: forge.commentGlobalId(found.repo, found.issue, created.comment),
          body: created.comment.body,
        };
        data[key] = field.selection.length
          ? pickPayload({
              __typename: 'AddCommentPayload',
              commentEdge: { __typename: 'IssueCommentEdge', node },
            }, field)
          : {};
      } else {
        errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
      }
    } catch (err) {
      if (err instanceof ExecutionError) {
        errors.push({ message: err.message });
      } else {
        errors.push({ message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  if (errors.length) return { data: null, errors };
  return { data };
}

// -------------------------------------------------------------------------------------------
// entry point
// -------------------------------------------------------------------------------------------

export function handleGraphQL(forge: Forge, bodyText: string): { status: number; body: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: JSON.stringify({ errors: [{ message: 'request body is not valid JSON' }] }) };
  }
  const ctx: GqlCtx = { forge };
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { errors: [{ message: 'expected a GraphQL operation object with a query string' }] };
    }
    const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
    let operations: Operation[];
    try {
      operations = new Parser(tokenize(entry.query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    let operation: Operation | undefined;
    if (typeof entry.operationName === 'string' && entry.operationName !== '') {
      operation = operations.find((candidate) => candidate.name === entry.operationName);
    }
    operation ??= operations[0];
    if (!operation) return { errors: [{ message: 'the document holds no operation' }] };
    try {
      return executeOperation(ctx, operation, variables);
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(parsed)) {
    return { status: 200, body: JSON.stringify(parsed.map(runOne)) };
  }
  return { status: 200, body: JSON.stringify(runOne(parsed)) };
}
