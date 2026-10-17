import { PublicApiError } from '../auth/http/public-api-error.js';

export const IncidentErrors = {
  notFound: () => new PublicApiError(404, 'INCIDENT_NOT_FOUND', 'Incident introuvable.'),
  tripNotFound: () => new PublicApiError(404, 'INCIDENT_TRIP_NOT_FOUND', 'Voyage introuvable.'),
  tripUnavailable: () =>
    new PublicApiError(
      409,
      'INCIDENT_TRIP_UNAVAILABLE',
      'Un incident ne peut être ouvert que pour un voyage planifié ou en cours.',
    ),
  waypointInvalid: () =>
    new PublicApiError(
      422,
      'INCIDENT_WAYPOINT_INVALID',
      'Le point sélectionné n’appartient pas à la route de ce voyage.',
    ),
  baggageInvalid: () =>
    new PublicApiError(
      422,
      'INCIDENT_BAGGAGE_INVALID',
      'Le bagage doit appartenir au voyage et être actuellement manquant ou endommagé.',
    ),
  timestampInvalid: () =>
    new PublicApiError(
      422,
      'INCIDENT_TIMESTAMP_INVALID',
      'La date de l’incident est trop éloignée dans le futur.',
    ),
  idempotencyConflict: () =>
    new PublicApiError(
      409,
      'INCIDENT_CLIENT_EVENT_ID_REUSED',
      'Cet identifiant d’événement a déjà été utilisé avec un autre contenu.',
    ),
  actionIdempotencyConflict: () =>
    new PublicApiError(
      409,
      'INCIDENT_CLIENT_ACTION_ID_REUSED',
      'Cet identifiant d’action a déjà été utilisé avec un autre contenu.',
    ),
  transitionInvalid: () =>
    new PublicApiError(
      409,
      'INCIDENT_TRANSITION_INVALID',
      'La transition d’incident n’est pas valide.',
    ),
  expectedStatusMismatch: () =>
    new PublicApiError(409, 'INCIDENT_STATUS_CHANGED', 'Le statut de l’incident a changé.'),
  criticalMilestoneMissing: () =>
    new PublicApiError(
      409,
      'INCIDENT_CRITICAL_MILESTONE_REQUIRED',
      'Le jalon opérationnel requis doit être documenté avant cette transition.',
    ),
  closed: () =>
    new PublicApiError(409, 'INCIDENT_CLOSED', 'Un incident clôturé ne peut plus être modifié.'),
  ownerInvalid: () =>
    new PublicApiError(
      422,
      'INCIDENT_OWNER_INVALID',
      'Le propriétaire doit être un membre STAFF actif.',
    ),
  crewUnavailable: () =>
    new PublicApiError(
      403,
      'INCIDENT_CREW_NOT_ASSIGNED',
      'Ce voyage n’est pas actuellement affecté à cet équipage.',
    ),
  crewDeviceUnavailable: () =>
    new PublicApiError(
      403,
      'INCIDENT_CREW_DEVICE_UNAVAILABLE',
      'Le dispositif Crew n’est pas autorisé.',
    ),
  attachmentNotFound: () =>
    new PublicApiError(404, 'INCIDENT_ATTACHMENT_NOT_FOUND', 'Pièce jointe introuvable.'),
  attachmentFeatureUnavailable: () =>
    new PublicApiError(
      503,
      'INCIDENT_ATTACHMENT_UNAVAILABLE',
      'Le stockage privé des pièces jointes est temporairement indisponible.',
    ),
  attachmentMalformed: () =>
    new PublicApiError(400, 'INCIDENT_ATTACHMENT_MALFORMED', 'Le fichier envoyé est invalide.'),
  attachmentTooLarge: (maxBytes: number) =>
    new PublicApiError(
      413,
      'INCIDENT_ATTACHMENT_TOO_LARGE',
      'Le fichier dépasse la taille maximale autorisée.',
      { maxBytes: String(maxBytes) },
    ),
  attachmentUnsupported: () =>
    new PublicApiError(
      415,
      'INCIDENT_ATTACHMENT_UNSUPPORTED_MEDIA',
      'Seuls les fichiers PDF, JPEG et PNG sont acceptés.',
    ),
  attachmentMalware: () =>
    new PublicApiError(
      422,
      'INCIDENT_ATTACHMENT_MALWARE_REJECTED',
      'Le fichier a été refusé par le contrôle de sécurité.',
    ),
};
