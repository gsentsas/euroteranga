import { PublicApiError } from '../auth/http/public-api-error.js';

export const FleetErrors = {
  vehicleNotFound: () => new PublicApiError(404, 'VEHICLE_NOT_FOUND', 'Véhicule introuvable.'),
  countryNotFound: () => new PublicApiError(404, 'COUNTRY_NOT_FOUND', 'Pays introuvable.'),
  identifierConflict: () =>
    new PublicApiError(
      409,
      'VEHICLE_IDENTIFIER_CONFLICT',
      'Ce code, ce VIN ou cette immatriculation est déjà utilisé.',
    ),
  registrationIncomplete: () =>
    new PublicApiError(
      422,
      'VEHICLE_REGISTRATION_INCOMPLETE',
      "L'immatriculation et son pays doivent être renseignés ensemble.",
    ),
  vehicleRetired: () =>
    new PublicApiError(409, 'VEHICLE_RETIRED', 'Un véhicule retiré ne peut plus être modifié.'),
  invalidTransition: () =>
    new PublicApiError(
      409,
      'VEHICLE_STATUS_TRANSITION_INVALID',
      "Ce changement de statut n'est pas autorisé.",
    ),
  statusConflict: () =>
    new PublicApiError(
      409,
      'VEHICLE_STATUS_CONFLICT',
      'Le statut du véhicule a changé entre-temps. Rechargez la fiche.',
    ),
};
