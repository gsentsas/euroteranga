/**
 * Stable keys of the permissions and system roles seeded by the PR-03
 * migration. The database catalogue (authorization_permission,
 * authorization_role, authorization_role_permission) is the single source of
 * truth for which role holds which permission and in which realm; these
 * constants only give type-safe references to the keys, and a test checks
 * they match the database.
 */
export const PERMISSIONS = {
  OPS_ACCESS: 'ops.access',
  IDENTITY_READ: 'identity.read',
  STAFF_PROVISION: 'identity.staff.provision',
  IDENTITY_STATUS_MANAGE: 'identity.status.manage',
  ROLE_READ: 'role.read',
  ROLE_ASSIGN: 'role.assign',
  PRIVILEGED_MANAGE: 'privileged.manage',
  AUDIT_READ: 'audit.read',
  SESSION_REVOKE_ANY: 'session.revoke.any',
  MFA_ENROLLMENT_AUTHORIZE: 'mfa.enrollment.authorize',
  NETWORK_READ: 'network.read',
  NETWORK_MANAGE: 'network.manage',
  FLEET_READ: 'fleet.read',
  FLEET_MANAGE: 'fleet.manage',
  TRIP_READ: 'trip.read',
  TRIP_MANAGE: 'trip.manage',
  SEATMAP_READ: 'seatmap.read',
  SEATMAP_MANAGE: 'seatmap.manage',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const SYSTEM_ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  DIRECTOR: 'DIRECTOR',
  OPS_MANAGER: 'OPS_MANAGER',
  DISPATCHER: 'DISPATCHER',
  BOOKING_AGENT: 'BOOKING_AGENT',
  COMPLIANCE_AGENT: 'COMPLIANCE_AGENT',
  FINANCE: 'FINANCE',
  CUSTOMER_SUPPORT: 'CUSTOMER_SUPPORT',
  AUDITOR: 'AUDITOR',
  DRIVER: 'DRIVER',
  CREW: 'CREW',
} as const;

export type SystemRoleKey = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];
