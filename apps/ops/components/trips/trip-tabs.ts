/** Tabs of the trip cockpit; the id is the `onglet` value of `/trips?fiche=<id>&onglet=<tab>`. */
export const TRIP_TABS = [
  { id: 'apercu', label: 'Vue d’ensemble' },
  { id: 'itineraire', label: 'Itinéraire' },
  { id: 'passagers', label: 'Passagers' },
  { id: 'bagages', label: 'Bagages' },
  { id: 'colis-fret', label: 'Colis & fret' },
  { id: 'tarification', label: 'Tarification' },
  { id: 'couts', label: 'Coûts' },
  { id: 'vehicules', label: 'Véhicules' },
  { id: 'documents', label: 'Documents' },
  { id: 'historique', label: 'Historique' },
] as const;

export type TripTabId = (typeof TRIP_TABS)[number]['id'];

export const DEFAULT_TRIP_TAB: TripTabId = 'apercu';

export function isTripTabId(value: string | null): value is TripTabId {
  return TRIP_TABS.some((tab) => tab.id === value);
}
