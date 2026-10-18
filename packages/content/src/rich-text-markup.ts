import {
  APP_TARGETS,
  type LinkTarget,
  type RichNode,
  type RichText,
  type Span,
} from './schemas.js';

/**
 * CMS-2: a small text syntax to edit rich text in OPS.
 *
 * It is an input method only. What is stored, validated and rendered is
 * always the typed tree of `richTextSchema`; this module converts both ways
 * so an editor can type in a plain text area:
 *
 * - paragraphs are separated by an empty line;
 * - `## Title` and `### Title` are headings;
 * - lines starting with `- ` form a list, `1. ` an ordered list;
 * - `**bold**`, `*italic*` and `[label](target)` mark text, where the
 *   target is a page path (`/paris-dakar`), an anchor (`#horaires`), an
 *   application (`app:booking`, `app:client`, `app:tracking`) or an
 *   `https://` address;
 * - a backslash makes the next character literal (`\*`, `\[`, `\\`).
 *
 * The syntax never produces markup: `<b>` stays the four characters `<b>`.
 */

export interface MarkupError {
  /** 1-based line of the text area. */
  line: number;
  message: string;
}

export type MarkupResult = { ok: true; value: RichText } | { ok: false; errors: MarkupError[] };

const HEADING = /^(#{2,3})\s+(.*)$/;
const UNORDERED_ITEM = /^-\s+(.*)$/;
const ORDERED_ITEM = /^\d{1,3}\.\s+(.*)$/;

function sameLink(a: LinkTarget | undefined, b: LinkTarget | undefined): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameMarks(a: Span, b: Span): boolean {
  return (
    Boolean(a.bold) === Boolean(b.bold) &&
    Boolean(a.italic) === Boolean(b.italic) &&
    sameLink(a.link, b.link)
  );
}

/** Merges adjacent spans that carry the same marks. */
export function normalizeSpans(spans: readonly Span[]): Span[] {
  const result: Span[] = [];
  for (const span of spans) {
    if (span.text.length === 0) continue;
    const previous = result.at(-1);
    if (previous && sameMarks(previous, span)) {
      result[result.length - 1] = { ...previous, text: previous.text + span.text };
    } else {
      result.push({ ...span });
    }
  }
  return result;
}

export function parseLinkTarget(raw: string): LinkTarget | null {
  const value = raw.trim();
  if (value.startsWith('/')) return { kind: 'page', path: value };
  if (value.startsWith('#')) return { kind: 'anchor', id: value.slice(1) };
  if (value.startsWith('app:')) {
    const app = value.slice(4);
    return (APP_TARGETS as readonly string[]).includes(app)
      ? { kind: 'app', app: app as (typeof APP_TARGETS)[number] }
      : null;
  }
  if (value.startsWith('https://')) return { kind: 'url', url: value };
  return null;
}

export function formatLinkTarget(target: LinkTarget): string {
  switch (target.kind) {
    case 'page':
      return target.path;
    case 'anchor':
      return `#${target.id}`;
    case 'app':
      return `app:${target.app}`;
    case 'url':
      return target.url;
  }
}

class InlineError extends Error {}

/**
 * Inline marks of one paragraph or list item. Throws InlineError with a
 * French message when a mark is not closed or a link is malformed.
 */
function parseInline(source: string): Span[] {
  const spans: Span[] = [];
  let bold = false;
  let italic = false;
  let link: LinkTarget | undefined;
  let buffer = '';

  const flush = () => {
    if (!buffer) return;
    spans.push({
      text: buffer,
      ...(bold ? { bold: true } : {}),
      ...(italic ? { italic: true } : {}),
      ...(link ? { link } : {}),
    });
    buffer = '';
  };

  let index = 0;
  let linkEnd = -1;
  while (index < source.length) {
    const char = source[index]!;
    if (index === linkEnd) {
      // End of a link label: `](target)` was validated when the label opened.
      flush();
      const close = source.indexOf(')', index + 2);
      link = undefined;
      linkEnd = -1;
      index = close + 1;
      continue;
    }
    if (char === '\\' && index + 1 < source.length) {
      buffer += source[index + 1];
      index += 2;
      continue;
    }
    if (char === '*') {
      flush();
      if (source[index + 1] === '*') {
        bold = !bold;
        index += 2;
      } else {
        italic = !italic;
        index += 1;
      }
      continue;
    }
    if (char === '[' && !link) {
      const labelEnd = findLabelEnd(source, index + 1);
      if (labelEnd < 0 || source[labelEnd + 1] !== '(') {
        throw new InlineError('lien incomplet : écrivez [texte](cible)');
      }
      const close = source.indexOf(')', labelEnd + 2);
      if (close < 0) throw new InlineError('lien incomplet : parenthèse fermante manquante');
      const target = parseLinkTarget(source.slice(labelEnd + 2, close));
      if (!target) {
        throw new InlineError(
          'cible de lien invalide : /chemin, #ancre, app:booking, app:client, app:tracking ou https://…',
        );
      }
      if (labelEnd === index + 1) throw new InlineError('lien sans texte');
      flush();
      link = target;
      linkEnd = labelEnd;
      index += 1;
      continue;
    }
    buffer += char;
    index += 1;
  }
  if (link) throw new InlineError('lien incomplet');
  if (bold) throw new InlineError('« ** » non fermé (gras)');
  if (italic) throw new InlineError('« * » non fermé (italique)');
  flush();
  return normalizeSpans(spans);
}

/** Index of the `]` closing a link label that starts at `from`, honouring escapes. */
function findLabelEnd(source: string, from: number): number {
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '[') return -1;
    if (char === ']') return index;
  }
  return -1;
}

