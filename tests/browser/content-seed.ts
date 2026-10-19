/** WEB-1: the CMS page published by global-setup for this run. */
export function contentSeed() {
  const raw = process.env.E2E_RUN_ID;
  if (!raw) throw new Error('E2E_RUN_ID is set by global-setup.ts');
  return { path: `/e2e-contenu-${raw}`, title: `Page CMS ${raw}` };
}

/**
 * UI-PUBLIC-1: a published, non-indexable page laid out like the home page,
 * whose search and departures use the stops of the booking seed (real trips).
 */
export function homeSeed() {
  const raw = process.env.E2E_RUN_ID;
  if (!raw) throw new Error('E2E_RUN_ID is set by global-setup.ts');
  return { path: `/e2e-accueil-${raw}`, title: `Accueil ${raw}` };
}

/**
 * UI-PUBLIC-2: a trip page, a coaches page and a services page, published
 * for this run on their own synthetic network (stops in Paris and Dakar
 * timezones, a border and a technical checkpoint, two scheduled trips) and
 * two active coaches with their real equipment. Nothing here is a real
 * schedule, fare or vehicle.
 */
export function pagesSeed() {
  const raw = process.env.E2E_RUN_ID;
  if (!raw) throw new Error('E2E_RUN_ID is set by global-setup.ts');
  const run = raw.toUpperCase();
  return {
    trip: { path: `/e2e-voyage-${raw}`, title: `Voyage ${raw}` },
    fleet: { path: `/e2e-nos-bus-${raw}`, title: `Nos autocars ${raw}` },
    services: { path: `/e2e-services-${raw}`, title: `Nos services ${raw}` },
    originCode: `UIP_A_${run}`,
    viaCode: `UIP_V_${run}`,
    destinationCode: `UIP_B_${run}`,
    borderCode: `UIP_K_${run}`,
    technicalCode: `UIP_T_${run}`,
    routeCode: `UIPR_${run}`,
    seatMapCode: `UIPM_${run}`,
    fareTableCode: `UIPF_${run}`,
    coaches: [
      { code: `UIP_C1_${run}`, name: `Teranga E2E 01 ${raw}` },
      { code: `UIP_C2_${run}`, name: `Teranga E2E 02 ${raw}` },
    ],
    trips: [
      {
        reference: `ET-UIP-${run}-1`,
        // 08:30 in Paris (summer time), 22:15 the next day in Dakar.
        departureAt: '2030-07-10T06:30:00.000Z',
        arrivalAt: '2030-07-11T22:15:00.000Z',
      },
      {
        reference: `ET-UIP-${run}-2`,
        departureAt: '2030-07-24T06:30:00.000Z',
        arrivalAt: '2030-07-25T22:15:00.000Z',
      },
    ],
    unitAmountMinor: 24_900,
  };
}
