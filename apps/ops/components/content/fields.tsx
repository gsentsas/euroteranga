'use client';

import {
  APP_TARGETS,
  markupToRichText,
  moveItem,
  richTextToMarkup,
  type DocumentPath,
  type RichText,
} from '@euroteranga/content';
import { useId, useRef, useState, type ReactNode } from 'react';
import { MediaPicker } from '../media/media-picker';
import { useEditor } from './editor-context';

function describedBy(...ids: Array<string | false | null | undefined>): string | undefined {
  const value = ids.filter(Boolean).join(' ');
  return value || undefined;
}

function FieldLabel({
  htmlFor,
  label,
  required,
}: {
  htmlFor: string;
  label: string;
  required: boolean;
}) {
  return (
    <label htmlFor={htmlFor}>
      {label}
      {required ? null : <span className="ops-content-optional"> (facultatif)</span>}
    </label>
  );
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  return message ? (
    <p id={id} className="et-error ops-content-error">
      {message}
    </p>
  ) : null;
}

/** A bounded text; an optional text left empty is removed from the document. */
export function TextField({
  path,
  label,
  max,
  required = false,
  multiline = false,
  rows = 3,
  hint,
  disabled = false,
  list,
}: {
  path: DocumentPath;
  label: string;
  max: number;
  required?: boolean;
  multiline?: boolean;
  rows?: number;
  hint?: string;
  disabled?: boolean;
  /** id of a datalist of suggestions. */
  list?: string;
}) {
  const editor = useEditor();
  const id = editor.id(path);
  const raw = editor.get(path);
  const value = typeof raw === 'string' ? raw : '';
  const error = editor.error(path);
  const props = {
    id,
    value,
    maxLength: max,
    required,
    disabled: editor.readOnly || disabled,
    className: 'et-input',
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy(hint && `${id}-hint`, `${id}-count`, error && `${id}-error`),
    onChange: (event: { target: { value: string } }) =>
      editor.set(path, event.target.value === '' && !required ? undefined : event.target.value),
  };
  return (
    <div className="et-field ops-content-field">
      <FieldLabel htmlFor={id} label={label} required={required} />
      {multiline ? (
        <textarea rows={rows} {...props} />
      ) : (
        <input type="text" list={list} {...props} />
      )}
      <div className="ops-content-field__meta">
        {hint ? (
          <p id={`${id}-hint`} className="et-hint">
            {hint}
          </p>
        ) : (
          <span />
        )}
        <span id={`${id}-count`} className="ops-content-count">
          {value.length}/{max}
          <span className="et-visually-hidden"> caractères</span>
        </span>
      </div>
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

/**
 * Owner information (contact, legal notice): `null` means "not provided
 * yet" and is shown as such, never replaced by an invented value.
 */
export function OwnerTextField({
  path,
  label,
  max,
  multiline = false,
  type = 'text',
}: {
  path: DocumentPath;
  label: string;
  max: number;
  multiline?: boolean;
  type?: 'text' | 'email' | 'tel';
}) {
  const editor = useEditor();
  const id = editor.id(path);
  const raw = editor.get(path);
  const value = typeof raw === 'string' ? raw : '';
  const error = editor.error(path);
  const missing = raw === null || raw === undefined;
  const props = {
    id,
    value,
    maxLength: max,
    disabled: editor.readOnly,
    className: 'et-input',
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy(missing && `${id}-missing`, error && `${id}-error`),
    onChange: (event: { target: { value: string } }) =>
      editor.set(path, event.target.value.trim() === '' ? null : event.target.value),
  };
  return (
    <div className="et-field ops-content-field">
      <label htmlFor={id}>{label}</label>
      {multiline ? <textarea rows={3} {...props} /> : <input type={type} {...props} />}
      {missing ? (
        <p id={`${id}-missing`} className="ops-content-missing">
          À compléter par l’exploitant — non affiché tant qu’il n’est pas renseigné.
        </p>
      ) : null}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

export function SelectField({
  path,
  label,
  options,
  optional = false,
  hint,
  disabled = false,
  onSelect,
}: {
  path: DocumentPath;
  label: string;
  options: ReadonlyArray<readonly [value: string, label: string]>;
  /** Adds a "none" choice that removes the field. */
  optional?: boolean;
  hint?: string;
  disabled?: boolean;
  /** Replaces the default update (e.g. a link kind resets its target). */
  onSelect?: (value: string) => void;
}) {
  const editor = useEditor();
  const id = editor.id(path);
  const raw = editor.get(path);
  const value = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
  const error = editor.error(path);
  return (
    <div className="et-field ops-content-field">
      <FieldLabel htmlFor={id} label={label} required={!optional} />
      <select
        id={id}
        className="et-select"
        value={value}
        disabled={editor.readOnly || disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint && `${id}-hint`, error && `${id}-error`)}
        onChange={(event) => {
          const next = event.target.value;
          if (onSelect) onSelect(next);
          else editor.set(path, next === '' ? undefined : next);
        }}
      >
        {optional ? <option value="">Aucun</option> : null}
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
      {hint ? (
        <p id={`${id}-hint`} className="et-hint">
          {hint}
        </p>
      ) : null}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

export function CheckboxField({
  path,
  label,
  hint,
  disabled = false,
}: {
  path: DocumentPath;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  const editor = useEditor();
  const id = editor.id(path);
  return (
    <div className="ops-content-check">
      <input
        id={id}
        type="checkbox"
        checked={editor.get(path) === true}
        disabled={editor.readOnly || disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => editor.set(path, event.target.checked)}
      />
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <p id={`${id}-hint`} className="et-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

const LINK_KINDS = [
  ['page', 'Page du site'],
  ['anchor', 'Section de la page (ancre)'],
  ['app', 'Application EURO TERANGA'],
  ['url', 'Site externe (https)'],
] as const;

const APP_LABELS: Record<(typeof APP_TARGETS)[number], string> = {
  booking: 'Réservation',
  client: 'Espace client',
  tracking: 'Suivi du trajet',
};

const DEFAULT_TARGETS: Record<string, unknown> = {
  page: { kind: 'page', path: '/' },
  anchor: { kind: 'anchor', id: '' },
  app: { kind: 'app', app: 'booking' },
  url: { kind: 'url', url: '' },
};

/** A typed link: a label and a page, anchor, application or https target. */
export function LinkFields({
  path,
  legend,
  optional = false,
}: {
  path: DocumentPath;
  legend: string;
  optional?: boolean;
}) {
  const editor = useEditor();
  const listId = useId();
  const link = editor.get(path) as { target?: { kind?: string } } | undefined;
  if (!link) {
    return (
      <div className="ops-content-link ops-content-link--empty">
        <span>{legend} : aucun</span>
        {editor.readOnly ? null : (
          <button
            type="button"
            className="et-button et-button--secondary"
            onClick={() => editor.set(path, { label: '', target: DEFAULT_TARGETS.page })}
          >
            Ajouter : {legend.toLowerCase()}
          </button>
        )}
      </div>
    );
  }
  const kind = link.target?.kind ?? 'page';
  const targetPath = [...path, 'target'];
  return (
    <fieldset className="ops-content-link">
      <legend>{legend}</legend>
      <TextField path={[...path, 'label']} label="Texte affiché" max={60} required />
      <SelectField
        path={[...targetPath, 'kind']}
        label="Destination"
        options={LINK_KINDS}
        onSelect={(next) => editor.set(targetPath, DEFAULT_TARGETS[next])}
      />
      {kind === 'page' ? (
        <>
          <TextField
            path={[...targetPath, 'path']}
            label="Chemin de la page"
            max={120}
            required
            list={listId}
            hint="Exemple : /paris-dakar. Les pages existantes sont proposées."
          />
          <datalist id={listId}>
            {editor.pagePaths.map((pagePath) => (
              <option key={pagePath} value={pagePath} />
            ))}
          </datalist>
        </>
      ) : null}
      {kind === 'anchor' ? (
        <TextField
          path={[...targetPath, 'id']}
          label="Ancre de la section"
          max={41}
          required
          hint="L’ancre d’une section de cette page, par exemple faq."
        />
      ) : null}
      {kind === 'app' ? (
        <SelectField
          path={[...targetPath, 'app']}
          label="Application"
          options={APP_TARGETS.map((app) => [app, APP_LABELS[app]] as const)}
        />
      ) : null}
      {kind === 'url' ? (
        <TextField
          path={[...targetPath, 'url']}
          label="Adresse https"
          max={500}
          required
          hint="Adresse complète commençant par https://."
        />
      ) : null}
      {optional && !editor.readOnly ? (
        <button
          type="button"
          className="et-button et-button--secondary"
          onClick={() => editor.set(path, undefined)}
        >
          Retirer : {legend.toLowerCase()}
        </button>
      ) : null}
    </fieldset>
  );
}

type Edit = { text: string; selectionStart: number; selectionEnd: number };

function wrapSelection(edit: Edit, before: string, after: string, placeholder: string): Edit {
  const selected = edit.text.slice(edit.selectionStart, edit.selectionEnd) || placeholder;
  const text =
    edit.text.slice(0, edit.selectionStart) +
    before +
    selected +
    after +
    edit.text.slice(edit.selectionEnd);
  const start = edit.selectionStart + before.length;
  return { text, selectionStart: start, selectionEnd: start + selected.length };
}

function prefixLines(edit: Edit, prefix: (index: number) => string): Edit {
  const lineStart = edit.text.lastIndexOf('\n', edit.selectionStart - 1) + 1;
  const nextBreak = edit.text.indexOf('\n', edit.selectionEnd);
  const lineEnd = nextBreak < 0 ? edit.text.length : nextBreak;
  const lines = edit.text.slice(lineStart, lineEnd).split('\n');
  const replaced = lines.map((line, index) => `${prefix(index)}${line}`).join('\n');
  const text = edit.text.slice(0, lineStart) + replaced + edit.text.slice(lineEnd);
  return { text, selectionStart: lineStart, selectionEnd: lineStart + replaced.length };
}

/**
 * Rich text typed with a small syntax (paragraphs, ## titles, - lists,
 * **bold**, *italic*, [links](/path)) and stored as the typed tree.
 */
export function RichTextField({
  path,
  label,
  hint,
  rows = 6,
}: {
  path: DocumentPath;
  label: string;
  hint?: string;
  rows?: number;
}) {
  const editor = useEditor();
  const id = editor.id(path);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => {
    const value = editor.get(path);
    return Array.isArray(value) && value.length > 0 ? richTextToMarkup(value as RichText) : '';
  });
  const [localError, setLocalError] = useState<string | null>(null);

  const apply = (next: string) => {
    setText(next);
    if (next.trim() === '') {
      setLocalError(null);
      editor.reportLocal(path, null);
      editor.set(path, []);
      return;
    }
    const result = markupToRichText(next);
    if (result.ok) {
      setLocalError(null);
      editor.reportLocal(path, null);
      editor.set(path, result.value);
    } else {
      const message = result.errors
        .slice(0, 3)
        .map((error) => `Ligne ${error.line} : ${error.message}`)
        .join(' · ');
      setLocalError(message);
      editor.reportLocal(path, message);
    }
  };

  const transform = (change: (edit: Edit) => Edit) => {
    const area = ref.current;
    if (!area) return;
    const result = change({
      text,
      selectionStart: area.selectionStart,
      selectionEnd: area.selectionEnd,
    });
    apply(result.text);
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(result.selectionStart, result.selectionEnd);
    });
  };

  const value = editor.get(path);
  const schemaErrors = editor.errorsWithin(path);
  const empty = !Array.isArray(value) || value.length === 0;
  const error =
    localError ??
    (schemaErrors.length > 0
      ? empty
        ? 'Champ obligatoire.'
        : `Texte trop long ou trop découpé : ${schemaErrors[0]}`
      : undefined);

  return (
    <div className="et-field ops-content-field ops-content-rich">
      <label htmlFor={id}>{label}</label>
      {editor.readOnly ? null : (
        <div className="ops-content-toolbar" role="toolbar" aria-label={`Mise en forme : ${label}`}>
          <button
            type="button"
            onClick={() => transform((edit) => wrapSelection(edit, '**', '**', 'texte en gras'))}
          >
            Gras
          </button>
          <button
            type="button"
            onClick={() => transform((edit) => wrapSelection(edit, '*', '*', 'texte en italique'))}
          >
            Italique
          </button>
          <button
            type="button"
            onClick={() => transform((edit) => wrapSelection(edit, '[', '](/)', 'texte du lien'))}
          >
            Lien
          </button>
          <button type="button" onClick={() => transform((edit) => prefixLines(edit, () => '## '))}>
            Intertitre
          </button>
          <button type="button" onClick={() => transform((edit) => prefixLines(edit, () => '- '))}>
            Liste
          </button>
          <button
            type="button"
            onClick={() => transform((edit) => prefixLines(edit, (index) => `${index + 1}. `))}
          >
            Liste numérotée
          </button>
        </div>
      )}
      <textarea
        ref={ref}
        id={id}
        className="et-input ops-content-rich__input"
        rows={rows}
        value={text}
        disabled={editor.readOnly}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(`${id}-help`, hint && `${id}-hint`, error && `${id}-error`)}
        onChange={(event) => apply(event.target.value)}
      />
      {hint ? (
        <p id={`${id}-hint`} className="et-hint">
          {hint}
        </p>
      ) : null}
      <details className="ops-content-help">
        <summary id={`${id}-help`}>Aide à la mise en forme</summary>
        <ul>
          <li>Une ligne vide sépare deux paragraphes.</li>
          <li>
            <code>## Titre</code> ou <code>### Sous-titre</code> pour un intertitre.
          </li>
          <li>
            <code>- élément</code> pour une liste, <code>1. élément</code> pour une liste numérotée.
          </li>
          <li>
            <code>**gras**</code>, <code>*italique*</code>, <code>[texte](/chemin)</code> pour un
            lien vers une page, <code>[texte](#ancre)</code>, <code>[texte](app:booking)</code> ou{' '}
            <code>[texte](https://…)</code>.
          </li>
          <li>
            Un antislash rend le caractère suivant littéral : <code>\*</code>, <code>\[</code>. Le
            code HTML est affiché tel quel, jamais interprété.
          </li>
        </ul>
      </details>
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

let nextKey = 0;
const newKey = () => `item-${(nextKey += 1)}`;

/**
 * Stable React keys for the items of a list: they move with the items, so
 * a field with its own state (rich text being typed) follows its item.
 */
export function useStableKeys(length: number) {
  const [keys, setKeys] = useState<string[]>(() => Array.from({ length }, newKey));
  if (keys.length !== length) {
    // The list was replaced from outside (reload, restore): new identities.
    const fresh = Array.from({ length }, (_, index) => keys[index] ?? newKey());
    setKeys(fresh);
    return {
      keys: fresh,
      move: (_from: number, _to: number) => undefined,
      remove: (_index: number) => undefined,
      add: () => undefined,
      insert: (_index: number) => undefined,
    };
  }
  return {
    keys,
    move: (from: number, to: number) => setKeys((previous) => moveItem(previous, from, to)),
    remove: (index: number) => setKeys((previous) => previous.filter((_, at) => at !== index)),
    add: () => setKeys((previous) => [...previous, newKey()]),
    insert: (index: number) =>
      setKeys((previous) => [...previous.slice(0, index), newKey(), ...previous.slice(index)]),
  };
}

/** An ordered, bounded list with accessible move and remove controls. */
export function ListField({
  path,
  legend,
  itemLabel,
  create,
  render,
  min = 0,
  max,
  addLabel,
}: {
  path: DocumentPath;
  legend: string;
  itemLabel: (index: number) => string;
  create: () => unknown;
  render: (itemPath: DocumentPath, index: number) => ReactNode;
  min?: number;
  max: number;
  addLabel: string;
}) {
  const editor = useEditor();
  const raw = editor.get(path);
  const items = Array.isArray(raw) ? raw : [];
  const error = editor.error(path);
  const id = editor.id(path);
  const stable = useStableKeys(items.length);
  return (
    <fieldset className="ops-content-list" aria-describedby={error ? `${id}-error` : undefined}>
      <legend>
        {legend}{' '}
        <span className="ops-content-count">
          ({items.length}/{max})
        </span>
      </legend>
      {items.length === 0 ? <p className="et-hint">Aucun élément.</p> : null}
      <ol className="ops-content-list__items">
        {items.map((_, index) => {
          const name = itemLabel(index);
          return (
            <li key={stable.keys[index]} className="ops-content-item">
              <div className="ops-content-item__head">
                <strong>{name}</strong>
                {editor.readOnly ? null : (
                  <div className="ops-content-item__actions">
                    <button
                      type="button"
                      className="et-button et-button--secondary"
                      aria-label={`Monter : ${name}`}
                      disabled={index === 0}
                      onClick={() => {
                        stable.move(index, index - 1);
                        editor.set(path, moveItem(items, index, index - 1));
                      }}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="et-button et-button--secondary"
                      aria-label={`Descendre : ${name}`}
                      disabled={index === items.length - 1}
                      onClick={() => {
                        stable.move(index, index + 1);
                        editor.set(path, moveItem(items, index, index + 1));
                      }}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="et-button et-button--secondary"
                      aria-label={`Retirer : ${name}`}
                      disabled={items.length <= min}
                      onClick={() => {
                        stable.remove(index);
                        editor.set(
                          path,
                          items.filter((__, at) => at !== index),
                        );
                      }}
                    >
                      Retirer
                    </button>
                  </div>
                )}
              </div>
              {render([...path, index], index)}
            </li>
          );
        })}
      </ol>
      <FieldError id={`${id}-error`} message={error} />
      {editor.readOnly ? null : (
        <button
          type="button"
          className="et-button et-button--secondary"
          disabled={items.length >= max}
          onClick={() => {
            stable.add();
            editor.set(path, [...items, create()]);
          }}
        >
          {addLabel}
        </button>
      )}
    </fieldset>
  );
}

/**
 * An image of the public media library (MEDIA-1), chosen among the active
 * images. `disabled` locks it like the other fields of its section.
 */
export function MediaField({
  path,
  label,
  required = false,
  disabled = false,
}: {
  path: DocumentPath;
  label: string;
  required?: boolean;
  disabled?: boolean;
}) {
  const editor = useEditor();
  const raw = editor.get(path);
  const mediaId = typeof raw === 'string' && raw ? raw : null;
  const error = editor.error(path);
  const id = editor.id(path);
  return (
    <div className="et-field ops-content-field ops-content-media" id={id} tabIndex={-1}>
      <span className="ops-content-media__label">
        {label}
        {required ? null : <span className="ops-content-optional"> (facultatif)</span>}
      </span>
      <MediaPicker
        mediaId={mediaId}
        readOnly={editor.readOnly || disabled}
        required={required}
        {...(error ? { describedBy: `${id}-error` } : {})}
        onChange={(next) => editor.set(path, next)}
      />
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}
