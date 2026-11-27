import { SIMPLE_FOLD_PAIRS } from './simple-fold.gen.js';

/** Deepest nesting `firstAmbiguousMember` reads: the limit Go's encoding/json applies. */
export const MAX_JSON_DEPTH = 10000;

/**
 * Thrown by `firstAmbiguousMember` when a document is not exactly one valid JSON value, or nests
 * deeper than `MAX_JSON_DEPTH`. Treat it as a refusal. Mirrors the Go `ErrInvalidJSON`.
 */
export class InvalidJsonError extends Error {
  constructor(reason: string) {
    super(`sender_auth: not valid JSON: ${reason}`);
    this.name = 'InvalidJsonError';
  }
}

const FOLD: ReadonlyMap<number, number> = (() => {
  const table = new Map<number, number>();
  for (let i = 0; i < SIMPLE_FOLD_PAIRS.length; i += 2) {
    table.set(SIMPLE_FOLD_PAIRS[i]!, SIMPLE_FOLD_PAIRS[i + 1]!);
  }
  return table;
})();

/** Maps each code point to the least of its simple-folding orbit, as Go's `strings.EqualFold` relates them. */
export function foldMemberName(name: string): string {
  let folded = '';
  for (const character of name) {
    const codePoint = character.codePointAt(0)!;
    folded += String.fromCodePoint(FOLD.get(codePoint) ?? codePoint);
  }
  return folded;
}

const REPLACEMENT = String.fromCharCode(0xfffd);

/**
 * Replaces lone surrogates with U+FFFD. A lone surrogate cannot travel as UTF-8, so a Go reader of
 * the same document only ever sees U+FFFD in its place.
 */
export function wellFormed(text: string): string {
  let first = 0;
  while (first < text.length) {
    const code = text.charCodeAt(first);
    if (code >= 0xd800 && code <= 0xdfff) break;
    first++;
  }
  if (first === text.length) return text;
  let out = text.slice(0, first);
  for (let i = first; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i]! + text[i + 1]!;
        i++;
        continue;
      }
      out += REPLACEMENT;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += REPLACEMENT;
    } else {
      out += text[i]!;
    }
  }
  return out;
}

interface Frame {
  object: boolean;
  /** False inside the value of an `@context` member. */
  inspect: boolean;
  /** Folded member names of this object. */
  seen: Set<string>;
  /** Member whose value is being read (objects). */
  key: string;
  /** Element being read (arrays). */
  index: number;
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/**
 * Returns the path (for example `$.destination[0].Account`) of the first member whose name equals
 * another member name of the same object under Unicode simple folding, exact duplicates included,
 * or `undefined` when there is none.
 *
 * Readers disagree on such a document: Go's encoding/json matches member names case-insensitively
 * and keeps the last match, while `JSON.parse` keeps every spelling apart. Two parties reading the
 * same bytes can therefore see different payments, so the document must be refused.
 *
 * The value of an `@context` member is not inspected, because JSON-LD contexts legitimately define
 * terms that differ only in case. The member name itself is still checked. Mirrors the Go
 * `FirstAmbiguousMember`.
 */
export function firstAmbiguousMember(document: string | Uint8Array): string | undefined {
  return scanMembers(typeof document === 'string' ? document : decodeUtf8(document), true);
}

/**
 * `firstAmbiguousMember` limited to what a reader of the root object uses: every member name of the
 * root is checked, but only the values of the root members named in `read` (matched under the same
 * folding) are inspected. Other root values are still parsed, so a document that is not valid JSON
 * is refused, but a twin inside them is not reported. A root that is not an object is scanned in
 * full. Mirrors the Go `FirstAmbiguousMemberIn`.
 *
 * Use it where part of the document is carried for others and never read, so a twin there cannot
 * make the reader refuse what it does not act on.
 */
export function firstAmbiguousMemberIn(
  document: string | Uint8Array,
  read: readonly string[],
): string | undefined {
  return scanMembers(
    typeof document === 'string' ? document : decodeUtf8(document),
    true,
    new Set(read.map(foldMemberName)),
  );
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Decodes bytes as UTF-8, refusing invalid sequences as the Go reader does, since decoders replace
 * invalid bytes inconsistently.
 */
export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    throw new InvalidJsonError('the document is not valid UTF-8');
  }
}

/**
 * `firstAmbiguousMember` with the `@context` exemption made optional. A signed prehash carries no
 * JSON-LD, so it is scanned with no exemption at all. A defined `read` holds the folded names of the
 * root members whose values are inspected.
 */
