'use client';

import type {
  NetworkCountry,
  VehicleAmenity,
  VehicleCreateInput,
  VehicleRole,
} from '@euroteranga/auth-client';
import { TextField } from '@euroteranga/ui';
import { useId } from 'react';

export interface VehicleFormValues {
  code: string;
  name: string;
  manufacturer: string;
  model: string;
  modelYear: string;
  role: VehicleRole;
  payloadCapacityKg: string;
  cargoVolumeM3: string;
  vin: string;
  registrationPlate: string;
  registrationCountryId: string;
  amenities: VehicleAmenity[];
}

/** Canonical order, as stored by the API; shown on the public website. */
export const VEHICLE_ROLE_LABELS: Record<VehicleRole, string> = {
  PASSENGER_COACH: 'Autocar voyageurs',
  CARGO_SUPPORT: 'Véhicule fret d’appoint',
  MIXED: 'Véhicule mixte voyageurs + fret',
};

const VEHICLE_ROLES = Object.keys(VEHICLE_ROLE_LABELS) as VehicleRole[];

export const AMENITY_LABELS: Record<VehicleAmenity, string> = {
  AIR_CONDITIONING: 'Climatisation',
  RECLINING_SEATS: 'Sièges inclinables',
  USB_CHARGING: 'Prises USB',
  WIFI: 'Wi-Fi',
  TOILET: 'Toilettes',
  ENTERTAINMENT: 'Divertissement à bord',
  WHEELCHAIR_ACCESS: 'Accès fauteuil roulant',
};

const AMENITIES = Object.keys(AMENITY_LABELS) as VehicleAmenity[];

export const EMPTY_VEHICLE: VehicleFormValues = {
  code: '',
  name: '',
  manufacturer: '',
  model: '',
  modelYear: '',
  role: 'PASSENGER_COACH',
  payloadCapacityKg: '',
  cargoVolumeM3: '',
  vin: '',
  registrationPlate: '',
  registrationCountryId: '',
  amenities: [],
};

/** Empty optional fields are sent as null so that they can be cleared. */
export function toVehicleInput(values: VehicleFormValues): VehicleCreateInput {
  return {
    code: values.code,
    name: values.name.trim() || null,
    manufacturer: values.manufacturer,
    model: values.model,
    modelYear: values.modelYear.trim() ? Number(values.modelYear) : null,
    role: values.role,
    payloadCapacityKg: values.payloadCapacityKg.trim()
      ? Number(values.payloadCapacityKg)
      : null,
    cargoVolumeLiters: values.cargoVolumeM3.trim()
      ? Math.round(Number(values.cargoVolumeM3) * 1000)
      : null,
    vin: values.vin.trim() || null,
    registrationPlate: values.registrationPlate.trim() || null,
    registrationCountryId: values.registrationCountryId || null,
    amenities: values.amenities,
  };
}

/**
 * Shared vehicle fields. Labels carry a context word (e.g. "du véhicule")
 * so that a creation form and an edition form on the same page stay
 * distinguishable for assistive technologies and tests.
 */
