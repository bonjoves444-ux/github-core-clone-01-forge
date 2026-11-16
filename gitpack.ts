// gitpack.ts — small, dependency-free helpers for the caching edge (edge.ts).
//
// Everything here is pure byte work over the git smart-HTTP wire format, so the
// edge can decide what is safe to cache, and what is safe to update in place,
// without ever trusting a cached response it cannot re-derive:
//
//   - pkt-line framing: parse and re-encode the 4-hex-digit length framing
//     every git response uses, so a cached body is only trusted when its
//     framing is well formed from end to end.
//   - upload-pack request classification: an ls-refs command and a fetch
//     command are different cache entries, keyed by the request body.
//   - upload-pack response validation: a fetch response is only cached when
//     the pack inside it carries a verifiable SHA-1 trailer, so a truncated
//     or corrupt pack can never be served twice.
//   - receive-pack command and report parsing: the edge reads the command
//     list a push carries and the report-status it earns, so it knows exactly
//     which refs moved and can update its cached advertisements in place.
//   - advertisement splicing: after a push moves refs/heads/main from oid A
//     to oid B, the cached advertisement and ls-refs answers are the same
//     bytes with A replaced by B — but only when every line that starts with
//     A names the pushed ref or HEAD pointing at it. Any other shape (a
//     second ref sharing the oid, a new ref, a deleted ref, a tag peel)
//     refuses the splice and the caller invalidates instead. Splicing is an
//     optimisation; invalidation is always correct, so doubt means invalidate.
//
// Nothing here imports the forge (app.ts) or the kit: it runs on the raw
// request and response bytes the edge sees, and every function that cannot
// prove its answer returns null instead of guessing.

import { createHash } from 'node:crypto';

/** The SHA-1 hex of `data` (a Buffer, or a UTF-8 string). */
export function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

