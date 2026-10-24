import type { OpsIconName } from './ops-icons';

export const OPS_NAV_GROUPS = [
  { key: 'operations', label: 'Opérations' },
  { key: 'commercial', label: 'Commercial & finance' },
  { key: 'exploitation', label: 'Exploitation' },
  { key: 'compliance', label: 'Conformité' },
  { key: 'site', label: 'Site public' },
  { key: 'admin', label: 'Administration' },
] as const;

export type OpsNavGroupKey = (typeof OPS_NAV_GROUPS)[number]['key'];

export type OpsResource = {
  name: string;
  list: string;
  label: string;
  group: OpsNavGroupKey;
  icon: OpsIconName;
  permission?: string;
};

export const OPS_RESOURCES: readonly OpsResource[] = [
  {
    name: 'foundation',
    list: '/',
    label: 'Vue d’ensemble',
    group: 'operations',
    icon: 'dashboard',
  },
  {
    name: 'network',
    list: '/network',
    label: 'Réseau',
    group: 'operations',
    icon: 'network',
    permission: 'network.read',
  },
  {
    name: 'fleet',
    list: '/fleet',
    label: 'Flotte',
    group: 'operations',
    icon: 'bus',
    permission: 'fleet.read',
  },
  {
    name: 'trips',
    list: '/trips',
    label: 'Voyages',
    group: 'operations',
    icon: 'route',
    permission: 'trip.read',
  },
  {
    name: 'tracking',
    list: '/tracking',
    label: 'Tracking',
    group: 'operations',
    icon: 'location',
    permission: 'tracking.read',
  },
  {
    name: 'incidents',
    list: '/incidents',
    label: 'Incidents',
    group: 'operations',
    icon: 'alert',
    permission: 'incident.read',
  },
  {
    name: 'seat-maps',
    list: '/seat-maps',
    label: 'Plans de sièges',
    group: 'commercial',
    icon: 'seat',
    permission: 'seatmap.read',
  },
  {
    name: 'pricing',
    list: '/pricing',
    label: 'Tarification',
    group: 'commercial',
    icon: 'pricing',
    permission: 'pricing.read',
  },
  {
    name: 'bookings',
    list: '/bookings',
    label: 'Réservations',
    group: 'commercial',
    icon: 'booking',
    permission: 'booking.read',
  },
  {
    name: 'payments',
    list: '/payments',
    label: 'Paiements',
    group: 'commercial',
    icon: 'payment',
    permission: 'payment.read',
  },
  {
    name: 'finance',
    list: '/finance',
    label: 'Finance',
    group: 'commercial',
    icon: 'finance',
    permission: 'finance.read',
  },
  {
    name: 'reporting',
    list: '/reporting',
    label: 'Reporting',
    group: 'commercial',
    icon: 'chart',
    permission: 'reporting.view',
  },
  {
    name: 'baggage',
    list: '/baggage',
    label: 'Bagages',
    group: 'exploitation',
    icon: 'baggage',
    permission: 'baggage.read',
  },
  {
    name: 'cargo',
    list: '/cargo',
    label: 'Colis & fret',
    group: 'exploitation',
    icon: 'cargo',
    permission: 'cargo.read',
  },
  {
    name: 'check-in',
    list: '/check-in',
    label: 'Check-in / Embarquement',
    group: 'exploitation',
    icon: 'check',
    permission: 'checkin.read',
  },
  {
    name: 'manifests',
    list: '/manifests',
    label: 'Manifestes passagers',
    group: 'exploitation',
    icon: 'manifest',
    permission: 'manifest.read',
  },
  {
    name: 'regulatory-permits',
    list: '/regulatory-permits',
    label: 'Autorisations réglementaires',
    group: 'exploitation',
    icon: 'permit',
    permission: 'permit.read',
  },
  {
    name: 'departure',
    list: '/departure',
    label: 'Départ / Dispatch',
    group: 'exploitation',
    icon: 'dispatch',
    permission: 'departure.read',
  },
  {
    name: 'passenger-documents',
    list: '/passenger-documents',
    label: 'Documents passagers',
    group: 'compliance',
    icon: 'document',
    permission: 'passenger.document.read',
  },
  {
    name: 'compliance-rules',
    list: '/compliance/rules',
    label: 'Règles réglementaires',
    group: 'compliance',
    icon: 'shield',
    permission: 'compliance.rule.read',
  },
  {
    name: 'compliance-reviews',
    list: '/compliance/reviews',
    label: 'Revues passagers',
    group: 'compliance',
    icon: 'review',
    permission: 'compliance.read',
  },
  {
    name: 'content',
    list: '/contenus',
    label: 'Contenus du site',
    group: 'site',
    icon: 'content',
    permission: 'content.read',
  },
  {
    name: 'media',
    list: '/mediatheque',
    label: 'Médiathèque',
    group: 'site',
    icon: 'media',
    permission: 'media.read',
  },
  {
    name: 'admin-identities',
    list: '/admin/utilisateurs',
    label: 'Utilisateurs',
    group: 'admin',
    icon: 'users',
    permission: 'identity.read',
  },
  {
    name: 'admin-roles',
    list: '/admin/roles',
    label: 'Rôles',
    group: 'admin',
    icon: 'roles',
    permission: 'role.read',
  },
  {
    name: 'admin-audit',
    list: '/admin/audit',
    label: 'Journal d’audit',
    group: 'admin',
    icon: 'audit',
    permission: 'audit.read',
  },
];

export function opsResource(name: string): OpsResource | undefined {
  return OPS_RESOURCES.find((resource) => resource.name === name);
}

export function opsResourceForPath(pathname: string): OpsResource {
  return (
    [...OPS_RESOURCES]
      .filter(
        (resource) =>
          resource.list === '/' ||
          pathname === resource.list ||
          pathname.startsWith(`${resource.list}/`),
      )
      .sort((left, right) => right.list.length - left.list.length)[0] ?? OPS_RESOURCES[0]!
  );
}

export function opsGroupLabel(group: OpsNavGroupKey): string {
  return OPS_NAV_GROUPS.find((candidate) => candidate.key === group)?.label ?? 'Opérations';
}
