'use client';

import type { NetworkCountry, VehicleCreateInput } from '@euroteranga/auth-client';
import { TextField } from '@euroteranga/ui';
import { useId } from 'react';

export interface VehicleFormValues {
  code: string;
  manufacturer: string;
  model: string;
  modelYear: string;
  vin: string;
  registrationPlate: string;
  registrationCountryId: string;
}

export const EMPTY_VEHICLE: VehicleFormValues = {
  code: '',
  manufacturer: '',
  model: '',
  modelYear: '',
  vin: '',
  registrationPlate: '',
  registrationCountryId: '',
};

/** Empty optional fields are sent as null so that they can be cleared. */
export function toVehicleInput(values: VehicleFormValues): VehicleCreateInput {
  return {
    code: values.code,
    manufacturer: values.manufacturer,
    model: values.model,
    modelYear: values.modelYear.trim() ? Number(values.modelYear) : null,
    vin: values.vin.trim() || null,
    registrationPlate: values.registrationPlate.trim() || null,
    registrationCountryId: values.registrationCountryId || null,
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
  const countryId = useId();
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
    </>
  );
}
