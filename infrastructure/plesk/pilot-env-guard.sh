# shellcheck shell=bash
# Pilot environment guard, sourced by deploy-release.sh after the pilot env
# files are loaded, and exercised by packages/config/src/pilot-env-guard.test.ts.
# The pilot is a staging environment that takes no payment: SANDBOX is refused
# by the API configuration there, and Stripe (PAY-EU-1) and PayPal
# (PAY-PAYPAL-1) must stay DISABLED, with no credential of either at all.
# Messages name variables, never their values.
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
  # PayPal (PAY-PAYPAL-1): the same rules. SANDBOX, LIVE and an empty value
  # are refused, and so is any PayPal credential, even a non-secret one.
  [ "${PAYMENT_PAYPAL_MODE-DISABLED}" = "DISABLED" ] || {
    echo "Pilot deploy expects PAYMENT_PAYPAL_MODE=DISABLED (PayPal SANDBOX and LIVE are refused)" >&2
    return 1
  }
  if [ -n "${PAYMENT_PAYPAL_CLIENT_ID:-}" ] || [ -n "${PAYMENT_PAYPAL_CLIENT_SECRET:-}" ] ||
    [ -n "${PAYMENT_PAYPAL_WEBHOOK_ID:-}" ]; then
    echo "Pilot deploy refuses PayPal credentials: PAYMENT_PAYPAL_CLIENT_ID, PAYMENT_PAYPAL_CLIENT_SECRET and PAYMENT_PAYPAL_WEBHOOK_ID must be unset" >&2
    return 1
  fi
  # Wave has no documented sandbox. The pilot refuses LIVE and every Wave
  # credential, including a signing secret, even when mode says DISABLED.
  [ "${PAYMENT_WAVE_MODE-DISABLED}" = "DISABLED" ] || {
    echo "Pilot deploy expects PAYMENT_WAVE_MODE=DISABLED (Wave LIVE is refused)" >&2
    return 1
  }
  if [ -n "${PAYMENT_WAVE_API_KEY:-}" ] || [ -n "${PAYMENT_WAVE_WEBHOOK_SECRET:-}" ] ||
    [ -n "${PAYMENT_WAVE_REQUEST_SIGNING_SECRET:-}" ]; then
    echo "Pilot deploy refuses Wave credentials: PAYMENT_WAVE_API_KEY, PAYMENT_WAVE_WEBHOOK_SECRET and PAYMENT_WAVE_REQUEST_SIGNING_SECRET must be unset" >&2
    return 1
  fi
  # Orange direct is blocked pending the private Senegal merchant contract.
  # No credential names are invented: reject every non-empty variable in its
  # namespace except the explicit fail-closed mode.
  [ "${PAYMENT_ORANGE_MONEY_MODE-DISABLED}" = "DISABLED" ] || {
    echo "Pilot deploy expects PAYMENT_ORANGE_MONEY_MODE=DISABLED" >&2
    return 1
  }
  if env | grep -E '^PAYMENT_ORANGE_MONEY_[A-Za-z0-9_]+=.+$' |
    cut -d= -f1 | grep -v '^PAYMENT_ORANGE_MONEY_MODE$' >/dev/null; then
    echo "Pilot deploy refuses every Orange Money credential variable" >&2
    return 1
  fi
}