interface Line {
  number: number;
  text: string;
}

export function markupToRichText(markup: string): MarkupResult {
  const lines = markup.replace(/\r\n?/g, '\n').split('\n');
  const nodes: RichNode[] = [];
  const errors: MarkupError[] = [];
  let paragraph: Line[] = [];
  let list: { ordered: boolean; items: Line[] } | null = null;

  const inline = (line: Line, text: string): Span[] | null => {
    try {
      const spans = parseInline(text);
      if (spans.length === 0) {
        errors.push({ line: line.number, message: 'texte vide' });
        return null;
      }
      return spans;
    } catch (error) {
      if (!(error instanceof InlineError)) throw error;
      errors.push({ line: line.number, message: error.message });
      return null;
    }
  };

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.map((line) => line.text.trim()).join(' ');
    const spans = inline(paragraph[0]!, text);
    if (spans) nodes.push({ kind: 'paragraph', spans });
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const items: Span[][] = [];
    for (const item of list.items) {
      const spans = inline(item, item.text);
      if (spans) items.push(spans);
    }
    if (items.length === list.items.length)
      nodes.push({ kind: 'list', ordered: list.ordered, items });
    list = null;
  };

  lines.forEach((raw, index) => {
    const line: Line = { number: index + 1, text: raw };
    const text = raw.trim();
    if (!text) {
      flushParagraph();
      flushList();
      return;
    }
    const heading = HEADING.exec(text);
    if (heading) {
      flushParagraph();
      flushList();
      const title = unescapePlain(heading[2]!.trim());
      if (!title) errors.push({ line: line.number, message: 'titre vide' });
      else nodes.push({ kind: 'heading', level: heading[1]!.length === 2 ? 2 : 3, text: title });
      return;
    }
    const unordered = UNORDERED_ITEM.exec(text);
    const ordered = unordered ? null : ORDERED_ITEM.exec(text);
    if (unordered || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      if (list && list.ordered !== isOrdered) flushList();
      list ??= { ordered: isOrdered, items: [] };
      list.items.push({ number: line.number, text: (unordered ?? ordered)![1]! });
      return;
    }
    if (list) {
      // A continuation line belongs to the previous list item.
      const last = list.items.at(-1)!;
      last.text = `${last.text} ${text}`;
      return;
    }
    paragraph.push({ number: line.number, text });
  });
  flushParagraph();
  flushList();

  if (errors.length > 0) return { ok: false, errors };
  if (nodes.length === 0) return { ok: false, errors: [{ line: 1, message: 'texte vide' }] };
  return { ok: true, value: nodes };
}

/** Heading text is plain: only escapes are interpreted. */
function unescapePlain(text: string): string {
  return text.replace(/\\(.)/g, '$1');
}

const INLINE_SPECIAL = /[\\*[\]]/g;

function escapeInline(text: string): string {
  return text.replace(/\s+/g, ' ').replace(INLINE_SPECIAL, (char) => `\\${char}`);
}

/** A paragraph or item must not start like a heading, a list item or a numbered item. */
function escapeLineStart(text: string): string {
  if (/^#/.test(text) || /^-\s/.test(text) || /^\d{1,3}\.\s/.test(text)) return `\\${text}`;
  return text;
}

/**
 * Marks are written as toggles from one span to the next, so two adjacent
 * spans never produce an ambiguous run of stars: between two texts there is
 * at most `**` (bold) and `*` (italic), and `***` always reads as both.
 */
function toggles(from: { bold: boolean; italic: boolean }, to: Span | null): string {
  const bold = Boolean(to?.bold);
  const italic = Boolean(to?.italic);
  return (from.bold !== bold ? '**' : '') + (from.italic !== italic ? '*' : '');
}

function formatSpans(spans: readonly Span[]): string {
  const state = { bold: false, italic: false };
  let link: LinkTarget | undefined;
  let output = '';
  const moveTo = (span: Span | null) => {
    output += toggles(state, span);
    state.bold = Boolean(span?.bold);
    state.italic = Boolean(span?.italic);
  };
  spans.forEach((span, index) => {
    if (span.link && !sameLink(span.link, link)) {
      output += '[';
      link = span.link;
    }
    moveTo(span);
    output += escapeInline(span.text);
    const next = spans[index + 1] ?? null;
    if (link && !sameLink(next?.link, link)) {
      // Close the marks inside the label: `[**a**](/x)` rather than `[**a](/x)**`.
      moveTo(next && !next.link ? next : null);
      output += `](${formatLinkTarget(link)})`;
      link = undefined;
    }
  });
  moveTo(null);
  return escapeLineStart(output);
}

export function richTextToMarkup(value: RichText): string {
  return value
    .map((node) => {
      if (node.kind === 'heading') {
        return `${node.level === 2 ? '##' : '###'} ${node.text.replace(/\\/g, '\\\\')}`;
      }
      if (node.kind === 'paragraph') return formatSpans(node.spans);
      return node.items
        .map((item, index) => `${node.ordered ? `${index + 1}.` : '-'} ${formatSpans(item)}`)
        .join('\n');
    })
    .join('\n\n');
}
