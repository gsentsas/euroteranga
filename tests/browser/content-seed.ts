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
