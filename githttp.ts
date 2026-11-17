// githttp.ts — the git smart-HTTP protocol (/{owner}/{repo}.git/...).
// info/refs advertisements (v0 and v2), upload-pack (v0 and v2, incl. ls-refs, shallow fetch,
// wanted-refs, thin packs) and receive-pack (fast-forward enforcement, unpack report).
// Auth is checked by app.ts before dispatch.

import {
  collectReachable,
  decodePktLines,
  encodePktLine,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  pktDelim,
  pktFlush,
  readPack,
  shallowWalk,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitcore.ts';
import { DEFAULT_BRANCH, type Forge, type Repo } from './store.ts';

export interface GitCtx {
  method: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface GitReply {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function textReply(status: number, text: string): GitReply {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from(text, 'utf8') };
}

function headerValue(headers: GitCtx['headers'], name: string): string {
  const value = headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? '';
  return '';
}

interface RefLine {
  oid: string;
  ref: string;
  peeled?: string;
}

function sortedRefs(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const refs = [...repo.refs.keys()].sort();
  for (const ref of refs) {
    const oid = repo.refs.get(ref)!;
    const object = repo.objects.get(oid);
    const line: RefLine = { oid, ref };
    if (object && object.type === 'tag') {
      line.peeled = parseTag(object.data).object;
    }
    lines.push(line);
  }
  return lines;
}

const UPLOAD_CAPS =
  'agent=forge/1.0 symref=HEAD:refs/heads/main side-band-64k shallow thin-pack ofs-delta multi_ack_detailed object-format=sha1';
const RECEIVE_CAPS = 'agent=forge/1.0 report-status side-band-64k delete-refs ofs-delta';

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [];
  parts.push(encodePktLine(`# service=${service}\n`));
  parts.push(pktFlush());
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? refs[0]!.oid;
    parts.push(encodePktLine(`${headTip} HEAD\0${caps}\n`));
    for (const line of refs) {
      parts.push(encodePktLine(`${line.oid} ${line.ref}\n`));
      if (line.peeled) parts.push(encodePktLine(`${line.peeled} ${line.ref}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    encodePktLine('# service=git-upload-pack\n'),
    pktFlush(),
    encodePktLine('version 2\n'),
    encodePktLine('agent=forge/1.0\n'),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow\n'),
    encodePktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

function lsRefsV2(repo: Repo, options: { refPrefixes: string[] }): Buffer {
  const lines: string[] = [];
  const prefixes = options.refPrefixes;
  // With no prefix every ref is listed; with prefixes, a ref is listed when any prefix
  // matches it, and HEAD is listed when a prefix matches the literal name HEAD.
  const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => ref.startsWith(prefix));
  const headTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  if (matches('HEAD')) {
    if (headTip) lines.push(`${headTip} HEAD symref-target:refs/heads/${DEFAULT_BRANCH}`);
    else lines.push(`unborn HEAD symref-target:refs/heads/${DEFAULT_BRANCH}`);
  }
  for (const line of sortedRefs(repo)) {
    if (!matches(line.ref)) continue;
    let text = `${line.oid} ${line.ref}`;
    if (line.peeled) text += ` peeled:${line.peeled}`;
    lines.push(text);
  }
  const parts = lines.map((line) => encodePktLine(`${line}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

function sidebandPack(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += 65500) {
    const chunk = pack.subarray(offset, Math.min(offset + 65500, pack.length));
    chunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (chunks.length === 0) chunks.push(encodePktLine(Buffer.from([1])));
  return Buffer.concat(chunks);
}

function buildFetch(repo: Repo, request: FetchRequest): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // A `have` means the client holds that commit and its history — except below an old shallow
  // boundary, whose parents the client does NOT hold. Cut the walk there, or a deepen would
  // wrongly conclude the client already has the parent.
  const oldShallow = new Set(request.shallow);
  const haveClosure = new Set<string>();
  const queue = [...request.haves];
  const seen = new Set<string>();
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object) continue;
    haveClosure.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      for (const sub of collectReachable([commit.tree], lookup, true)) haveClosure.add(sub);
      if (!oldShallow.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  const depth = request.depth ?? Number.POSITIVE_INFINITY;
  const walked = shallowWalk(request.wants, depth, lookup, haveClosure, request.shallow);
  const objects: GitObject[] = [];
  for (const oid of walked.send) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  return { pack: writePack(objects), shallow: walked.boundary, unshallow: walked.unshallow };
}

function fetchV2Response(repo: Repo, request: FetchRequest): Buffer {
  const { pack, shallow, unshallow } = buildFetch(repo, request);
  const parts: Buffer[] = [];
  // The acknowledgments section answers the client's haves; a fetch with no haves
  // (a fresh clone) carries none, and git expects the next section instead.
  // 'ready' tells the client negotiation is done and the pack follows.
  if (request.haves.length > 0) {
    parts.push(encodePktLine('acknowledgments\n'));
    parts.push(encodePktLine('NAK\n'));
    parts.push(encodePktLine('ready\n'));
    parts.push(pktDelim());
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  const wantedRefs: RefLine[] = [];
  for (const want of request.wants) {
    for (const line of sortedRefs(repo)) {
      if (line.oid === want) wantedRefs.push(line);
    }
  }
  if (wantedRefs.length > 0) {
    parts.push(encodePktLine('wanted-refs\n'));
    for (const line of wantedRefs) parts.push(encodePktLine(`${line.oid} ${line.ref}\n`));
    parts.push(pktDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchV0Response(repo: Repo, request: FetchRequest): Buffer {
  const { pack, shallow, unshallow } = buildFetch(repo, request);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('NAK\n'));
  for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Parse a v2 request body into the command and its argument lines. */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  void seenDelim;
  const commandLine = lines.find((line) => line.startsWith('command='));
  const command = commandLine ? commandLine.slice('command='.length) : '';
  const args = lines.filter((line) => !line.startsWith('command=') && !line.startsWith('agent=') && !line.startsWith('object-format='));
  return { command, args };
}

function parseFetchArgs(args: readonly string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [] };
  for (const arg of args) {
    if (arg.startsWith('want ')) request.wants.push(arg.split(' ')[1]!);
    else if (arg.startsWith('have ')) request.haves.push(arg.split(' ')[1]!);
    else if (arg.startsWith('shallow ')) request.shallow.push(arg.split(' ')[1]!);
    else if (arg.startsWith('deepen ')) {
      const depth = Number.parseInt(arg.slice('deepen '.length), 10);
      if (Number.isFinite(depth) && depth > 0) request.depth = depth;
    }
  }
  return request;
}

/** Parse a v0 upload-pack request body. */
function parseV0Upload(body: Buffer): FetchRequest {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') continue;
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return parseFetchArgs(lines);
}

/** Split a receive-pack body into command lines and the raw pack that follows the flush. */
function splitReceivePack(body: Buffer): { commands: string[]; pack: Buffer } {
  let offset = 0;
  const commands: string[] = [];
  while (offset + 4 <= body.length) {
    const head = body.subarray(offset, offset + 4).toString('ascii');
    const length = Number.parseInt(head, 16);
    if (!Number.isFinite(length) || length < 0 || length === 3 || length > 65520) {
      throw new Error(`malformed receive-pack framing at offset ${offset}`);
    }
    if (length === 0) {
      offset += 4;
      break;
    }
    if (offset + length > body.length) throw new Error('truncated receive-pack command');
    commands.push(body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, ''));
    offset += length;
  }
  return { commands, pack: body.subarray(offset) };
}

/** Build the receive-pack status report: sideband band-1 packets of pkt-lined lines + flush. */
function statusReport(lines: string[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    const inner = encodePktLine(`${line}\n`);
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), inner])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: Repo, body: Buffer): Buffer {
  let commands: string[];
  let pack: Buffer;
  try {
    ({ commands, pack } = splitReceivePack(body));
  } catch (err) {
    return statusReport([`unpack ${err instanceof Error ? err.message : 'framing error'}`]);
  }
  const parsed: RefCommand[] = [];
  for (const raw of commands) {
    const beforeCaps = raw.split('\0')[0]!;
    const parts = beforeCaps.split(' ');
    if (parts.length < 3 || !isObjectId(parts[0]!) || !isObjectId(parts[1]!)) continue;
    parsed.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);

  if (pack.length > 0) {
    try {
      const read = readPack(pack, lookup);
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      const lines = [`unpack ${err instanceof Error ? err.message : 'pack error'}`];
      for (const command of parsed) lines.push(`ng ${command.ref} unpack error`);
      return statusReport(lines);
    }
  }

  const lines: string[] = ['unpack ok'];
  for (const command of parsed) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined || current !== command.oldOid) {
        lines.push(`ng ${command.ref} cannot delete`);
      } else {
        repo.refs.delete(command.ref);
        lines.push(`ok ${command.ref}`);
      }
    } else if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        lines.push(`ng ${command.ref} already exists`);
      } else if (!repo.objects.has(command.newOid)) {
        lines.push(`ng ${command.ref} unable to resolve`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        lines.push(`ok ${command.ref}`);
      }
    } else {
      // Update: must be a fast-forward from the advertised old value.
      if (current === undefined || current !== command.oldOid) {
        lines.push(`ng ${command.ref} non-fast-forward`);
      } else if (!repo.objects.has(command.newOid)) {
        lines.push(`ng ${command.ref} unable to resolve`);
      } else if (!isAncestor(command.oldOid, command.newOid, lookup)) {
        lines.push(`ng ${command.ref} non-fast-forward`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        lines.push(`ok ${command.ref}`);
      }
    }
  }
  return statusReport(lines);
}

