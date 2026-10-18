'use client';

import {
  BLOCK_DESCRIPTIONS,
  BLOCK_LABELS,
  BLOCK_TYPES,
  type CONTENT_ICONS,
  type CONTENT_ILLUSTRATIONS,
  type ROUTE_DIRECTIONS,
  moveItem,
  newBlock,
  type ContentBlock,
  type ContentBlockType,
  type DocumentPath,
} from '@euroteranga/content';
import { useEffect, useId, useState } from 'react';
import { useEditor } from './editor-context';
import {
  CheckboxField,
  LinkFields,
  ListField,
  MediaField,
  RichTextField,
  SelectField,
  TextField,
  useStableKeys,
} from './fields';

const ICON_LABELS: Record<(typeof CONTENT_ICONS)[number], string> = {
  ticket: 'Billet',
  pin: 'Repère',
  luggage: 'Bagage',
  shield: 'Bouclier',
  bus: 'Autocar',
  clock: 'Horloge',
  support: 'Assistance',
  route: 'Itinéraire',
  seat: 'Siège',
  phone: 'Téléphone',
  mail: 'Courriel',
};

const ILLUSTRATION_LABELS: Record<(typeof CONTENT_ILLUSTRATIONS)[number], string> = {
  none: 'Aucune',
  route: 'Itinéraire Paris ↔ Dakar',
  tracking: 'Suivi du trajet',
  coach: 'Autocar',
};

const DIRECTION_LABELS: Record<(typeof ROUTE_DIRECTIONS)[number], string> = {
  'PAR-DKR': 'Paris → Dakar',
  'DKR-PAR': 'Dakar → Paris',
};

const entries = <K extends string>(labels: Record<K, string>) =>
  Object.entries(labels) as Array<[K, string]>;

/** Anchor and kicker, shared by every section. */
function SectionHeadFields({ path }: { path: DocumentPath }) {
  return (
    <div className="ops-content-grid">
      <TextField
        path={[...path, 'kicker']}
        label="Surtitre"
        max={60}
        hint="Petit texte au-dessus du titre de la section."
      />
      <TextField
        path={[...path, 'anchor']}
        label="Ancre"
        max={41}
        hint="Permet un lien direct vers la section (#ancre) : minuscules, chiffres, tirets."
      />
    </div>
  );
}

