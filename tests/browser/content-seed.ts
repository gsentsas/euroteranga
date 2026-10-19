/** WEB-1: the CMS page published by global-setup for this run. */
export function contentSeed() {
  const raw = process.env.E2E_RUN_ID;
  if (!raw) throw new Error('E2E_RUN_ID is set by global-setup.ts');
  return { path: `/e2e-contenu-${raw}`, title: `Page CMS ${raw}` };
}
