import type { ContentBlock, ContentBlockType, ContentLink } from './schemas.js';

/**
 * CMS-2: what the OPS editor needs besides the schemas: French labels,
 * empty templates for new sections, readable validation messages and
 * immutable updates by path.
 *
 * A new section starts with empty required texts, so it is refused by the
 * content model until an editor fills it in: nothing placeholder-like can
 * be published by mistake.
 */

export type DocumentPath = ReadonlyArray<string | number>;

export const BLOCK_LABELS: Record<ContentBlockType, string> = {
  hero: 'Bandeau d’accueil',
  richText: 'Texte',
  textImage: 'Texte et image',
  image: 'Image',
  cta: 'Appel à l’action',
  cards: 'Cartes',
  faq: 'Questions fréquentes',
  routes: 'Trajets',
  departures: 'Prochains départs',
  stats: 'Chiffres clés',
  gallery: 'Galerie',
  banner: 'Bandeau d’information',
  ownerInfo: 'Informations propriétaire',
  sectionNav: 'Sommaire de la page',
  itinerary: 'Itinéraire',
  fleet: 'Nos autocars',
};

export const BLOCK_DESCRIPTIONS: Record<ContentBlockType, string> = {
  hero: 'Grand titre en haut de page, sur une photo de la médiathèque, avec recherche de voyage, boutons ou carte du trajet. Une seule par page.',
  richText: 'Paragraphes, intertitres et listes.',
  textImage: 'Texte accompagné d’une image de la médiathèque ou d’une illustration.',
  image: 'Une image de la médiathèque, avec légende.',
  cta: 'Un message court et un bouton.',
  cards:
    'Jusqu’à 12 cartes : avantages, services (avec photo), étapes, garanties ou une rangée d’atouts.',
  faq: 'Questions et réponses, ouvrables une à une.',
  routes:
    'Les sens Paris → Dakar et Dakar → Paris, avec le prix « à partir de » lu sur la tarification.',
  departures:
    'Les prochains départs réellement ouverts, avec dates, places et prix lus sur la réservation et la tarification.',
  stats: 'Quelques chiffres vérifiables. N’indiquez jamais un chiffre non prouvé.',
  gallery: 'Jusqu’à 12 images de la médiathèque.',
  banner: 'Une information courte : travaux, rappel, nouveauté.',
  ownerInfo:
    'Coordonnées, mentions légales ou informations de confidentialité lues depuis les réglages du site. La publication est refusée tant que les valeurs requises manquent.',
  sectionNav:
    'Des onglets vers les sections de la page (Vue d’ensemble, Horaires, Nos autocars…), chacune repérée par son ancre.',
  itinerary:
    'L’itinéraire du prochain départ d’un sens : horaires, arrêts, pays traversés, durée et équipements du car, lus sur les voyages et la flotte.',
  fleet:
    'Les autocars en service : nom, modèle, places et équipements lus sur la flotte, avec vos photos et une description par véhicule.',
};

const emptyLink = (): ContentLink => ({ label: '', target: { kind: 'page', path: '/' } });

/** A new section of the given type, with empty required texts. */
export function newBlock(type: ContentBlockType): ContentBlock {
  switch (type) {
    case 'hero':
      return { type, variant: 'home', title: '', journeyCard: true };
    case 'richText':
      return { type, body: [] };
    case 'textImage':
      return { type, title: '', body: [], illustration: 'none', imageSide: 'end', tone: 'light' };
    case 'image':
      return { type, mediaId: '', layout: 'contained' };
    case 'cta':
      return { type, title: '', button: emptyLink(), tone: 'light', illustration: 'none' };
    case 'cards':
      return { type, variant: 'features', title: '', items: [{ title: '', text: '' }] };
    case 'faq':
      return { type, title: '', items: [{ question: '', answer: [] }] };
    case 'routes':
      return {
        type,
        title: '',
        items: [
          { direction: 'PAR-DKR', label: 'Paris → Dakar', title: '', text: '' },
          { direction: 'DKR-PAR', label: 'Dakar → Paris', title: '', text: '' },
        ],
        showFromPrices: true,
      };
    case 'departures':
      return {
        type,
        title: '',
        routes: [
          { fromCode: 'PAR', toCode: 'DKR' },
          { fromCode: 'DKR', toCode: 'PAR' },
        ],
        limit: 3,
        layout: 'cards',
      };
    case 'stats':
      return { type, items: [{ value: '', label: '' }] };
    case 'gallery':
      return { type, items: [] };
    case 'banner':
      return { type, tone: 'info', text: '' };
    case 'ownerInfo':
      return { type, kind: 'contact', title: '' };
    case 'sectionNav':
      return {
        type,
        label: 'Sur cette page',
        items: [
          { label: '', anchor: '' },
          { label: '', anchor: '' },
        ],
      };
    case 'itinerary':
      return {
        type,
        title: '',
        fromCode: 'PAR',
        toCode: 'DKR',
        included: [],
        showVehicleAmenities: true,
      };
    case 'fleet':
      return { type, title: '', selection: 'all', items: [] };
  }
}