function BlockFields({ block, path }: { block: ContentBlock; path: DocumentPath }) {
  switch (block.type) {
    case 'hero':
      return (
        <>
          <TextField path={[...path, 'eyebrow']} label="Accroche" max={80} />
          <TextField path={[...path, 'title']} label="Titre principal (H1)" max={140} required />
          <TextField path={[...path, 'lead']} label="Introduction" max={400} multiline />
          <LinkFields path={[...path, 'primaryCta']} legend="Bouton principal" optional />
          <LinkFields path={[...path, 'secondaryCta']} legend="Bouton secondaire" optional />
          <TextField path={[...path, 'note']} label="Note sous les boutons" max={240} />
          <MediaField path={[...path, 'mediaId']} label="Image de fond" />
          <CheckboxField
            path={[...path, 'journeyCard']}
            label="Afficher la carte du trajet Paris ↔ Dakar"
            hint="Le prix « à partir de » de la carte vient de la tarification."
          />
        </>
      );
    case 'richText':
      return (
        <>
          <TextField path={[...path, 'title']} label="Titre (H2)" max={160} />
          <RichTextField path={[...path, 'body']} label="Texte" rows={10} />
        </>
      );
    case 'textImage':
      return (
        <>
          <TextField path={[...path, 'title']} label="Titre (H2)" max={160} required />
          <RichTextField path={[...path, 'body']} label="Texte" />
          <MediaField path={[...path, 'mediaId']} label="Image" />
          <div className="ops-content-grid">
            <SelectField
              path={[...path, 'illustration']}
              label="Illustration (sans image)"
              options={entries(ILLUSTRATION_LABELS)}
            />
            <SelectField
              path={[...path, 'imageSide']}
              label="Position de l’image"
              options={[
                ['start', 'À gauche'],
                ['end', 'À droite'],
              ]}
            />
          </div>
          <LinkFields path={[...path, 'cta']} legend="Lien" optional />
        </>
      );
    case 'image':
      return (
        <>
          <MediaField path={[...path, 'mediaId']} label="Image" required />
          <TextField path={[...path, 'caption']} label="Légende" max={240} />
          <SelectField
            path={[...path, 'layout']}
            label="Largeur"
            options={[
              ['contained', 'Largeur du texte'],
              ['wide', 'Pleine largeur'],
            ]}
          />
        </>
      );
    case 'cta':
      return (
        <>
          <TextField path={[...path, 'title']} label="Titre (H2)" max={160} required />
          <TextField path={[...path, 'text']} label="Texte" max={400} multiline />
          <LinkFields path={[...path, 'button']} legend="Bouton" />
          <div className="ops-content-grid">
            <SelectField
              path={[...path, 'tone']}
              label="Fond"
              options={[
                ['light', 'Clair'],
                ['dark', 'Foncé'],
              ]}
            />
            <SelectField
              path={[...path, 'illustration']}
              label="Illustration"
              options={entries(ILLUSTRATION_LABELS)}
            />
          </div>
        </>
      );
    case 'cards':
      return (
        <>
          <TextField path={[...path, 'title']} label="Titre (H2)" max={160} required />
          <TextField path={[...path, 'intro']} label="Introduction" max={400} multiline />
          <SelectField
            path={[...path, 'variant']}
            label="Présentation"
            options={[
              ['features', 'Avantages'],
              ['services', 'Services'],
              ['steps', 'Étapes numérotées'],
              ['trust', 'Garanties'],
            ]}
          />
          <ListField
            path={[...path, 'items']}
            legend="Cartes"
            itemLabel={(index) => `Carte ${index + 1}`}
            min={1}
            max={12}
            addLabel="Ajouter une carte"
            create={() => ({ title: '', text: '' })}
            render={(itemPath) => (
              <>
                <SelectField
                  path={[...itemPath, 'icon']}
                  label="Icône"
                  options={entries(ICON_LABELS)}
                  optional
                />
                <TextField path={[...itemPath, 'title']} label="Titre" max={100} required />
                <TextField
                  path={[...itemPath, 'text']}
                  label="Texte"
                  max={400}
                  required
                  multiline
                />
                <LinkFields path={[...itemPath, 'link']} legend="Lien" optional />
              </>
            )}
          />
        </>
      );
    case 'faq':
      return (
        <>
          <TextField path={[...path, 'title']} label="Titre (H2)" max={160} required />
          <ListField
            path={[...path, 'items']}
            legend="Questions"
            itemLabel={(index) => `Question ${index + 1}`}
            min={1}
            max={40}
            addLabel="Ajouter une question"
            create={() => ({ question: '', answer: [] })}
            render={(itemPath) => (
              <>
                <TextField path={[...itemPath, 'question']} label="Question" max={200} required />
                <RichTextField path={[...itemPath, 'answer']} label="Réponse" rows={4} />
              </>
            )}
          />
        </>
      );
    case 'routes':
      return (
        <>
          <TextField path={[...path, 'title']} label="Titre (H2)" max={160} required />
          <TextField path={[...path, 'intro']} label="Introduction" max={400} multiline />
          <CheckboxField
            path={[...path, 'showFromPrices']}
            label="Afficher le prix « à partir de » de chaque sens"
            hint="Le prix est lu sur la tarification au moment de l’affichage ; il ne se saisit jamais ici."
          />
          <ListField
            path={[...path, 'items']}
            legend="Trajets"
            itemLabel={(index) => `Trajet ${index + 1}`}
            min={1}
            max={6}
            addLabel="Ajouter un trajet"
            create={() => ({ direction: 'PAR-DKR', label: '', title: '', text: '' })}
            render={(itemPath) => (
              <>
                <SelectField
                  path={[...itemPath, 'direction']}
                  label="Sens"
                  options={entries(DIRECTION_LABELS)}
                />
                <TextField path={[...itemPath, 'label']} label="Libellé court" max={60} required />
                <TextField path={[...itemPath, 'title']} label="Titre" max={100} required />
                <TextField
                  path={[...itemPath, 'text']}
                  label="Texte"
                  max={400}
                  required
                  multiline
                />
                <LinkFields path={[...itemPath, 'link']} legend="Lien" optional />
              </>
            )}
          />
        </>
      );
    case 'stats':
      return (
        <>
          <p className="ops-content-warning">
            N’affichez que des chiffres vérifiables (par exemple « 2 sens de circulation »). Un
            chiffre de clientèle, d’avis ou de sécurité doit pouvoir être prouvé.
          </p>
          <TextField path={[...path, 'title']} label="Titre (H2)" max={160} />
          <ListField
            path={[...path, 'items']}
            legend="Chiffres"
            itemLabel={(index) => `Chiffre ${index + 1}`}
            min={1}
            max={6}
            addLabel="Ajouter un chiffre"
            create={() => ({ value: '', label: '' })}
            render={(itemPath) => (
              <div className="ops-content-grid">
                <TextField path={[...itemPath, 'value']} label="Valeur" max={24} required />
                <TextField path={[...itemPath, 'label']} label="Libellé" max={80} required />
              </div>
            )}
          />
        </>
      );
    case 'gallery':
      return (
        <>
          <TextField path={[...path, 'title']} label="Titre (H2)" max={160} />
          <ListField
            path={[...path, 'items']}
            legend="Images"
            itemLabel={(index) => `Image ${index + 1}`}
            min={1}
            max={12}
            addLabel="Ajouter une image"
            create={() => ({ mediaId: '' })}
            render={(itemPath) => (
              <>
                <MediaField path={[...itemPath, 'mediaId']} label="Image" required />
                <TextField path={[...itemPath, 'caption']} label="Légende" max={160} />
              </>
            )}
          />
        </>
      );
    case 'banner':
      return (
        <>
          <SelectField
            path={[...path, 'tone']}
            label="Type"
            options={[
              ['info', 'Information'],
              ['warning', 'Avertissement'],
              ['success', 'Bonne nouvelle'],
            ]}
          />
          <TextField path={[...path, 'text']} label="Texte" max={300} required multiline />
          <LinkFields path={[...path, 'link']} legend="Lien" optional />
        </>
      );
  }
}