export function handleGit(forge: Forge, segments: string[], ctx: GitCtx): GitReply {
  const [owner, repoDotGit, ...tail] = segments;
  if (owner === undefined || repoDotGit === undefined || !repoDotGit.endsWith('.git')) {
    return textReply(404, 'Not Found');
  }
  const repoName = repoDotGit.slice(0, -'.git'.length);
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return textReply(404, 'Not Found');

  if (ctx.method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    const service = ctx.query.get('service');
    if (service === 'git-upload-pack') {
      if (headerValue(ctx.headers, 'git-protocol') === 'version=2') {
        return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' }, body: v2Advertisement() };
      }
      return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' }, body: v0Advertisement(repo, 'git-upload-pack') };
    }
    if (service === 'git-receive-pack') {
      return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-advertisement' }, body: v0Advertisement(repo, 'git-receive-pack') };
    }
    return textReply(400, 'missing service parameter');
  }

  if (ctx.method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    if (headerValue(ctx.headers, 'git-protocol') === 'version=2') {
      let parsed: { command: string; args: string[] };
      try {
        parsed = parseV2Request(ctx.body);
      } catch (err) {
        return textReply(400, err instanceof Error ? err.message : 'malformed request');
      }
      if (parsed.command === 'ls-refs') {
        const refPrefixes: string[] = [];
        for (const arg of parsed.args) {
          if (arg.startsWith('ref-prefix ')) refPrefixes.push(arg.slice('ref-prefix '.length));
        }
        return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: lsRefsV2(repo, { refPrefixes }) };
      }
      if (parsed.command === 'fetch') {
        const request = parseFetchArgs(parsed.args);
        return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: fetchV2Response(repo, request) };
      }
      return textReply(400, `unknown command ${parsed.command}`);
    }
    let request: FetchRequest;
    try {
      request = parseV0Upload(ctx.body);
    } catch (err) {
      return textReply(400, err instanceof Error ? err.message : 'malformed request');
    }
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: fetchV0Response(repo, request) };
  }

  if (ctx.method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' }, body: receivePack(repo, ctx.body) };
  }

  return textReply(404, 'Not Found');
}
