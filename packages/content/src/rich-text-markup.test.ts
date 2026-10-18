import { describe, expect, it } from 'vitest';
import {
  markupToRichText,
  normalizeSpans,
  parseLinkTarget,
  richTextToMarkup,
} from './rich-text-markup.js';
import { richTextSchema, type RichNode, type RichText, type Span } from './schemas.js';

function parse(markup: string): RichText {
  const result = markupToRichText(markup);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

describe('rich text markup (CMS-2 input method)', () => {
  it('reads paragraphs, headings, lists and inline marks', () => {
    const value = parse(
      [
        '## Avant le départ',
        '',
        'Présentez-vous **45 minutes** avant le départ, *pièce d’identité* en main.',
        'Une ligne suivante continue le paragraphe.',
        '',
        '- un bagage en soute',
        '- un bagage à main',
        '',
        '1. Réservez',
        '2. Embarquez',
        '',
        '### Aide',
        'Voir [la FAQ](/aide), [les horaires](#horaires), [mon compte](app:client) ou [le site](https://example.org/a).',
      ].join('\n'),
    );
    expect(richTextSchema.parse(value)).toEqual(value);
    expect(value[0]).toEqual({ kind: 'heading', level: 2, text: 'Avant le départ' });
    expect(value[1]).toEqual({
      kind: 'paragraph',
      spans: [
        { text: 'Présentez-vous ' },
        { text: '45 minutes', bold: true },
        { text: ' avant le départ, ' },
        { text: 'pièce d’identité', italic: true },
        { text: ' en main. Une ligne suivante continue le paragraphe.' },
      ],
    });
    expect(value[2]).toEqual({
      kind: 'list',
      ordered: false,
      items: [[{ text: 'un bagage en soute' }], [{ text: 'un bagage à main' }]],
    });
    expect(value[3]).toMatchObject({ kind: 'list', ordered: true });
    expect(value[4]).toEqual({ kind: 'heading', level: 3, text: 'Aide' });
    const links = (value[5] as Extract<RichNode, { kind: 'paragraph' }>).spans
      .filter((span) => span.link)
      .map((span) => span.link);
    expect(links).toEqual([
      { kind: 'page', path: '/aide' },
      { kind: 'anchor', id: 'horaires' },
      { kind: 'app', app: 'client' },
      { kind: 'url', url: 'https://example.org/a' },
    ]);
  });

  it('keeps markup typed by an editor as literal text', () => {
    const value = parse(
      '<b>gras</b> <script>alert(1)</script> \\*pas italique\\* \\[pas un lien\\]',
    );
    expect(value).toEqual([
      {
        kind: 'paragraph',
        spans: [{ text: '<b>gras</b> <script>alert(1)</script> *pas italique* [pas un lien]' }],
      },
    ]);
  });

  it('reports unclosed marks and invalid links with their line', () => {
    const result = markupToRichText(
      ['Texte **non fermé', '', 'Un [lien](javascript:alert(1)) dangereux', '', '[](/vide)'].join(
        '\n',
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      { line: 1, message: '« ** » non fermé (gras)' },
      {
        line: 3,
        message:
          'cible de lien invalide : /chemin, #ancre, app:booking, app:client, app:tracking ou https://…',
      },
      { line: 5, message: 'lien sans texte' },
    ]);
    expect(markupToRichText('   \n\n ')).toEqual({
      ok: false,
      errors: [{ line: 1, message: 'texte vide' }],
    });
    expect(parseLinkTarget('http://example.org')).toBeNull();
    expect(parseLinkTarget('app:ops')).toBeNull();
  });

  it('writes the canonical syntax of a tree', () => {
    expect(
      richTextToMarkup([
        {
          kind: 'paragraph',
          spans: [
            { text: 'Voir ' },
            { text: 'la FAQ', bold: true, link: { kind: 'page', path: '/aide' } },
            { text: ' ou ' },
            { text: '*', italic: true },
          ],
        },
        { kind: 'heading', level: 3, text: 'Titre \\ barre' },
        { kind: 'paragraph', spans: [{ text: '- pas une liste' }] },
      ]),
    ).toBe('Voir [**la FAQ**](/aide) ou *\\**\n\n### Titre \\\\ barre\n\n\\- pas une liste');
  });

  it('round-trips any tree through the syntax', () => {
    // Deterministic pseudo-random trees that use every special character.
    let seed = 42;
    const random = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % max;
    };
    const alphabet = [
      'a',
      'é',
      '*',
      '[',
      ']',
      '(',
      ')',
      '\\',
      '#',
      '-',
      '1.',
      '<b>',
      '_',
      '`',
      ' ',
    ];
    const word = () =>
      Array.from({ length: 1 + random(4) }, () => alphabet[random(alphabet.length)]).join('');
    const links = [
      undefined,
      undefined,
      { kind: 'page', path: '/paris-dakar' } as const,
      { kind: 'anchor', id: 'faq' } as const,
      { kind: 'app', app: 'booking' } as const,
      { kind: 'url', url: 'https://example.org/x?y=1' } as const,
    ];
    const spans = (): Span[] => {
      const result = Array.from({ length: 1 + random(5) }, (): Span => {
        const link = links[random(links.length)];
        return {
          text: word().replace(/\s+/g, ' '),
          ...(random(2) ? { bold: true } : {}),
          ...(random(2) ? { italic: true } : {}),
          ...(link ? { link } : {}),
        };
      });
      // A paragraph is trimmed by the text area: no edge spaces.
      const first = result[0]!;
      first.text = first.text.trimStart() || 'x';
      const last = result.at(-1)!;
      last.text = last.text.trimEnd() || 'x';
      return normalizeSpans(result).map((span) => ({
        ...span,
        text: span.text.replace(/ {2,}/g, ' '),
      }));
    };
    for (let run = 0; run < 400; run += 1) {
      const tree: RichText = Array.from({ length: 1 + random(4) }, (): RichNode => {
        const kind = random(3);
        if (kind === 0) {
          return {
            kind: 'heading',
            level: random(2) ? 2 : 3,
            text: word().trim() || 'Titre',
          };
        }
        if (kind === 1) return { kind: 'paragraph', spans: spans() };
        return {
          kind: 'list',
          ordered: Boolean(random(2)),
          items: Array.from({ length: 1 + random(3) }, spans),
        };
      });
      const markup = richTextToMarkup(tree);
      expect({ run, value: markupToRichText(markup) }).toEqual({
        run,
        value: { ok: true, value: tree },
      });
    }
  });
});