function blockTitle(block: ContentBlock): string {
  const title =
    'title' in block && typeof block.title === 'string' && block.title
      ? block.title
      : block.type === 'banner'
        ? block.text
        : '';
  return title ? ` — ${title.length > 60 ? `${title.slice(0, 57)}…` : title}` : '';
}

/** Open positions after moving the section at `from` to the adjacent `to`. */
function movedOpen(open: ReadonlySet<number>, from: number, to: number): ReadonlySet<number> {
  const next = new Set(open);
  next.delete(from);
  next.delete(to);
  if (open.has(from)) next.add(to);
  if (open.has(to)) next.add(from);
  return next;
}

function removedOpen(open: ReadonlySet<number>, index: number): ReadonlySet<number> {
  return new Set([...open].filter((at) => at !== index).map((at) => (at > index ? at - 1 : at)));
}

/** Shifts the positions at or after `index`, and opens the inserted section. */
function insertedOpen(open: ReadonlySet<number>, index: number): ReadonlySet<number> {
  return new Set([...[...open].map((at) => (at >= index ? at + 1 : at)), index]);
}

/** The ordered sections of a page. */
export function BlocksField({ path }: { path: DocumentPath }) {
  const editor = useEditor();
  const selectId = useId();
  const raw = editor.get(path);
  const blocks = (Array.isArray(raw) ? raw : []) as ContentBlock[];
  const stable = useStableKeys(blocks.length);
  const [adding, setAdding] = useState<ContentBlockType>('richText');
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const heroUsed = blocks.some((block) => block.type === 'hero');
  const invalidPositions = blocks
    .map((_, index) => (editor.hasErrorWithin([...path, index]) ? index : -1))
    .filter((index) => index >= 0)
    .join(',');
  const { setOpenSections } = editor;

  // A section shown because it is invalid stays open once corrected.
  useEffect(() => {
    if (!invalidPositions) return;
    setOpenSections((previous) => {
      const missing = invalidPositions
        .split(',')
        .map(Number)
        .filter((index) => !previous.has(index));
      return missing.length === 0 ? previous : new Set([...previous, ...missing]);
    });
  }, [invalidPositions, setOpenSections]);
  const listError = editor.error(path);

  const toggle = (index: number, value: boolean) =>
    editor.setOpenSections((previous) => {
      if (previous.has(index) === value) return previous;
      const copy = new Set(previous);
      if (value) copy.add(index);
      else copy.delete(index);
      return copy;
    });

  return (
    <section className="ops-content-blocks" aria-labelledby={`${selectId}-title`}>
      <h3 id={`${selectId}-title`}>
        Sections de la page <span className="ops-content-count">({blocks.length}/40)</span>
      </h3>
      {listError ? <p className="et-error ops-content-error">{listError}</p> : null}
      {blocks.length === 0 ? (
        <p className="et-hint">
          Aucune section : la page n’affiche que son titre. Ajoutez une première section.
        </p>
      ) : null}
      <ol className="ops-content-blocks__list">
        {blocks.map((block, index) => {
          const key = stable.keys[index]!;
          const blockPath = [...path, index];
          const invalid = editor.hasErrorWithin(blockPath);
          const name = `Section ${index + 1} : ${BLOCK_LABELS[block.type]}`;
          return (
            <li key={key} className="ops-content-block" data-invalid={invalid || undefined}>
              <details
                open={editor.openSections.has(index) || invalid}
                onToggle={(event) =>
                  toggle(index, (event.currentTarget as HTMLDetailsElement).open)
                }
              >
                <summary>
                  <span className="ops-content-block__name">
                    {name}
                    {blockTitle(block)}
                  </span>
                  {invalid ? (
                    <span className="ops-content-badge ops-content-badge--error">À corriger</span>
                  ) : null}
                </summary>
                <div className="ops-content-block__body">
                  <SectionHeadFields path={blockPath} />
                  <BlockFields block={block} path={blockPath} />
                </div>
              </details>
              {editor.readOnly ? null : (
                <div
                  className="ops-content-item__actions"
                  role="group"
                  aria-label={`Actions : ${name}`}
                >
                  <button
                    type="button"
                    className="et-button et-button--secondary"
                    aria-label={`Monter : ${name}`}
                    disabled={index === 0}
                    onClick={() => {
                      stable.move(index, index - 1);
                      editor.setOpenSections((previous) => movedOpen(previous, index, index - 1));
                      editor.set(path, moveItem(blocks, index, index - 1));
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="et-button et-button--secondary"
                    aria-label={`Descendre : ${name}`}
                    disabled={index === blocks.length - 1}
                    onClick={() => {
                      stable.move(index, index + 1);
                      editor.setOpenSections((previous) => movedOpen(previous, index, index + 1));
                      editor.set(path, moveItem(blocks, index, index + 1));
                    }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="et-button et-button--secondary"
                    aria-label={`Dupliquer : ${name}`}
                    disabled={blocks.length >= 40 || block.type === 'hero'}
                    onClick={() => {
                      stable.insert(index + 1);
                      editor.setOpenSections((previous) => insertedOpen(previous, index + 1));
                      const copy = structuredClone(block);
                      // An anchor must stay unique on the page.
                      delete (copy as { anchor?: string }).anchor;
                      editor.set(path, [
                        ...blocks.slice(0, index + 1),
                        copy,
                        ...blocks.slice(index + 1),
                      ]);
                    }}
                  >
                    Dupliquer
                  </button>
                  {confirmRemove === key ? (
                    <span
                      className="ops-content-confirm"
                      role="group"
                      aria-label={`Confirmer : retirer ${name}`}
                    >
                      <button
                        type="button"
                        className="et-button et-button--secondary"
                        autoFocus
                        onClick={() => setConfirmRemove(null)}
                      >
                        Garder
                      </button>
                      <button
                        type="button"
                        className="et-button ops-sensitive-action"
                        onClick={() => {
                          setConfirmRemove(null);
                          stable.remove(index);
                          editor.setOpenSections((previous) => removedOpen(previous, index));
                          editor.set(
                            path,
                            blocks.filter((_, at) => at !== index),
                          );
                        }}
                      >
                        Retirer la section
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="et-button et-button--secondary"
                      aria-label={`Retirer : ${name}`}
                      onClick={() => setConfirmRemove(key)}
                    >
                      Retirer
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {editor.readOnly ? null : (
        <div className="ops-content-add">
          <div className="et-field">
            <label htmlFor={selectId}>Nouvelle section</label>
            <select
              id={selectId}
              className="et-select"
              value={adding}
              aria-describedby={`${selectId}-description`}
              onChange={(event) => setAdding(event.target.value as ContentBlockType)}
            >
              {BLOCK_TYPES.map((type) => (
                <option key={type} value={type} disabled={type === 'hero' && heroUsed}>
                  {BLOCK_LABELS[type]}
                  {type === 'hero' && heroUsed ? ' (déjà présent)' : ''}
                </option>
              ))}
            </select>
            <p id={`${selectId}-description`} className="et-hint">
              {BLOCK_DESCRIPTIONS[adding]}
            </p>
          </div>
          <button
            type="button"
            className="et-button"
            disabled={blocks.length >= 40 || (adding === 'hero' && heroUsed)}
            onClick={() => {
              // A new section is empty, hence invalid, hence open for editing.
              if (adding === 'hero') {
                stable.insert(0);
                editor.setOpenSections((previous) => insertedOpen(previous, 0));
                editor.set(path, [newBlock('hero'), ...blocks]);
              } else {
                stable.add();
                editor.setOpenSections((previous) => new Set([...previous, blocks.length]));
                editor.set(path, [...blocks, newBlock(adding)]);
              }
            }}
          >
            Ajouter la section
          </button>
        </div>
      )}
    </section>
  );
}
