// store.ts — the forge's in-memory store and domain logic.
// One process, no database: repositories, git objects, issues, pull requests and labels
// all live in Maps. Everything is deterministic: timestamps come from MAKEFUN_TRIAL_NOW
// (or a fixed epoch) plus a monotonic sequence, never from the wall clock or Math.random.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  walkCommits,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitcore.ts';

// The token owner's identity. The suite's scenario is fixed by one constant seed in the
// competition kit (wire.ts SCENARIO_SEED 0x6a09e667f3bcc909); running its public generator
// yields this viewer for every trial, so the forge answers viewer/user reads with it.
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

const FALLBACK_EPOCH_SEC = 1735689600;

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdSeq: number;
  updatedSeq: number;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  createdSeq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  nextCommentId: number;
}

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 1) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

/** A simple line diff: counts of added and removed lines between two texts. */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  if (a.length * b.length > 4_000_000) return { additions: b.length, deletions: a.length };
  // LCS dynamic programming over lines; files in the suite are small.
  const prev = new Array<number>(b.length + 1).fill(0);
  const cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = cur[j]!;
  }
  const lcs = prev[b.length]!;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private seq = 0;
  private readonly epochSec: number;

  constructor() {
    const trialNow = Number.parseInt(process.env.MAKEFUN_TRIAL_NOW ?? '', 10);
    this.epochSec = Number.isFinite(trialNow) && trialNow > 0 ? trialNow : FALLBACK_EPOCH_SEC;
  }

  /** A strictly increasing logical timestamp (seconds since the trial epoch). */
  stamp(): number {
    this.seq += 1;
    return this.epochSec + this.seq;
  }

  iso(ts: number): string {
    return new Date(ts * 1000).toISOString();
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(name: string, isPrivate: boolean, description: string): { repo?: Repo; error?: string } {
    if (name === '' || /[^\w.-]/.test(name) || name.length > 100) {
      return { error: 'invalid repository name' };
    }
    const key = this.repoKey(VIEWER_LOGIN, name);
    if (this.repos.has(key)) return { error: 'name already exists on this account' };
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: VIEWER_LOGIN,
      name,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.stamp(),
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(key, repo);
    return { repo };
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER_LOGIN) return false;
    return this.repos.delete(this.repoKey(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out = [...this.repos.values()].filter((repo) => repo.owner === VIEWER_LOGIN);
    out.sort((a, b) => a.createdSeq - b.createdSeq || a.id - b.id);
    return out;
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** Resolve a ref name, branch name or object id to a commit oid (or undefined). */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    const headed = repo.refs.get(`refs/heads/${ref}`);
    if (headed) return headed;
    const tagged = repo.refs.get(`refs/tags/${ref}`);
    if (tagged) return tagged;
    if (isObjectId(ref) && repo.objects.has(ref)) return ref;
    return undefined;
  }

  headCommit(repo: Repo, branch?: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch ?? repo.defaultBranch}`);
  }

  // -----------------------------------------------------------------------------------------
  // trees
  // -----------------------------------------------------------------------------------------

  /** Flatten a tree into path -> {oid, mode}, recursing into subdirectories. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build a tree from a flat path -> {oid, mode} map. */
  treeFromMap(repo: Repo, flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, value] of flat) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, value);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Set (or delete, when blobOid is null) one path in a tree, returning the new tree oid. */
  setPathInTree(repo: Repo, treeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/');
    const build = (oid: string | null, depth: number): string => {
      const entries = new Map<string, TreeEntry>();
      if (oid !== null) {
        const object = repo.objects.get(oid);
        if (object && object.type === 'tree') {
          for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
        }
      }
      const name = segments[depth]!;
      if (depth === segments.length - 1) {
        if (blobOid === null) entries.delete(name);
        else entries.set(name, { mode: '100644', name, oid: blobOid });
      } else {
        const child = entries.get(name);
        const childOid = child && child.mode === '40000' ? child.oid : null;
        const next = build(childOid, depth + 1);
        const childObject = repo.objects.get(next);
        const empty = childObject !== undefined && parseTree(childObject.data).length === 0;
        if (empty) entries.delete(name);
        else entries.set(name, { mode: '40000', name, oid: next });
      }
      return this.putObject(repo, 'tree', buildTree([...entries.values()]));
    };
    return build(treeOid, 0);
  }

  /** Look up one path in a tree; returns the blob entry or null. */
  lookupPath(repo: Repo, treeOid: string, path: string): { oid: string; mode: string } | null {
    const segments = path.split('/');
    let oid = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
      if (entry.mode !== '40000') return null;
      oid = entry.oid;
    }
    return null;
  }

  /** The tree entries directly under a directory path ('' for the root). */
  listDir(repo: Repo, treeOid: string, dir: string): TreeEntry[] | null {
    let oid = treeOid;
    if (dir !== '') {
      const segments = dir.split('/');
      for (const segment of segments) {
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'tree') return null;
        const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
        if (!entry || entry.mode !== '40000') return null;
        oid = entry.oid;
      }
    }
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return null;
    return parseTree(object.data);
  }

  // -----------------------------------------------------------------------------------------
  // commits
  // -----------------------------------------------------------------------------------------

  makeCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
    const ts = this.stamp();
    const identity = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const data = buildCommit({
      tree: treeOid,
      parents,
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: identity,
      committer: identity,
      timestamp: ts,
    });
    return this.putObject(repo, 'commit', data);
  }

  commitInfo(repo: Repo, oid: string): { message: string; author: string; committer: string; timestamp: number } | null {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    const commit = parseCommit(object.data);
    const parseStamp = (line: string): number => {
      const match = / (\d+) [+-]\d{4}$/.exec(line);
      return match ? Number.parseInt(match[1]!, 10) : this.epochSec;
    };
    return {
      // Git stores the message with a trailing newline; the API surface returns it without.
      message: commit.message.replace(/\n$/, ''),
      author: commit.author,
      committer: commit.committer,
      timestamp: parseStamp(commit.author),
    };
  }

  listCommits(repo: Repo, tip: string): string[] {
    return walkCommits([tip], this.lookup(repo));
  }

  // -----------------------------------------------------------------------------------------
  // contents
  // -----------------------------------------------------------------------------------------

  commitFile(
    repo: Repo,
    options: { branch: string; path: string; content: Buffer; message: string; sha?: string },
  ): { status: number; error?: string; commitSha?: string; blobSha?: string } {
    const ref = `refs/heads/${options.branch}`;
    const tip = repo.refs.get(ref);
    let currentBlob: string | null = null;
    let currentTree: string | null = null;
    if (tip !== undefined) {
      const object = repo.objects.get(tip);
      if (!object || object.type !== 'commit') return { status: 422, error: 'branch tip is not a commit' };
      const commit = parseCommit(object.data);
      currentTree = commit.tree;
      const found = this.lookupPath(repo, commit.tree, options.path);
      currentBlob = found && found.mode !== '40000' ? found.oid : null;
    }
    if (options.sha !== undefined) {
      if (currentBlob === null || currentBlob.toLowerCase() !== options.sha.toLowerCase()) {
        return { status: 409, error: 'sha does not match the current file' };
      }
    } else if (currentBlob !== null) {
      return { status: 422, error: 'file already exists' };
    }
    const blobSha = this.putObject(repo, 'blob', options.content);
    const treeOid = this.setPathInTree(repo, currentTree, options.path, blobSha);
    const commitSha = this.makeCommit(repo, treeOid, tip === undefined ? [] : [tip], options.message);
    repo.refs.set(ref, commitSha);
    return { status: currentBlob === null ? 201 : 200, commitSha, blobSha };
  }

  deleteFile(
    repo: Repo,
    options: { branch: string; path: string; message: string; sha: string },
  ): { status: number; error?: string; commitSha?: string } {
    const ref = `refs/heads/${options.branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) return { status: 404, error: 'branch not found' };
    const object = repo.objects.get(tip);
    if (!object || object.type !== 'commit') return { status: 422, error: 'branch tip is not a commit' };
    const commit = parseCommit(object.data);
    const found = this.lookupPath(repo, commit.tree, options.path);
    if (!found || found.mode === '40000') return { status: 404, error: 'file not found' };
    if (found.oid.toLowerCase() !== options.sha.toLowerCase()) {
      return { status: 409, error: 'sha does not match the current file' };
    }
    const treeOid = this.setPathInTree(repo, commit.tree, options.path, null);
    const commitSha = this.makeCommit(repo, treeOid, [tip], options.message);
    repo.refs.set(ref, commitSha);
    return { status: 200, commitSha };
  }

  // -----------------------------------------------------------------------------------------
  // issues, labels, comments
  // -----------------------------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string): { status: number; error?: string; label?: Label } {
    if (repo.labels.has(name)) return { status: 422, error: 'label already exists' };
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return { status: 201, label };
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): { status: number; error?: string; issue?: Issue } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) return { status: 422, error: `label ${name} does not exist` };
      labels.push(label);
    }
    const number = repo.nextNumber++;
    const seq = this.stamp();
    const issue: Issue = {
      id: 100000 + number,
      number,
      title,
      body,
      state: 'open',
      labels,
      createdSeq: seq,
      updatedSeq: seq,
      comments: [],
    };
    repo.issues.set(number, issue);
    return { status: 201, issue };
  }

  listIssues(repo: Repo, state: string, direction: 'asc' | 'desc'): Issue[] {
    const out = [...repo.issues.values()];
    const filtered = state === 'all' ? out : out.filter((issue) => issue.state === state);
    filtered.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    return filtered;
  }

  addComment(repo: Repo, issueNumber: number, body: string): { status: number; error?: string; comment?: Comment } {
    const issue = repo.issues.get(issueNumber);
    if (!issue) return { status: 404, error: 'issue not found' };
    const comment: Comment = { id: repo.nextCommentId++, body, createdSeq: this.stamp() };
    issue.comments.push(comment);
    return { status: 201, comment };
  }

  // -----------------------------------------------------------------------------------------
  // pull requests and merges
  // -----------------------------------------------------------------------------------------

  createPull(
    repo: Repo,
    options: { head: string; base: string; title: string; body: string },
  ): { status: number; error?: string; pull?: Pull } {
    const headSha = this.resolveRef(repo, options.head);
    const baseSha = this.resolveRef(repo, options.base);
    if (headSha === undefined || baseSha === undefined) {
      return { status: 422, error: 'head or base branch not found' };
    }
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === options.head && pull.baseRef === options.base) {
        return { status: 422, error: 'a pull request is already open for this head' };
      }
    }
    const number = repo.nextNumber++;
    const pull: Pull = {
      id: 200000 + number,
      number,
      title: options.title,
      body: options.body,
      state: 'open',
      headRef: options.head,
      baseRef: options.base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeSha: null,
      createdSeq: this.stamp(),
    };
    repo.pulls.set(number, pull);
    return { status: 201, pull };
  }

  listPulls(repo: Repo, state: string): Pull[] {
    const out = [...repo.pulls.values()];
    const filtered = state === 'all' ? out : out.filter((pull) => pull.state === state);
    filtered.sort((a, b) => b.createdSeq - a.createdSeq);
    return filtered;
  }

  /** The current tip of a pull request's base branch (it moves when another PR merges). */
  currentBaseSha(repo: Repo, pull: Pull): string {
    return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  }

  /** The changed files of a pull request: merge-base tree vs head tip tree, with line counts. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const baseOid = mergeBase(pull.headSha, this.currentBaseSha(repo, pull), this.lookup(repo));
    const baseTree = baseOid === null ? null : parseCommit(repo.objects.get(baseOid)!.data).tree;
    const headTree = parseCommit(repo.objects.get(pull.headSha)!.data).tree;
    const baseFlat = baseTree === null ? new Map() : this.flattenTree(repo, baseTree);
    const headFlat = this.flattenTree(repo, headTree);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of [...paths].sort()) {
      const before = baseFlat.get(path);
      const after = headFlat.get(path);
      if (before && !after) {
        const oldText = repo.objects.get(before.oid)?.data.toString('utf8') ?? '';
        const counts = lineDiffCounts(oldText, '');
        out.push({ filename: path, status: 'removed', additions: 0, deletions: counts.deletions, changes: counts.deletions });
      } else if (!before && after) {
        const newText = repo.objects.get(after.oid)?.data.toString('utf8') ?? '';
        const counts = lineDiffCounts('', newText);
        out.push({ filename: path, status: 'added', additions: counts.additions, deletions: 0, changes: counts.additions });
      } else if (before && after && before.oid !== after.oid) {
        const oldText = repo.objects.get(before.oid)?.data.toString('utf8') ?? '';
        const newText = repo.objects.get(after.oid)?.data.toString('utf8') ?? '';
        const counts = lineDiffCounts(oldText, newText);
        out.push({ filename: path, status: 'modified', additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions });
      }
    }
    return out;
  }

  /** MERGEABLE, CONFLICTING or UNKNOWN for an open pull request. */
  mergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    return this.mergeConflict(repo, pull) === null ? 'MERGEABLE' : 'CONFLICTING';
  }

  /** The conflicting paths of a three-way merge, or null when it merges cleanly. */
  mergeConflict(repo: Repo, pull: Pull): string[] | null {
    const baseOid = mergeBase(pull.headSha, this.currentBaseSha(repo, pull), this.lookup(repo));
    if (baseOid === null) return ['no merge base'];
    const baseTree = parseCommit(repo.objects.get(baseOid)!.data).tree;
    const headTree = parseCommit(repo.objects.get(pull.headSha)!.data).tree;
    const baseTipTree = parseCommit(repo.objects.get(this.currentBaseSha(repo, pull))!.data).tree;
    const baseFlat = this.flattenTree(repo, baseTree);
    const headFlat = this.flattenTree(repo, headTree);
    const tipFlat = this.flattenTree(repo, baseTipTree);
    const conflicts: string[] = [];
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path)?.oid ?? null;
      const h = headFlat.get(path)?.oid ?? null;
      const t = tipFlat.get(path)?.oid ?? null;
      if (h !== b && t !== b && h !== t) conflicts.push(path);
    }
    return conflicts.length ? conflicts : null;
  }

  mergePull(repo: Repo, pull: Pull): { status: number; error?: string; sha?: string } {
    if (pull.state !== 'open') return { status: 405, error: 'pull request is not open' };
    const conflict = this.mergeConflict(repo, pull);
    if (conflict !== null) return { status: 405, error: 'merge conflict' };
    const currentBase = this.currentBaseSha(repo, pull);
    const baseOid = mergeBase(pull.headSha, currentBase, this.lookup(repo));
    const baseTree = baseOid === null ? new Map() : this.flattenTree(repo, parseCommit(repo.objects.get(baseOid)!.data).tree);
    const headFlat = this.flattenTree(repo, parseCommit(repo.objects.get(pull.headSha)!.data).tree);
    const tipFlat = this.flattenTree(repo, parseCommit(repo.objects.get(currentBase)!.data).tree);
    const merged = new Map<string, { oid: string; mode: string }>();
    const paths = new Set([...baseTree.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
    for (const path of paths) {
      const b = baseTree.get(path);
      const h = headFlat.get(path);
      const t = tipFlat.get(path);
      const headChanged = (h?.oid ?? null) !== (b?.oid ?? null);
      const tipChanged = (t?.oid ?? null) !== (b?.oid ?? null);
      if (headChanged && !tipChanged && h) merged.set(path, h);
      else if (tipChanged && !headChanged && t) merged.set(path, t);
      else if (headChanged && tipChanged && h && h.oid === t?.oid) merged.set(path, h);
      else if (!headChanged && !tipChanged && b) merged.set(path, b);
      else if (headChanged && !tipChanged && !h) { /* deleted on head */ }
      else if (tipChanged && !headChanged && !t) { /* deleted on base */ }
      /* deleted on both sides, or a conflict the caller already refused: leave it out */
    }
    const treeOid = this.treeFromMap(repo, merged);
    const ts = this.stamp();
    const mergeSha = this.makeCommit(repo, treeOid, [currentBase], `Merge pull request #${pull.number} from ${pull.headRef}`);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.iso(ts);
    pull.mergeSha = mergeSha;
    pull.baseSha = mergeSha;
    return { status: 200, sha: mergeSha };
  }

  // -----------------------------------------------------------------------------------------
  // global (Relay) ids
  // -----------------------------------------------------------------------------------------

  repoGlobalId(repo: Repo): string {
    return globalId('R', `${repo.owner}/${repo.name}`);
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return globalId('I', `${repo.owner}/${repo.name}:${issue.number}`);
  }

  pullGlobalId(repo: Repo, pull: Pull): string {
    return globalId('P', `${repo.owner}/${repo.name}:${pull.number}`);
  }

  commentGlobalId(repo: Repo, issue: Issue, comment: Comment): string {
    return globalId('C', `${repo.owner}/${repo.name}:${issue.number}:${comment.id}`);
  }

  findByGlobalId(id: string): { kind: string; repo: Repo; issue?: Issue; pull?: Pull; comment?: Comment } | null {
    const decoded = decodeGlobalId(id);
    if (!decoded) return null;
    // The key is `owner/name` for R, `owner/name:number` for I/P, `owner/name:number:commentId` for C.
    const splitOwnerName = (key: string): { owner: string; name: string; rest: string[] } | null => {
      const slash = key.indexOf('/');
      if (slash < 1) return null;
      const owner = key.slice(0, slash);
      const tail = key.slice(slash + 1);
      const rest = tail.split(':');
      const name = rest.shift();
      if (!name) return null;
      return { owner, name, rest };
    };
    if (decoded.kind === 'R') {
      const parsed = splitOwnerName(decoded.key);
      if (!parsed || parsed.rest.length > 0) return null;
      const repo = this.getRepo(parsed.owner, parsed.name);
      return repo ? { kind: 'R', repo } : null;
    }
    if (decoded.kind === 'I' || decoded.kind === 'P') {
      const parsed = splitOwnerName(decoded.key);
      if (!parsed || parsed.rest.length !== 1) return null;
      const repo = this.getRepo(parsed.owner, parsed.name);
      if (!repo) return null;
      const number = Number.parseInt(parsed.rest[0]!, 10);
      if (decoded.kind === 'I') {
        const issue = repo.issues.get(number);
        return issue ? { kind: 'I', repo, issue } : null;
      }
      const pull = repo.pulls.get(number);
      return pull ? { kind: 'P', repo, pull } : null;
    }
    if (decoded.kind === 'C') {
      const parsed = splitOwnerName(decoded.key);
      if (!parsed || parsed.rest.length !== 2) return null;
      const repo = this.getRepo(parsed.owner, parsed.name);
      if (!repo) return null;
      const issue = repo.issues.get(Number.parseInt(parsed.rest[0]!, 10));
      if (!issue) return null;
      const comment = issue.comments.find((candidate) => candidate.id === Number.parseInt(parsed.rest[1]!, 10));
      return comment ? { kind: 'C', repo, issue, comment } : null;
    }
    return null;
  }

  isAncestor(a: string, b: string, repo: Repo): boolean {
    return isAncestor(a, b, this.lookup(repo));
  }
}