export function pathKey(path: DocumentPath): string {
  return path.map(String).join('.');
}

export function getIn(value: unknown, path: DocumentPath): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

/**
 * Immutable update. `undefined` removes an object key (optional field left
 * empty); arrays are copied, never mutated.
 */
export function setIn<T>(value: T, path: DocumentPath, next: unknown): T {
  if (path.length === 0) return next as T;
  const [head, ...rest] = path as [string | number, ...Array<string | number>];
  if (Array.isArray(value)) {
    const copy = [...value];
    copy[head as number] = setIn(copy[head as number], rest, next);
    return copy as T;
  }
  const source = (value ?? {}) as Record<string, unknown>;
  const child = setIn(source[head], rest, next);
  const copy = { ...source };
  if (child === undefined && rest.length === 0) delete copy[head];
  else copy[head] = child;
  return copy as T;
}

/** Moves an array item; out-of-range moves leave the array unchanged. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length) return [...items];
  const copy = [...items];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item as T);
  return copy;
}

/** The parts of a validation issue the editor reads (zod 4 issue shape). */
export interface EditorIssueSource {
  code: string;
  path: ReadonlyArray<PropertyKey>;
  message: string;
  origin?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  format?: string;
  expected?: string;
  keys?: string[];
}

export interface EditorIssue {
  path: string;
  message: string;
}

const plural = (count: number, word: string) => `${count} ${word}${count > 1 ? 's' : ''}`;

/** A French, editor-oriented message for a validation issue. */
export function describeIssue(issue: EditorIssueSource): string {
  const minimum = Number(issue.minimum ?? 0);
  const maximum = Number(issue.maximum ?? 0);
  switch (issue.code) {
    case 'too_small':
      if (issue.origin === 'string') {
        return minimum <= 1 ? 'Champ obligatoire.' : `Au moins ${plural(minimum, 'caractère')}.`;
      }
      if (issue.origin === 'array') return `Ajoutez au moins ${plural(minimum, 'élément')}.`;
      return 'Valeur trop petite.';
    case 'too_big':
      if (issue.origin === 'string') return `${plural(maximum, 'caractère')} au maximum.`;
      if (issue.origin === 'array') return `${plural(maximum, 'élément')} au maximum.`;
      return 'Valeur trop grande.';
    case 'invalid_format':
      if (issue.format === 'email') return 'Adresse e-mail invalide.';
      if (issue.format === 'uuid') return 'Choisissez une image de la médiathèque.';
      // Every pattern of the content model carries its own French message.
      return issue.message.endsWith('.') ? issue.message : `${capitalize(issue.message)}.`;
    case 'invalid_type':
      return issue.expected === 'string' ? 'Champ obligatoire.' : 'Valeur invalide.';
    case 'invalid_value':
    case 'invalid_union':
      return 'Choix invalide.';
    case 'unrecognized_keys':
      return `Champ inconnu : ${(issue.keys ?? []).join(', ')}.`;
    case 'custom':
      return `${capitalize(issue.message)}${issue.message.endsWith('.') ? '' : '.'}`;
    default:
      return 'Valeur invalide.';
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function editorIssues(issues: readonly EditorIssueSource[]): EditorIssue[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: describeIssue(issue),
  }));
}