/** True when `value` is a 40-character lowercase hex object id. */
export function isOid(value: string): boolean {
  if (value.length !== 40) return false;
  for (let i = 0; i < 40; i += 1) {
    const c = value.charCodeAt(i);
    const hex =
      (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
    if (!hex) return false;
  }
  return true;
}

/** The all-zero object id: a ref that does not exist yet, or one being deleted. */
export const ZERO_OID = '0'.repeat(40);

/** One parsed pkt-line: its kind, and its payload text for data lines. */
export interface PktLine {
  readonly kind: 'data' | 'flush' | 'delim' | 'response-end';
  /** The payload of a data line, without its 4-byte length header. */
  readonly text: string;
  /** The raw bytes of the whole line, length header included. */
  readonly raw: Buffer;
}

/**
 * Parse `buf` as a sequence of pkt-lines. Returns null when the framing is
 * malformed: a length that is not 4 hex digits, a length below 4, a line
 * that runs past the end of the buffer, or trailing bytes after the final
 * flush. A well-formed git response parses cleanly and ends with a flush.
 */
export function parsePktLines(buf: Buffer): PktLine[] | null {
  const lines: PktLine[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) return null;
    const head = buf.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return null;
    const len = parseInt(head, 16);
    if (len === 0) {
      lines.push({ kind: 'flush', text: '', raw: buf.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      lines.push({ kind: 'delim', text: '', raw: buf.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      lines.push({ kind: 'response-end', text: '', raw: buf.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) return null;
    const raw = buf.subarray(offset, offset + len);
    const text = raw.subarray(4).toString('utf8');
    lines.push({ kind: 'data', text, raw: Buffer.from(raw) });
    offset += len;
  }
  return lines;
}

/** Encode one pkt-line: a 4-hex-digit length header plus the payload. */
export function encodePktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

/** The 4-byte flush pkt-line, `0000`. */
export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** True when `buf` parses as pkt-lines and its last line is a flush. */
export function isFramedResponse(buf: Buffer): boolean {
  const lines = parsePktLines(buf);
  if (lines === null || lines.length === 0) return false;
  return lines[lines.length - 1]?.kind === 'flush';
}

/** What an upload-pack POST asks for: `ls-refs`, `fetch`, or `unknown`. */
export type UploadPackKind = 'ls-refs' | 'fetch' | 'unknown';

/**
 * Classify an upload-pack request body by its first command line. The body
 * is a pkt-line stream whose first data line is `command=<name>\n`. Anything
 * else (an empty body, a body that does not parse, a command the edge does
 * not cache) is `unknown`, and the edge forwards it without caching.
 */
export function classifyUploadPackRequest(body: Buffer): UploadPackKind {
  const lines = parsePktLines(body);
  if (lines === null) return 'unknown';
  for (const line of lines) {
    if (line.kind !== 'data') continue;
    if (line.text.startsWith('command=ls-refs')) return 'ls-refs';
    if (line.text.startsWith('command=fetch')) return 'fetch';
    return 'unknown';
  }
  return 'unknown';
}

/**
 * Pull the pack bytes out of a fetch response. A side-band-64k fetch answer
 * carries the pack in channel-1 sideband packets (a pkt-line whose payload
 * starts with byte 0x01); a plain answer carries the pack raw, starting at
 * the `PACK` magic. Either way the pack's last 20 bytes are the SHA-1 of
 * everything before them, and this function only returns the pack when that
 * trailer verifies. Returns null when no verifiable pack is found.
 */
export function extractVerifiablePack(body: Buffer): Buffer | null {
  const lines = parsePktLines(body);
  if (lines === null) return null;
  const sideband: Buffer[] = [];
  for (const line of lines) {
    if (line.kind !== 'data') continue;
    const payload = line.raw.subarray(4);
    if (payload.length > 1 && payload[0] === 0x01) sideband.push(Buffer.from(payload.subarray(1)));
  }
  const candidates: Buffer[] = [];
  if (sideband.length > 0) candidates.push(Buffer.concat(sideband));
  const magic = body.indexOf(Buffer.from('PACK', 'ascii'));
  if (magic >= 0) candidates.push(Buffer.from(body.subarray(magic)));
  for (const pack of candidates) {
    if (pack.length <= 20) continue;
    if (pack.subarray(0, 4).toString('ascii') !== 'PACK') continue;
    const trailer = pack.subarray(pack.length - 20);
    const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
    if (digest.equals(trailer)) return pack;
  }
  return null;
}

/**
 * Validate an upload-pack response before it is cached. The framing must be
 * well formed and end with a flush; an ls-refs answer must carry at least
 * one ref line; a fetch answer must carry a verifiable pack. A response
 * that fails any of these is served once, directly, and never cached.
 */
export function validateUploadPackResponse(body: Buffer, kind: UploadPackKind): boolean {
  if (kind === 'unknown') return false;
  if (!isFramedResponse(body)) return false;
  if (kind === 'ls-refs') {
    const lines = parsePktLines(body);
    if (lines === null) return false;
    return lines.some((line) => line.kind === 'data' && isOid(line.text.slice(0, 40)));
  }
  return extractVerifiablePack(body) !== null;
}

/** One receive-pack command: the ref it moves, from `oldOid` to `newOid`. */
export interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/**
 * Parse a receive-pack request body into its command list. The body is a
 * pkt-line stream of `<old> <new> <ref>[\\0<capabilities>]` lines up to the
 * first flush, followed by the pack itself — raw binary that is deliberately
 * never parsed as pkt-lines (its bytes are not framing, and reading them as
 * lengths would fail or misread). Parsing stops at the flush; the pack is
 * ignored. Returns null when the command list is malformed, so the caller
 * treats the push as unparseable and invalidates instead of splicing.
 */
export function parseReceivePackCommands(body: Buffer): PushCommand[] | null {
  const commands: PushCommand[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const head = body.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return null;
    const len = parseInt(head, 16);
    if (len === 0) break;
    if (len === 1 || len === 2) {
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > body.length) return null;
    const text = body.toString('utf8', offset + 4, offset + len);
    const nul = text.indexOf('\0');
    const trimmed = (nul >= 0 ? text.slice(0, nul) : text).trimEnd();
    const parts = trimmed.split(' ');
    if (parts.length < 3) return null;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isOid(oldOid) || !isOid(newOid)) return null;
    if (!ref.startsWith('refs/')) return null;
    commands.push({ oldOid, newOid, ref });
    offset += len;
  }
  if (commands.length === 0) return null;
  return commands;
}

/** One line of a report-status answer: whether a ref was accepted. */
export interface PushReportLine {
  readonly ref: string;
  readonly ok: boolean;
  readonly reason: string;
}

/**
 * Parse a receive-pack report-status body. Lines are `unpack ok`, `ok
 * <ref>`, or `ng <ref> <reason>`; an `unpack <error>` line makes the whole
 * push a failure, reported as a single not-ok line for the empty ref. Returns
 * null when the body does not parse, so the caller invalidates.
 */
export function parsePushReport(body: Buffer): PushReportLine[] | null {
  const lines = parsePktLines(body);
  if (lines === null) return null;
  const out: PushReportLine[] = [];
  for (const line of lines) {
    if (line.kind !== 'data') continue;
    const text = line.text.replace(/\n$/, '');
    if (text === 'unpack ok') continue;
    if (text.startsWith('unpack ')) {
      out.push({ ref: '', ok: false, reason: text.slice('unpack '.length) });
      continue;
    }
    if (text.startsWith('ok ')) {
      // The ref ends at the first space or NUL: a report line may carry a
      // capabilities suffix after a NUL, and it is not part of the ref.
      const rest = text.slice(3);
      const end = rest.search(/[\s\0]/);
      out.push({ ref: end < 0 ? rest : rest.slice(0, end), ok: true, reason: '' });
      continue;
    }
    if (text.startsWith('ng ')) {
      const rest = text.slice(3);
      const end = rest.search(/[\s\0]/);
      if (end < 0) out.push({ ref: rest, ok: false, reason: '' });
      else out.push({ ref: rest.slice(0, end), ok: false, reason: rest.slice(end + 1).trim() });
      continue;
    }
    return null;
  }
  return out;
}

/**
 * Read the HEAD symref out of an advertisement body: the `symref=HEAD:<ref>`
 * token in a capabilities suffix. Returns null when the advertisement
 * carries no symref, and the caller must then refuse to splice any line
 * naming HEAD.
 */
export function parseSymref(advBody: Buffer): string | null {
  const text = advBody.toString('utf8');
  const marker = 'symref=HEAD:';
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const start = at + marker.length;
  let end = start;
  while (end < text.length) {
    const c = text.charCodeAt(end);
    if (c === 0 || c === 32 || c === 10 || c === 13) break;
    end += 1;
  }
  const ref = text.slice(start, end);
  return ref.startsWith('refs/') ? ref : null;
}

/**
 * The ref name a pkt-line data payload names, when the line starts with an
 * object id: the token after the oid, up to a space, a NUL, or a newline,
 * with a trailing `^{}` (a peeled line) stripped. Returns null when the line
 * does not start with an oid.
 */
export function refOfOidLine(text: string): string | null {
  if (text.length < 42) return null;
  const oid = text.slice(0, 40);
  if (!isOid(oid)) return null;
  if (text[40] !== ' ') return null;
  let rest = text.slice(41);
  const nul = rest.indexOf('\0');
  if (nul >= 0) rest = rest.slice(0, nul);
  const nl = rest.indexOf('\n');
  if (nl >= 0) rest = rest.slice(0, nl);
  const name = rest.trim();
  if (!name.startsWith('refs/') && name !== 'HEAD' && name !== 'capabilities^{}') return null;
  return name.endsWith('^{}') ? name.slice(0, -3) : name;
}

/**
 * Update a cached advertisement or ls-refs answer in place after a push
 * moves one ref from `oldOid` to `newOid`.
 *
 * The splice is only safe when every pkt-line that starts with `oldOid`
 * names the pushed ref, or HEAD when the pushed ref is HEAD's target
 * (`headTarget`, read from the advertisement's symref). A line naming any
 * other ref — a second branch sharing the oid, a tag and its peel, a
 * capabilities line — refuses the splice by returning null, and the caller
 * invalidates the cached answer instead. A push that creates the ref (its
 * old oid is zero) or deletes it also returns null: the cached answer has
 * no line to splice, or the line must disappear, and only the forge itself
 * can build the new answer.
 *
 * On success the returned buffer is the same length as the input, with the
 * same framing, and it re-parses cleanly; the caller verifies that too
 * before trusting it.
 */
export function spliceRefOid(
  cached: Buffer,
  oldOid: string,
  newOid: string,
  pushedRef: string,
  headTarget: string | null,
): Buffer | null {
  if (!isOid(oldOid) || !isOid(newOid)) return null;
  if (oldOid === ZERO_OID || newOid === ZERO_OID) return null;
  if (oldOid === newOid) return Buffer.from(cached);
  const lines = parsePktLines(cached);
  if (lines === null) return null;
  let splicedAny = false;
  const out: Buffer[] = [];
  for (const line of lines) {
    if (line.kind !== 'data') {
      out.push(Buffer.from(line.raw));
      continue;
    }
    const text = line.text;
    if (!text.startsWith(oldOid + ' ')) {
      out.push(Buffer.from(line.raw));
      continue;
    }
    const ref = refOfOidLine(text);
    if (ref === null) return null;
    const allowed =
      ref === pushedRef || (ref === 'HEAD' && headTarget !== null && pushedRef === headTarget);
    if (!allowed) return null;
    const replaced = Buffer.concat([
      Buffer.from(newOid, 'ascii'),
      Buffer.from(line.raw.subarray(4 + 40)),
    ]);
    // The length header counts the header itself: payload bytes plus 4.
    const head = Buffer.from((replaced.length + 4).toString(16).padStart(4, '0'), 'ascii');
    out.push(Buffer.concat([head, replaced]));
    splicedAny = true;
  }
  if (!splicedAny) return null;
  const next = Buffer.concat(out);
  if (next.length !== cached.length) return null;
  if (parsePktLines(next) === null) return null;
  return next;
}

/**
 * Apply one successful push to the cached git answers for its repository:
 * the receive-pack advertisement and the ls-refs answer, each spliced when
 * the push moved a ref the cached answer already lists, and dropped when it
 * did not. Returns the new pair, with nulls where the caller must re-fetch.
 * A push with no accepted ref, or with a report or command list that does
 * not parse, drops both answers: the state may have changed in a way the
 * edge cannot describe.
 */
export function spliceAfterPush(
  adv: Buffer | null,
  lsRefs: Buffer | null,
  commands: readonly PushCommand[],
  report: readonly PushReportLine[],
  headTarget: string | null,
): { adv: Buffer | null; lsRefs: Buffer | null } {
  const accepted = new Map<string, PushCommand>();
  for (const command of commands) {
    const line = report.find((entry) => entry.ref === command.ref);
    if (line !== undefined && line.ok) accepted.set(command.ref, command);
  }
  if (accepted.size === 0) return { adv: null, lsRefs: null };
  let nextAdv = adv;
  let nextLs = lsRefs;
  for (const command of accepted.values()) {
    if (command.oldOid === ZERO_OID || command.newOid === ZERO_OID) {
      return { adv: null, lsRefs: null };
    }
    if (nextAdv !== null) {
      nextAdv = spliceRefOid(nextAdv, command.oldOid, command.newOid, command.ref, headTarget);
    }
    if (nextLs !== null) {
      nextLs = spliceRefOid(nextLs, command.oldOid, command.newOid, command.ref, headTarget);
    }
  }
  return { adv: nextAdv, lsRefs: nextLs };
}