export function scanMembers(
  document: string,
  exemptContext: boolean,
  read?: ReadonlySet<string>,
): string | undefined {
  const length = document.length;
  let at = 0;

  const fail = (reason: string): never => {
    throw new InvalidJsonError(`${reason} at offset ${at}`);
  };
  const skipWhitespace = (): void => {
    while (at < length) {
      const code = document.charCodeAt(at);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return;
      at++;
    }
  };
  const readHex4 = (from: number): number => {
    const hex = document.slice(from, from + 4);
    return HEX4.test(hex) ? parseInt(hex, 16) : -1;
  };
  // Decodes a string as Go's encoding/json does: a surrogate escape pairs only with an immediately
  // following low-surrogate escape, and any other surrogate reads as U+FFFD. With keep = false the
  // string is validated but not decoded.
  const readString = (keep: boolean): string => {
    at++; // opening quote
    let decoded = '';
    let runStart = at;
    const flushRun = (): void => {
      if (keep) decoded += wellFormed(document.slice(runStart, at));
    };
    for (;;) {
      if (at >= length) fail('unterminated string');
      const code = document.charCodeAt(at);
      if (code === 0x22) {
        flushRun();
        at++;
        return decoded;
      }
      if (code < 0x20) fail('unescaped control character in a string');
      if (code !== 0x5c) {
        at++;
        continue;
      }
      flushRun();
      const escape = document[at + 1];
      if (escape === undefined) fail('unterminated escape');
      if (escape === 'u') {
        const unit = readHex4(at + 2);
        if (unit < 0) fail('invalid \\u escape');
        at += 6;
        if (unit >= 0xd800 && unit <= 0xdfff) {
          const low = document[at] === '\\' && document[at + 1] === 'u' ? readHex4(at + 2) : -1;
          if (unit <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
            if (keep) decoded += String.fromCharCode(unit, low);
            at += 6;
          } else if (keep) {
            decoded += REPLACEMENT;
          }
        } else if (keep) {
          decoded += String.fromCharCode(unit);
        }
      } else {
        const replacement = SIMPLE_ESCAPES[escape!];
        if (replacement === undefined) fail(`invalid escape \\${escape}`);
        if (keep) decoded += replacement;
        at += 2;
      }
      runStart = at;
    }
  };
  const readLiteral = (word: string): void => {
    if (!document.startsWith(word, at)) fail('unexpected token');
    at += word.length;
  };
  const readNumber = (): void => {
    NUMBER.lastIndex = at;
    const match = NUMBER.exec(document);
    if (!match || match[0].length === 0) fail('unexpected token');
    at += match![0].length;
  };

  const stack: Frame[] = [];
  let inspectNext = true;

  // The path is assembled only when a twin is found, so memory stays linear in the document.
  const pathOf = (name: string): string => {
    let path = '$';
    for (let i = 0; i < stack.length - 1; i++) {
      const frame = stack[i]!;
      path += frame.object ? `.${frame.key}` : `[${frame.index}]`;
    }
    return `${path}.${name}`;
  };
  // A twin is reported as soon as its name is read, before the ':' is checked, as Go's tokenizer does.
  const readMemberName = (frame: Frame): string | undefined => {
    skipWhitespace();
    if (document[at] !== '"') fail('expected a member name');
    const name = readString(frame.inspect);
    let folded = '';
    if (frame.inspect) {
      folded = foldMemberName(name);
      if (frame.seen.has(folded)) return pathOf(name);
      frame.seen.add(folded);
    }
    skipWhitespace();
    if (document[at] !== ':') fail("expected ':' after a member name");
    at++;
    frame.key = name;
    const unread = read !== undefined && stack.length === 1 && !read.has(folded);
    inspectNext = frame.inspect && !(exemptContext && name === '@context') && !unread;
    return undefined;
  };

  for (;;) {
    // Read the value that starts here. A non-empty container pushes a frame and loops to read its
    // first child; any other value falls through to the unwinding below.
    skipWhitespace();
    if (at >= length) fail('unexpected end of input');
    const opener = document[at];
    if (opener === '{' || opener === '[') {
      if (stack.length >= MAX_JSON_DEPTH) fail(`nested more than ${MAX_JSON_DEPTH} levels deep`);
      const object = opener === '{';
      at++;
      skipWhitespace();
      if (document[at] === (object ? '}' : ']')) {
        at++;
      } else {
        const frame: Frame = { object, inspect: inspectNext, seen: new Set(), key: '', index: 0 };
        stack.push(frame);
        if (object) {
          const twin = readMemberName(frame);
          if (twin !== undefined) return twin;
        } else {
          inspectNext = frame.inspect;
        }
        continue;
      }
    } else if (opener === '"') {
      readString(false);
    } else if (opener === 't') {
      readLiteral('true');
    } else if (opener === 'f') {
      readLiteral('false');
    } else if (opener === 'n') {
      readLiteral('null');
    } else {
      readNumber();
    }

    // A value is complete: close every container it completes, and stop at the next sibling.
    let next = false;
    while (!next) {
      const top = stack[stack.length - 1];
      skipWhitespace();
      if (top === undefined) {
        if (at !== length) fail('more than one top-level value');
        return undefined;
      }
      const token = document[at];
      if (token === ',') {
        at++;
        if (top.object) {
          const twin = readMemberName(top);
          if (twin !== undefined) return twin;
        } else {
          top.index++;
          inspectNext = top.inspect;
        }
        next = true;
      } else if (token === (top.object ? '}' : ']')) {
        at++;
        stack.pop();
      } else {
        fail(top.object ? "expected ',' or '}'" : "expected ',' or ']'");
      }
    }
  }
}
