/**
 * A small, bundled syntax highlighter.
 *
 * Vela ships offline behind a strict CSP: no CDN, no lazily fetched grammar
 * files. So this is deliberately a *lexer*, not a parser — comments, strings,
 * numbers, keywords and punctuation, which is 90% of what makes code readable
 * and 2% of the code of a real grammar engine.
 *
 * The important property is what it does when it does **not** know the
 * language: it highlights comments, strings and numbers and leaves every word
 * plain, rather than guessing a keyword set. A wrong highlight reads as a bug
 * in the model's output; a missing one reads as a plain code block.
 */

export type TokenKind = 'plain' | 'comment' | 'string' | 'number' | 'keyword' | 'punct';

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

interface Grammar {
  readonly keywords: ReadonlySet<string>;
  readonly lineComment: readonly string[];
  readonly blockComment: readonly [string, string] | null;
  readonly strings: readonly string[];
}

const C_FAMILY = 'break case catch class const continue default do else enum export extends finally for function if implements import in instanceof interface let new return static super switch this throw try typeof var void while yield async await of as from with delete';
const RUSTISH = 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while';
const PYTHONISH = 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield';

function words(source: string): ReadonlySet<string> {
  return new Set(source.split(' '));
}

const C_LIKE: Grammar = {
  keywords: words(`${C_FAMILY} true false null undefined`),
  lineComment: ['//'],
  blockComment: ['/*', '*/'],
  strings: ['"', "'", '`'],
};

const GRAMMARS: Readonly<Record<string, Grammar>> = {
  javascript: C_LIKE,
  typescript: C_LIKE,
  json: {
    keywords: words('true false null'),
    lineComment: [],
    blockComment: null,
    strings: ['"'],
  },
  rust: {
    keywords: words(`${RUSTISH} true false`),
    lineComment: ['//'],
    blockComment: ['/*', '*/'],
    strings: ['"'],
  },
  python: {
    keywords: words(`${PYTHONISH} True False None`),
    lineComment: ['#'],
    blockComment: null,
    strings: ['"', "'"],
  },
  shell: {
    keywords: words('if then else elif fi for while do done case esac function return export local'),
    lineComment: ['#'],
    blockComment: null,
    strings: ['"', "'"],
  },
  css: {
    keywords: words('important media supports keyframes from to'),
    lineComment: [],
    blockComment: ['/*', '*/'],
    strings: ['"', "'"],
  },
  sql: {
    keywords: words('select from where insert into values update set delete join left right inner outer on group by order having limit offset create table drop alter index as and or not null distinct'),
    lineComment: ['--'],
    blockComment: ['/*', '*/'],
    strings: ["'"],
  },
};

/** Language tags a model might write, mapped onto the grammars above. */
const ALIASES: Readonly<Record<string, string>> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  node: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  rs: 'rust',
  py: 'python',
  python3: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  console: 'shell',
  scss: 'css',
  postgres: 'sql',
  postgresql: 'sql',
  psql: 'sql',
  json5: 'json',
};

/**
 * The unknown-language grammar: string and number shapes that are near-universal,
 * and no keyword list at all.
 */
const UNKNOWN: Grammar = {
  keywords: new Set(),
  lineComment: ['//', '#'],
  blockComment: ['/*', '*/'],
  strings: ['"', "'", '`'],
};

export function grammarFor(language: string | null): Grammar {
  if (language === null) return UNKNOWN;
  const key = language.toLowerCase();
  return GRAMMARS[ALIASES[key] ?? key] ?? UNKNOWN;
}

/** A human label for the code block's corner. Never invents one. */
export function languageLabel(language: string | null): string | null {
  if (language === null || language.trim() === '') return null;
  return language.trim();
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const PUNCT = /[{}()[\].,;:+\-*/%<>=!&|^~?@#]/;

export function tokenize(source: string, language: string | null): Token[] {
  const grammar = grammarFor(language);
  const tokens: Token[] = [];
  let plain = '';
  let index = 0;

  const flush = (): void => {
    if (plain !== '') tokens.push({ kind: 'plain', text: plain });
    plain = '';
  };
  const push = (kind: TokenKind, text: string): void => {
    flush();
    tokens.push({ kind, text });
  };

  while (index < source.length) {
    const rest = source.slice(index);

    const lineComment = grammar.lineComment.find((marker) => rest.startsWith(marker));
    if (lineComment !== undefined) {
      const end = rest.indexOf('\n');
      const text = end === -1 ? rest : rest.slice(0, end);
      push('comment', text);
      index += text.length;
      continue;
    }

    if (grammar.blockComment !== null && rest.startsWith(grammar.blockComment[0])) {
      const [open, close] = grammar.blockComment;
      const end = rest.indexOf(close, open.length);
      const text = end === -1 ? rest : rest.slice(0, end + close.length);
      push('comment', text);
      index += text.length;
      continue;
    }

    const quote = grammar.strings.find((mark) => rest.startsWith(mark));
    if (quote !== undefined) {
      const text = readString(rest, quote);
      push('string', text);
      index += text.length;
      continue;
    }

    const char = source[index] ?? '';

    if (/[0-9]/.test(char) && !IDENT_PART.test(source[index - 1] ?? ' ')) {
      const number = /^0[xXbBoO][0-9a-fA-F_]+|^[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
      if (number !== null) {
        push('number', number[0]);
        index += number[0].length;
        continue;
      }
    }

    if (IDENT_START.test(char)) {
      let end = index + 1;
      while (end < source.length && IDENT_PART.test(source[end] ?? '')) end += 1;
      const word = source.slice(index, end);
      if (grammar.keywords.has(word)) push('keyword', word);
      else plain += word;
      index = end;
      continue;
    }

    if (PUNCT.test(char)) {
      push('punct', char);
      index += 1;
      continue;
    }

    plain += char;
    index += 1;
  }

  flush();
  return tokens;
}

/**
 * Reads a quoted run, honouring backslash escapes and stopping at end-of-line
 * for single-line quotes so an unbalanced quote cannot paint the rest of the
 * file as a string — which is exactly what happens while an answer is still
 * streaming.
 */
function readString(rest: string, quote: string): string {
  const multiline = quote === '`';
  let index = quote.length;
  while (index < rest.length) {
    const char = rest[index] ?? '';
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (!multiline && char === '\n') return rest.slice(0, index);
    if (rest.startsWith(quote, index)) return rest.slice(0, index + quote.length);
    index += 1;
  }
  return rest;
}
