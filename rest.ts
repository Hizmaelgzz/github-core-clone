// rest.ts — the GitHub REST v3 surface (/api/v3).
// Every reply is application/json; 4xx bodies carry {"message": string}; every reply
// carries X-GitHub-Request-Id (set by app.ts). Auth is checked by app.ts before dispatch.

import {
  DEFAULT_BRANCH,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { parseCommit, parseTree } from './gitcore.ts';

export interface RestCtx {
  method: string;
  query: URLSearchParams;
  host: string;
  bodyText: string;
}

export interface RestReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function reply(status: number, value: unknown, headers: Record<string, string> = {}): RestReply {
  return { status, headers, body: JSON.stringify(value) };
}

function fail(status: number, message: string): RestReply {
  return reply(status, { message });
}

function parseJsonBody(ctx: RestCtx): { ok: true; value: Record<string, unknown> } | { ok: false; reply: RestReply } {
  if (ctx.bodyText.trim() === '') return { ok: true, value: {} };
  try {
    const value = JSON.parse(ctx.bodyText) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reply: fail(400, 'request body must be a JSON object') };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, reply: fail(400, 'malformed JSON body') };
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function intParam(ctx: RestCtx, name: string, fallback: number): number {
  const raw = ctx.query.get(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function pageLinks(ctx: RestCtx, basePath: string, page: number, perPage: number, hasNext: boolean, hasPrev: boolean, lastPage: number): string | null {
  const origin = `http://${ctx.host}`;
  const url = (p: number): string => `${origin}${basePath}?per_page=${perPage}&page=${p}`;
  const parts: string[] = [];
  if (hasNext) parts.push(`<${url(page + 1)}>; rel="next"`);
  if (hasPrev) parts.push(`<${url(page - 1)}>; rel="prev"`);
  parts.push(`<${url(1)}>; rel="first"`);
  parts.push(`<${url(Math.max(1, lastPage))}>; rel="last"`);
  return parts.join(', ');
}

function paginate<T>(ctx: RestCtx, basePath: string, items: readonly T[]): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.min(100, intParam(ctx, 'per_page', 30));
  const page = intParam(ctx, 'page', 1);
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const link = pageLinks(ctx, basePath, page, perPage, start + perPage < items.length, page > 1, lastPage);
  return { page: [...slice], headers: link === null ? {} : { link } };
}

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: forge.repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    created_at: forge.iso(repo.createdSeq),
    updated_at: forge.iso(repo.createdSeq),
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

function labelJson(label: { name: string; color: string }): Record<string, unknown> {
  return { name: label.name, color: label.color };
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: forge.issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: forge.iso(issue.createdSeq),
    updated_at: forge.iso(issue.updatedSeq),
    comments: issue.comments.length,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: forge.pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: forge.iso(pull.createdSeq),
    updated_at: forge.iso(pull.createdSeq),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function splitIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: '' };
  return { name: match[1]!, email: match[2]!, date: new Date(Number.parseInt(match[3]!, 10) * 1000).toISOString() };
}

function commitJson(forge: Forge, repo: Repo, sha: string): Record<string, unknown> | null {
  const info = forge.commitInfo(repo, sha);
  if (!info) return null;
  const author = splitIdentity(info.author);
  const committer = splitIdentity(info.committer);
  const object = repo.objects.get(sha);
  const parents = object && object.type === 'commit' ? parseCommit(object.data).parents : [];
  return {
    sha,
    commit: {
      message: info.message,
      author,
      committer,
      tree: { sha: object && object.type === 'commit' ? parseCommit(object.data).tree : '' },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: parents.map((parent) => ({ sha: parent })),
  };
}

/** Route /api/v3/...; segments are the decoded path parts after /api/v3. */
export function handleRest(forge: Forge, segments: string[], ctx: RestCtx): RestReply {
  const [first, second, third, ...rest] = segments;

  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (ctx.method !== 'GET') return fail(405, 'Method Not Allowed');
    return reply(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      meta_url: '/api/v3/meta',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (first === 'meta') {
    if (ctx.method !== 'GET') return fail(405, 'Method Not Allowed');
    return reply(200, { installed_version: '1.0.0' });
  }

  if (first === 'user' && segments.length === 1) {
    if (ctx.method !== 'GET') return fail(405, 'Method Not Allowed');
    return reply(200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      node_id: 'VXNlcjoxMDAw',
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      type: 'User',
    });
  }

  if (first === 'user' && second === 'repos') {
    if (ctx.method === 'POST') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return parsed.reply;
      const name = str(parsed.value.name);
      const created = forge.createRepo(name, bool(parsed.value.private, false), str(parsed.value.description));
      if (created.error) return fail(422, created.error);
      return reply(201, repoJson(forge, created.repo!));
    }
    if (ctx.method === 'GET') {
      const repos = forge.listViewerRepos();
      const { page, headers } = paginate(ctx, '/api/v3/user/repos', repos);
      return reply(200, page.map((repo) => repoJson(forge, repo)), headers);
    }
    return fail(405, 'Method Not Allowed');
  }

  if (first !== 'repos' || second === undefined || third === undefined) {
    return fail(404, 'Not Found');
  }

  const owner = second;
  const repoName = third;
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return fail(404, 'Not Found');

  // /repos/{o}/{r} itself.
  if (rest.length === 0) {
    if (ctx.method === 'GET') return reply(200, repoJson(forge, repo));
    if (ctx.method === 'PATCH') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return parsed.reply;
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value.private === 'boolean') repo.isPrivate = parsed.value.private;
      return reply(200, repoJson(forge, repo));
    }
    if (ctx.method === 'DELETE') {
      forge.deleteRepo(owner, repoName);
      return { status: 204, headers: {}, body: '' };
    }
    return fail(405, 'Method Not Allowed');
  }

  const [sub, ...tail] = rest;
  if (sub === 'branches') {
    if (tail.length === 0) {
      if (ctx.method !== 'GET') return fail(405, 'Method Not Allowed');
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .sort()
        .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) }, protected: false }));
      return reply(200, branches);
    }
    const branch = tail.join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (ctx.method === 'GET') {
      if (sha === undefined) return fail(404, 'Not Found');
      return reply(200, { name: branch, commit: { sha }, protected: false });
    }
    return fail(405, 'Method Not Allowed');
  }

  if (sub === 'git' && tail[0] === 'refs') {
    if (ctx.method === 'POST' && tail.length === 1) {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return parsed.reply;
      const ref = str(parsed.value.ref);
      const sha = str(parsed.value.sha);
      if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return fail(422, 'invalid ref');
      if (repo.refs.has(ref)) return fail(422, 'Reference already exists');
      const object = repo.objects.get(sha);
      if (!object || object.type !== 'commit') return fail(422, 'object does not exist or is not a commit');
      repo.refs.set(ref, sha);
      return reply(201, { ref, object: { sha, type: 'commit' } });
    }
    if (ctx.method === 'GET' && tail[1] === 'heads' && tail.length === 3) {
      const branch = tail[2]!;
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return fail(404, 'Not Found');
      return reply(200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
    }
    return fail(404, 'Not Found');
  }

  if (sub === 'commits') {
    if (ctx.method !== 'GET') return fail(405, 'Method Not Allowed');
    const ref = ctx.query.get('sha') ?? repo.defaultBranch;
    const tip = forge.resolveRef(repo, ref);
    if (tip === undefined) return reply(200, []);
    const commits = forge.listCommits(repo, tip);
    const out: Record<string, unknown>[] = [];
    for (const sha of commits) {
      const entry = commitJson(forge, repo, sha);
      if (entry) out.push(entry);
    }
    return reply(200, out);
  }

  if (sub === 'contents') {
    const path = tail.join('/');
    const ref = ctx.query.get('ref') ?? repo.defaultBranch;
    if (ctx.method === 'PUT') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return parsed.reply;
      const content = str(parsed.value.content);
      const message = str(parsed.value.message) || 'update file';
      const branch = str(parsed.value.branch) || repo.defaultBranch;
      const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
      let bytes: Buffer;
      try {
        bytes = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
      } catch {
        return fail(422, 'content is not valid base64');
      }
      const result = forge.commitFile(repo, { branch, path, content: bytes, message, sha });
      if (result.error) return fail(result.status, result.error);
      return reply(result.status, {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: result.blobSha,
          size: bytes.length,
          type: 'file',
          encoding: 'base64',
          content: bytes.toString('base64'),
        },
        commit: { sha: result.commitSha, message },
      });
    }
    if (ctx.method === 'DELETE') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return parsed.reply;
      const message = str(parsed.value.message) || 'delete file';
      const sha = str(parsed.value.sha);
      const branch = str(parsed.value.branch) || repo.defaultBranch;
      const result = forge.deleteFile(repo, { branch, path, message, sha });
      if (result.error) return fail(result.status, result.error);
      return reply(200, { commit: { sha: result.commitSha, message } });
    }
    if (ctx.method !== 'GET') return fail(405, 'Method Not Allowed');
    const tip = forge.resolveRef(repo, ref);
    if (tip === undefined) return fail(404, 'Not Found');
    const tipObject = repo.objects.get(tip);
    if (!tipObject || tipObject.type !== 'commit') return fail(404, 'Not Found');
    const treeOid = parseCommit(tipObject.data).tree;
    if (path === '') {
      const entries = forge.listDir(repo, treeOid, '');
      if (entries === null) return fail(404, 'Not Found');
      return reply(200, entries.map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: entry.name,
        sha: entry.oid,
        size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
      })));
    }
    const found = forge.lookupPath(repo, treeOid, path);
    if (found === null) {
      const dirEntries = forge.listDir(repo, treeOid, path);
      if (dirEntries === null) return fail(404, 'Not Found');
      return reply(200, dirEntries.map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: `${path}/${entry.name}`,
        sha: entry.oid,
        size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
      })));
    }
    if (found.mode === '40000') {
      const dirEntries = forge.listDir(repo, treeOid, path);
      if (dirEntries === null) return fail(404, 'Not Found');
      return reply(200, dirEntries.map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: `${path}/${entry.name}`,
        sha: entry.oid,
        size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
      })));
    }
    const blob = repo.objects.get(found.oid);
    if (!blob) return fail(404, 'Not Found');
    return reply(200, {
      type: 'file',
      encoding: 'base64',
      content: blob.data.toString('base64'),
      sha: found.oid,
      size: blob.data.length,
      name: path.split('/').pop() ?? path,
      path,
    });
  }

  if (sub === 'labels') {
    if (ctx.method === 'POST') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return parsed.reply;
      const name = str(parsed.value.name);
      const color = str(parsed.value.color) || 'ededed';
      if (name === '') return fail(422, 'label name is required');
      const created = forge.createLabel(repo, name, color);
      if (created.error) return fail(created.status, created.error);
      return reply(201, { name: created.label!.name, color: created.label!.color });
    }
    if (ctx.method === 'GET') {
      return reply(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    }
    return fail(405, 'Method Not Allowed');
  }

  if (sub === 'issues') {
    if (tail.length === 0) {
      if (ctx.method === 'POST') {
        const parsed = parseJsonBody(ctx);
        if (!parsed.ok) return parsed.reply;
        const title = str(parsed.value.title);
        const body = str(parsed.value.body);
        const labels = Array.isArray(parsed.value.labels) ? parsed.value.labels.filter((entry): entry is string => typeof entry === 'string') : [];
        if (title === '') return fail(422, 'title is required');
        const created = forge.createIssue(repo, title, body, labels);
        if (created.error) return fail(created.status, created.error);
        return reply(201, issueJson(forge, repo, created.issue!));
      }
      if (ctx.method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const direction = ctx.query.get('direction') === 'asc' ? 'asc' : 'desc';
        const issues = forge.listIssues(repo, state, direction);
        const { page, headers } = paginate(ctx, `/api/v3/repos/${owner}/${repoName}/issues`, issues);
        return reply(200, page.map((issue) => issueJson(forge, repo, issue)), headers);
      }
      return fail(405, 'Method Not Allowed');
    }
    const number = Number.parseInt(tail[0]!, 10);
    if (!Number.isInteger(number) || number < 1) return fail(404, 'Not Found');
    if (tail[1] === 'comments') {
      const issue = repo.issues.get(number);
      if (!issue) return fail(404, 'Not Found');
      if (ctx.method === 'POST') {
        const parsed = parseJsonBody(ctx);
        if (!parsed.ok) return parsed.reply;
        const created = forge.addComment(repo, number, str(parsed.value.body));
        if (created.error) return fail(created.status, created.error);
        const comment = created.comment!;
        return reply(201, {
          id: comment.id,
          node_id: forge.commentGlobalId(repo, issue, comment),
          body: comment.body,
          user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
          created_at: forge.iso(comment.createdSeq),
          updated_at: forge.iso(comment.createdSeq),
        });
      }
      if (ctx.method === 'GET') {
        return reply(200, issue.comments.map((comment) => ({
          id: comment.id,
          node_id: forge.commentGlobalId(repo, issue, comment),
          body: comment.body,
          user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
          created_at: forge.iso(comment.createdSeq),
          updated_at: forge.iso(comment.createdSeq),
        })));
      }
      return fail(405, 'Method Not Allowed');
    }
    if (tail.length > 1) return fail(404, 'Not Found');
    const issue = repo.issues.get(number);
    if (!issue) return fail(404, 'Not Found');
    if (ctx.method === 'GET') return reply(200, issueJson(forge, repo, issue));
    if (ctx.method === 'PATCH') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return parsed.reply;
      if (parsed.value.state === 'open' || parsed.value.state === 'closed') issue.state = parsed.value.state;
      if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
      issue.updatedSeq = forge.stamp();
      return reply(200, issueJson(forge, repo, issue));
    }
    return fail(405, 'Method Not Allowed');
  }

  if (sub === 'pulls') {
    if (tail.length === 0) {
      if (ctx.method === 'POST') {
        const parsed = parseJsonBody(ctx);
        if (!parsed.ok) return parsed.reply;
        const created = forge.createPull(repo, {
          head: str(parsed.value.head),
          base: str(parsed.value.base) || repo.defaultBranch,
          title: str(parsed.value.title),
          body: str(parsed.value.body),
        });
        if (created.error) return fail(created.status, created.error);
        return reply(201, pullJson(forge, repo, created.pull!));
      }
      if (ctx.method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const pulls = forge.listPulls(repo, state);
        const { page, headers } = paginate(ctx, `/api/v3/repos/${owner}/${repoName}/pulls`, pulls);
        return reply(200, page.map((pull) => pullJson(forge, repo, pull)), headers);
      }
      return fail(405, 'Method Not Allowed');
    }
    const number = Number.parseInt(tail[0]!, 10);
    if (!Number.isInteger(number) || number < 1) return fail(404, 'Not Found');
    const pull = repo.pulls.get(number);
    if (!pull) return fail(404, 'Not Found');
    if (tail[1] === 'files') {
      if (ctx.method !== 'GET') return fail(405, 'Method Not Allowed');
      return reply(200, forge.pullFiles(repo, pull));
    }
    if (tail[1] === 'merge') {
      if (ctx.method !== 'PUT') return fail(405, 'Method Not Allowed');
      const merged = forge.mergePull(repo, pull);
      if (merged.error) return fail(merged.status, merged.error);
      return reply(200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
    }
    if (tail.length > 1) return fail(404, 'Not Found');
    if (ctx.method === 'GET') return reply(200, pullJson(forge, repo, pull));
    return fail(405, 'Method Not Allowed');
  }

  return fail(404, 'Not Found');
}

export { DEFAULT_BRANCH };
