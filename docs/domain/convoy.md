# CONVOY-1 — Convoi opérationnel

## Modèle

Le voyage conserve deux responsabilités distinctes :

- `Trip.vehicleId` : véhicule principal de transport voyageurs ;
- `Trip.supportVehicleId` : véhicule logistique optionnel du convoi.

Le véhicule d’appoint ne remplace jamais le véhicule principal et n’est jamais affecté automatiquement.

## Véhicule d’appoint

Lors d’une affectation, le véhicule doit être :

- `ACTIVE` ;
- de rôle `CARGO_SUPPORT` ;
- différent du véhicule principal ;
- configuré avec `payloadCapacityKg` et `cargoVolumeLiters`.

Le volume est stocké en litres. L’affichage OPS dérive les mètres cubes, par exemple
`20000 L = 20 m³`. Aucune capacité de 20 m³ n’est codée en dur.

## Disponibilité

Un même véhicule physique ne peut pas être utilisé sur deux voyages
`SCHEDULED` ou `IN_PROGRESS` dont les fenêtres planifiées se chevauchent.
La vérification couvre les colonnes principal et support et conserve la sémantique
half-open : deux voyages consécutifs restent possibles.

## Readiness de départ

CONVOY-1 fait évoluer le moteur vers `departure-readiness/2`.
Lorsqu’un support est affecté, son code, son état, son rôle et ses capacités font
partie du snapshot et du fingerprint. Une modification du convoi invalide donc
une ancienne autorisation de départ.

L’absence de support n’est jamais un blocker.

## Permis

Une exigence réglementaire `scopeType=VEHICLE` continue à viser uniquement
le véhicule principal du voyage. CONVOY-1 n’infère aucune obligation juridique
ou réglementaire pour le support.

## Hors périmètre

CONVOY-1 ne réalise pas :

- le déclenchement automatique d’un fourgon ;
- la tarification cargo ;
- le calcul de revenus, marge ou rentabilité ;
- la création automatique d’une ligne de coût ;
- l’exposition du support aux surfaces publiques voyageurs.
