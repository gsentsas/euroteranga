# shellcheck shell=bash
# Pilot environment guard, sourced by deploy-release.sh after the pilot env
# files are loaded, and exercised by packages/config/src/pilot-env-guard.test.ts.
# The pilot is a staging environment that takes no payment: SANDBOX is refused
# by the API configuration there, and Stripe must stay DISABLED (PAY-EU-1), with
# no Stripe credential at all. Messages name variables, never their values.
pilot_env_guard() {
  [ "${APP_ENV:-}" = "staging" ] || {
    echo "Pilot deploy expects APP_ENV=staging" >&2
    return 1
  }
  [ "${PAYMENT_PROVIDER:-}" = "DISABLED" ] || {
    echo "Pilot deploy expects PAYMENT_PROVIDER=DISABLED until a real PSP exists" >&2
    return 1
  }
  # Unset means DISABLED (the API default). TEST, LIVE and an empty value (which
  # the API configuration rejects) are refused.
  [ "${PAYMENT_STRIPE_MODE-DISABLED}" = "DISABLED" ] || {
    echo "Pilot deploy expects PAYMENT_STRIPE_MODE=DISABLED (Stripe TEST and LIVE are refused)" >&2
    return 1
  }
  if [ -n "${PAYMENT_STRIPE_SECRET_KEY:-}" ] || [ -n "${PAYMENT_STRIPE_WEBHOOK_SECRET:-}" ]; then
    echo "Pilot deploy refuses Stripe credentials: PAYMENT_STRIPE_SECRET_KEY and PAYMENT_STRIPE_WEBHOOK_SECRET must be unset" >&2
    return 1
  fi
}
