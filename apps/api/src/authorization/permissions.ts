export const PERMISSIONS = {
  IDENTITY_READ: 'identity.read',
  STAFF_PROVISION: 'identity.staff.provision',
  IDENTITY_STATUS_MANAGE: 'identity.status.manage',
  ROLE_READ: 'role.read',
  ROLE_ASSIGN: 'role.assign',
  AUDIT_READ: 'audit.read',
  SESSION_REVOKE_ANY: 'session.revoke.any',
  MFA_ENROLLMENT_AUTHORIZE: 'mfa.enrollment.authorize',
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
  DRIVER: 'DRIVER',
  CREW: 'CREW',
  AUDITOR: 'AUDITOR',
} as const;

export type SystemRoleKey = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];
