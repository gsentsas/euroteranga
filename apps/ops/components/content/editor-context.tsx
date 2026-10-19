'use client';

import { getIn, pathKey, setIn, type DocumentPath } from '@euroteranga/content';
import { createContext, useContext, useMemo, type ReactNode } from 'react';

/**
 * State shared by every field of the content editor: the working copy of
 * the document, validation issues by path, and the fields that cannot be
 * converted yet (rich text being typed). The API validates again on save.
 */
interface EditorState {
  get(path: DocumentPath): unknown;
  set(path: DocumentPath, value: unknown): void;
  /** Validation message of exactly this path. */
  error(path: DocumentPath): string | undefined;
  /** True when this path or one of its children has an issue. */
  hasErrorWithin(path: DocumentPath): boolean;
  /** Messages of the issues of this path and of its children. */
  errorsWithin(path: DocumentPath): string[];
  id(path: DocumentPath): string;
  reportLocal(path: DocumentPath, message: string | null): void;
  readOnly: boolean;
  canManageSeo: boolean;
  /** Page paths offered for internal links. */
  pagePaths: readonly string[];
  /** Open sections (by position), kept by the editor across saves. */
  openSections: ReadonlySet<number>;
  setOpenSections: (update: (previous: ReadonlySet<number>) => ReadonlySet<number>) => void;
}

const EditorContext = createContext<EditorState | null>(null);

export function useEditor(): EditorState {
  const state = useContext(EditorContext);
  if (!state) throw new Error('useEditor outside of ContentEditorProvider');
  return state;
}

export function fieldId(path: DocumentPath): string {
  return `content-${path.map(String).join('-') || 'document'}`;
}

function within(issues: ReadonlyMap<string, string>, path: DocumentPath): string[] {
  const prefix = pathKey(path);
  const messages: string[] = [];
  for (const [key, message] of issues) {
    if (prefix === '' || key === prefix || key.startsWith(`${prefix}.`)) messages.push(message);
  }
  return messages;
}

export function ContentEditorProvider<T>({
  value,
  onChange,
  issues,
  onLocalError,
  readOnly,
  canManageSeo,
  pagePaths,
  openSections,
  setOpenSections,
  children,
}: {
  value: T;
  /** Receives an update function, so concurrent field changes never overwrite each other. */
  onChange: (update: (previous: T) => T) => void;
  issues: ReadonlyMap<string, string>;
  onLocalError: (key: string, message: string | null) => void;
  readOnly: boolean;
  canManageSeo: boolean;
  pagePaths: readonly string[];
  openSections: ReadonlySet<number>;
  setOpenSections: (update: (previous: ReadonlySet<number>) => ReadonlySet<number>) => void;
  children: ReactNode;
}) {
  const state = useMemo<EditorState>(
    () => ({
      get: (path) => getIn(value, path),
      set: (path, next) => onChange((previous) => setIn(previous, path, next)),
      error: (path) => issues.get(pathKey(path)),
      hasErrorWithin: (path) => within(issues, path).length > 0,
      errorsWithin: (path) => within(issues, path),
      id: fieldId,
      reportLocal: (path, message) => onLocalError(pathKey(path), message),
      readOnly,
      canManageSeo,
      pagePaths,
      openSections,
      setOpenSections,
    }),
    [
      value,
      onChange,
      issues,
      onLocalError,
      readOnly,
      canManageSeo,
      pagePaths,
      openSections,
      setOpenSections,
    ],
  );

  return <EditorContext.Provider value={state}>{children}</EditorContext.Provider>;
}
