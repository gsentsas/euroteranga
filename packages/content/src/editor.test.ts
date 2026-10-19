import { describe, expect, it } from 'vitest';
import { DEFAULT_HOME_PAGE } from './defaults.js';
import {
  BLOCK_DESCRIPTIONS,
  BLOCK_LABELS,
  describeIssue,
  editorIssues,
  getIn,
  moveItem,
  newBlock,
  setIn,
} from './editor.js';
import { BLOCK_TYPES, blockSchema, pageDocumentSchema, siteSettingsSchema } from './schemas.js';

describe('content editor support (CMS-2)', () => {
  it('labels and describes every block type', () => {
    for (const type of BLOCK_TYPES) {
      expect(BLOCK_LABELS[type]).toBeTruthy();
      expect(BLOCK_DESCRIPTIONS[type]).toBeTruthy();
    }
  });

  it('starts every new section empty, so it cannot be published unfilled', () => {
    for (const type of BLOCK_TYPES) {
      const block = newBlock(type);
      expect(block.type).toBe(type);
      const result = blockSchema.safeParse(block);
      expect({ type, success: result.success }).toEqual({ type, success: false });
    }
  });

  it('turns validation issues into French messages with their path', () => {
    const page = setIn(DEFAULT_HOME_PAGE, ['blocks', 0, 'title'], '');
    const tooLong = setIn(page, ['seo', 'description'], 'x'.repeat(171));
    const result = pageDocumentSchema.safeParse(tooLong);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(editorIssues(result.error.issues)).toEqual(
      expect.arrayContaining([
        { path: 'blocks.0.title', message: 'Champ obligatoire.' },
        { path: 'seo.description', message: '170 caractères au maximum.' },
      ]),
    );

    const settings = siteSettingsSchema.safeParse({
      contact: { email: 'pas-un-email', phone: null, address: null, hours: null },
    });
    expect(settings.success).toBe(false);
    if (settings.success) return;
    const messages = editorIssues(settings.error.issues).map((issue) => issue.message);
    expect(messages).toContain('Adresse e-mail invalide.');
    expect(messages).toContain('Champ obligatoire.');

    expect(
      describeIssue({ code: 'too_small', origin: 'array', minimum: 1, path: [], message: '' }),
    ).toBe('Ajoutez au moins 1 élément.');
    expect(
      describeIssue({ code: 'too_big', origin: 'array', maximum: 12, path: [], message: '' }),
    ).toBe('12 éléments au maximum.');
    expect(
      describeIssue({ code: 'too_small', origin: 'string', minimum: 3, path: [], message: '' }),
    ).toBe('Au moins 3 caractères.');
    expect(
      describeIssue({ code: 'custom', path: [], message: 'une seule section hero par page' }),
    ).toBe('Une seule section hero par page.');
    expect(
      describeIssue({
        code: 'invalid_format',
        format: 'regex',
        path: [],
        message: 'ancre invalide',
      }),
    ).toBe('Ancre invalide.');
    expect(describeIssue({ code: 'invalid_format', format: 'uuid', path: [], message: '' })).toBe(
      'Choisissez une image de la médiathèque.',
    );
    expect(
      describeIssue({ code: 'unrecognized_keys', keys: ['html'], path: [], message: '' }),
    ).toBe('Champ inconnu : html.');
    expect(describeIssue({ code: 'invalid_union', path: [], message: '' })).toBe('Choix invalide.');
  });

  it('updates a document immutably by path', () => {
    const original = {
      title: 'A',
      seo: { title: 'T', description: 'D' },
      blocks: [{ n: 1 }, { n: 2 }],
    };
    const renamed = setIn(original, ['blocks', 1, 'n'], 3);
    expect(renamed.blocks[1]).toEqual({ n: 3 });
    expect(original.blocks[1]).toEqual({ n: 2 });
    expect(renamed.blocks[0]).toBe(original.blocks[0]);

    const cleared = setIn(original, ['seo', 'title'], undefined);
    expect(cleared.seo).toEqual({ description: 'D' });
    expect('title' in cleared.seo).toBe(false);
    expect(original.seo.title).toBe('T');

    expect(getIn(original, ['blocks', 0, 'n'])).toBe(1);
    expect(getIn(original, ['blocks', 5, 'n'])).toBeUndefined();
    expect(getIn(original, ['title', 'x'])).toBeUndefined();

    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b'], 1, 2)).toEqual(['a', 'b']);
  });
});