export function VehicleFields({
  values,
  onChange,
  countries,
  context,
}: {
  values: VehicleFormValues;
  onChange: (values: VehicleFormValues) => void;
  countries: readonly NetworkCountry[] | null;
  context: string;
}) {
  const yearId = useId();
  const roleId = useId();
  const payloadId = useId();
  const volumeId = useId();
  const capacityHintId = useId();
  const countryId = useId();
  const amenitiesId = useId();
  const set = (key: keyof VehicleFormValues) => (value: string) =>
    onChange({ ...values, [key]: value });
  return (
    <>
      <TextField
        label={`Code ${context}`}
        name="code"
        value={values.code}
        onChange={set('code')}
        autoComplete="off"
        maxLength={32}
        hint="Identifiant interne : lettres, chiffres, _ ou -."
      />
      <TextField
        label={`Nom opérationnel ${context} (facultatif)`}
        name="name"
        value={values.name}
        onChange={set('name')}
        autoComplete="off"
        maxLength={80}
        required={false}
        hint="Nom utilisé par les équipes, par exemple « Teranga 01 ». Unique."
      />
      <TextField
        label={`Constructeur ${context}`}
        name="manufacturer"
        value={values.manufacturer}
        onChange={set('manufacturer')}
        autoComplete="off"
        maxLength={80}
      />
      <TextField
        label={`Modèle ${context}`}
        name="model"
        value={values.model}
        onChange={set('model')}
        autoComplete="off"
        maxLength={80}
      />
      <div className="et-field">
        <label htmlFor={yearId}>{`Année modèle ${context} (facultatif)`}</label>
        <input
          id={yearId}
          className="et-input"
          name="modelYear"
          type="number"
          min={1950}
          step={1}
          value={values.modelYear}
          onChange={(event) => set('modelYear')(event.target.value)}
        />
      </div>
      <fieldset className="et-field" aria-describedby={capacityHintId}>
        <legend>{`Capacité opérationnelle ${context}`}</legend>
        <p id={capacityHintId} className="et-hint">
          Les places viennent du plan de sièges. Pour les bagages et le fret, renseignez ensemble
          la charge utile et le volume utile : les deux limites s’appliquent simultanément.
        </p>
        <div className="et-field">
          <label htmlFor={roleId}>{`Usage ${context}`}</label>
          <select
            id={roleId}
            className="et-select"
            value={values.role}
            onChange={(event) =>
              onChange({ ...values, role: event.target.value as VehicleRole })
            }
          >
            {VEHICLE_ROLES.map((role) => (
              <option key={role} value={role}>
                {VEHICLE_ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </div>
        <div className="et-field">
          <label htmlFor={payloadId}>{`Charge utile bagages/fret ${context} (kg)`}</label>
          <input
            id={payloadId}
            className="et-input"
            name="payloadCapacityKg"
            type="number"
            min={1}
            max={100000}
            step={1}
            value={values.payloadCapacityKg}
            required={Boolean(values.cargoVolumeM3)}
            onChange={(event) => set('payloadCapacityKg')(event.target.value)}
          />
        </div>
        <div className="et-field">
          <label htmlFor={volumeId}>{`Volume utile bagages/fret ${context} (m³)`}</label>
          <input
            id={volumeId}
            className="et-input"
            name="cargoVolumeM3"
            type="number"
            min={0.001}
            max={500}
            step={0.001}
            value={values.cargoVolumeM3}
            required={Boolean(values.payloadCapacityKg)}
            onChange={(event) => set('cargoVolumeM3')(event.target.value)}
          />
        </div>
      </fieldset>
      <TextField
        label={`VIN ${context} (facultatif)`}
        name="vin"
        value={values.vin}
        onChange={set('vin')}
        autoComplete="off"
        maxLength={17}
        required={false}
        hint="17 caractères, sans I, O ni Q. Contrôle de forme uniquement."
      />
      <TextField
        label={`Immatriculation ${context} (facultatif)`}
        name="registrationPlate"
        value={values.registrationPlate}
        onChange={set('registrationPlate')}
        autoComplete="off"
        maxLength={16}
        required={false}
        hint="Format libre selon le pays ; à renseigner avec le pays d’immatriculation."
      />
      <div className="et-field">
        <label htmlFor={countryId}>{`Pays d’immatriculation ${context} (facultatif)`}</label>
        <select
          id={countryId}
          className="et-select"
          value={values.registrationCountryId}
          disabled={countries === null}
          onChange={(event) => set('registrationCountryId')(event.target.value)}
        >
          <option value="">Aucun</option>
          {(countries ?? []).map((country) => (
            <option key={country.id} value={country.id}>
              {country.iso2} — {country.name}
            </option>
          ))}
        </select>
        {countries === null ? (
          <p className="et-hint">Liste des pays indisponible (permission réseau requise).</p>
        ) : null}
      </div>
      <fieldset className="et-field et-vehicle-amenities" aria-describedby={`${amenitiesId}-hint`}>
        <legend>{`Équipements à bord ${context}`}</legend>
        <p id={`${amenitiesId}-hint`} className="et-hint">
          Affichés sur le site public pour les véhicules en service. Ne cochez que les équipements
          réellement présents et en état de marche.
        </p>
        {AMENITIES.map((amenity) => (
          <label key={amenity}>
            <input
              type="checkbox"
              name="amenities"
              value={amenity}
              checked={values.amenities.includes(amenity)}
              onChange={(event) =>
                onChange({
                  ...values,
                  amenities: AMENITIES.filter((candidate) =>
                    candidate === amenity
                      ? event.target.checked
                      : values.amenities.includes(candidate),
                  ),
                })
              }
            />{' '}
            {AMENITY_LABELS[amenity]}
          </label>
        ))}
      </fieldset>
    </>
  );
}
