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
import type { BookingSearchStop, PublicVehicle } from '@euroteranga/auth-client';
import { useEffect, useId, useState } from 'react';
import { auth } from '../../lib/auth';
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
  parcel: 'Colis',
  freight: 'Fret (palette)',
};

const ILLUSTRATION_LABELS: Record<(typeof CONTENT_ILLUSTRATIONS)[number], string> = {
  none: 'Aucune',
  route: 'Itinéraire Paris ↔ Dakar',
  tracking: 'Suivi du trajet',
  coach: 'Autocar',
  parcel: 'Colis',
  freight: 'Fret (palette)',
  services: 'Voyageurs, colis et fret',
};

const DIRECTION_LABELS: Record<(typeof ROUTE_DIRECTIONS)[number], string> = {
  'PAR-DKR': 'Paris → Dakar',
  'DKR-PAR': 'Dakar → Paris',
};

const entries = <K extends string>(labels: Record<K, string>) =>
  Object.entries(labels) as Array<[K, string]>;

type StopsState =
  { status: 'loading' } | { status: 'ready'; stops: BookingSearchStop[] } | { status: 'failed' };

/**
 * Active stops of the network, read once per editor (public stops API). A
 * failed read is not cached: the next field that needs the list asks again.
 */
let stopsRequest: Promise<BookingSearchStop[] | null> | null = null;
function useStops(): StopsState {
  const [state, setState] = useState<StopsState>({ status: 'loading' });
  useEffect(() => {
    stopsRequest ??= auth.booking.public.stops({ limit: 50 }).then((result) => {
      if (result.ok) return result.data.items;
      stopsRequest = null;
      return null;
    });
    let current = true;
    void stopsRequest.then((items) => {
      if (current) setState(items ? { status: 'ready', stops: items } : { status: 'failed' });
    });
    return () => {
      current = false;
    };
  }, []);
  return state;
}

/** A stop missing from the first page of the list, resolved by its exact code. */
function useStopByCode(code: string, listed: boolean): BookingSearchStop | null | undefined {
  const [found, setFound] = useState<{ code: string; stop: BookingSearchStop | null } | null>(null);
  useEffect(() => {
    if (!code || listed) return;
    let current = true;
    void auth.booking.public.stops({ query: code, limit: 50 }).then((result) => {
      if (!current || !result.ok) return;
      setFound({ code, stop: result.data.items.find((stop) => stop.code === code) ?? null });
    });
    return () => {
      current = false;
    };
  }, [code, listed]);
  return found?.code === code ? found.stop : undefined;
}

/**
 * A stop of the network, by code (UI-PUBLIC-1): chosen among the active
 * stops, so the website can always find its departures.
 */
function StopCodeField({ path, label }: { path: DocumentPath; label: string }) {
  const editor = useEditor();
  const state = useStops();
  const current = editor.get(path);
  const value = typeof current === 'string' ? current : '';
  const stops = state.status === 'ready' ? state.stops : [];
  const listed = state.status !== 'ready' || stops.some((stop) => stop.code === value);
  const resolved = useStopByCode(value, listed);
  const describe = (stop: BookingSearchStop): [string, string] => [
    stop.code,
    `${stop.code} — ${stop.name} (${stop.locality})`,
  ];
  const options: Array<[string, string]> = stops
    .map(describe)
    .sort((a, b) => a[1].localeCompare(b[1], 'fr'));
  if (value && !options.some(([code]) => code === value)) {
    // Only an answered lookup may call a stop inactive; otherwise keep the bare code.
    options.unshift(
      resolved
        ? describe(resolved)
        : [value, resolved === null ? `${value} — arrêt inactif ou inconnu` : value],
    );
  }
  const hint =
    state.status === 'loading'
      ? 'Chargement des arrêts…'
      : state.status === 'failed'
        ? 'Les arrêts n’ont pas pu être chargés : le code choisi est conservé. Rouvrez la section pour réessayer.'
        : 'Arrêts actifs du réseau.';
  return <SelectField path={path} label={label} options={options} hint={hint} />;
}

type FleetState =
  { status: 'loading' } | { status: 'ready'; vehicles: PublicVehicle[] } | { status: 'failed' };

let fleetRequest: Promise<PublicVehicle[] | null> | null = null;
function useFleet(): FleetState {
  const [state, setState] = useState<FleetState>({ status: 'loading' });
  useEffect(() => {
    fleetRequest ??= auth.booking.public.fleet().then((result) => {
      if (result.ok) return result.data.items;
      fleetRequest = null;
      return null;
    });
    let current = true;
    void fleetRequest.then((items) => {
      if (current) setState(items ? { status: 'ready', vehicles: items } : { status: 'failed' });
    });
    return () => {
      current = false;
    };
  }, []);
  return state;
}

/** An active public vehicle, by code; internal fleet fields never enter content. */
function VehicleCodeField({ path }: { path: DocumentPath }) {
  const editor = useEditor();
  const state = useFleet();
  const raw = editor.get(path);
  const value = typeof raw === 'string' ? raw : '';
  const options: Array<[string, string]> =
    state.status === 'ready'
      ? state.vehicles
          .map((vehicle): [string, string] => [
            vehicle.code,
            `${vehicle.name ?? `${vehicle.manufacturer} ${vehicle.model}`} — ${vehicle.code}`,
          ])
          .sort((a, b) => a[1].localeCompare(b[1], 'fr'))
      : [];
  if (value && !options.some(([code]) => code === value)) {
    options.unshift([value, `${value} — véhicule inactif, inconnu ou non chargé`]);
  }
  // A new presentation starts without a coach: say so instead of showing the
  // first coach as if it were chosen (the document holds an empty code).
  if (!value) options.unshift(['', 'Choisir un autocar']);
  return (
    <SelectField
      path={path}
      label="Autocar"
      options={options}
      hint={
        state.status === 'loading'
          ? 'Chargement des autocars actifs…'
          : state.status === 'failed'
            ? 'La flotte n’a pas pu être chargée : le code choisi est conservé. Rouvrez la section pour réessayer.'
            : 'Autocars actifs exposés par la lecture publique de la flotte.'
      }
    />
  );
}

/** The optional trip search of the hero, pre-filled with a direction. */
function HeroSearchFields({ path }: { path: DocumentPath }) {
  const editor = useEditor();
  const search = editor.get(path);
  const id = useId();
  return (
    <fieldset className="ops-content-link">
      <legend>Recherche de voyage</legend>
      <div className="ops-content-check">
        <input
          id={id}
          type="checkbox"
          checked={search !== undefined}
          disabled={editor.readOnly}
          onChange={(event) =>
            editor.set(path, event.target.checked ? { fromCode: 'PAR', toCode: 'DKR' } : undefined)
          }
        />
        <label htmlFor={id}>
          Afficher la recherche (départ, arrivée, date, voyageurs)
          <span className="et-hint">
            Elle ouvre la réservation préremplie. Elle remplace la carte du trajet.
          </span>
        </label>
      </div>
      {search !== undefined ? (
        <div className="ops-content-grid">
          <StopCodeField path={[...path, 'fromCode']} label="Départ proposé" />
          <StopCodeField path={[...path, 'toCode']} label="Arrivée proposée" />
        </div>
      ) : null}
    </fieldset>
  );
}

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
  const editor = useEditor();
  switch (block.type) {
    case 'hero':
      return (
        <>
          <SelectField
            path={[...path, 'variant']}
            label="Format du bandeau"
            options={[
              ['home', 'Accueil (grand bandeau)'],
              ['page', 'Page intérieure (bandeau compact)'],
            ]}
          />
          <TextField path={[...path, 'eyebrow']} label="Accroche" max={80} />
          <TextField path={[...path, 'title']} label="Titre principal (H1)" max={140} required />
          <TextField
            path={[...path, 'titleAccent']}
            label="Suite du titre, en couleur"
            max={80}
            hint="Deuxième ligne du titre, mise en valeur (par exemple « en toute confiance »)."
          />
          <TextField path={[...path, 'lead']} label="Introduction" max={400} multiline />
          <MediaField path={[...path, 'mediaId']} label="Photo de fond" />
          <SelectField
            path={[...path, 'illustration']}
            label="Illustration sans photo"
            options={[
              ['', 'Autocar (par défaut)'],
              ...entries(ILLUSTRATION_LABELS).filter(([value]) => value !== 'coach'),
            ]}
            hint="Dessin du fond bleu nuit lorsqu’aucune photo n’est choisie (autocar par défaut)."
          />
          <HeroSearchFields path={[...path, 'search']} />
          <LinkFields path={[...path, 'primaryCta']} legend="Bouton principal" optional />
          <LinkFields path={[...path, 'secondaryCta']} legend="Bouton secondaire" optional />
          <TextField path={[...path, 'note']} label="Note" max={240} />
          <CheckboxField
            path={[...path, 'journeyCard']}
            label="Afficher la carte du trajet Paris ↔ Dakar (sans recherche)"
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
            <SelectField
              path={[...path, 'tone']}
              label="Fond"
              options={[
                ['light', 'Clair'],
                ['navy', 'Bleu marine (carte mise en avant)'],
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
