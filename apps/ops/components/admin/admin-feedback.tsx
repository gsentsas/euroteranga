'use client';

import type { ApiResult } from '@euroteranga/auth-client';
import { FormAlert, FormStatus } from '@euroteranga/ui';
import { useCallback, useState } from 'react';

/**
 * One error and one success message per admin page. Every action goes
 * through `run`, which shows the API's own refusal (403, 409…) verbatim:
 * the interface never assumes an action is allowed.
 */
export function useAdminFeedback() {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async <T,>(action: () => Promise<ApiResult<T>>, success: string): Promise<boolean> => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const result = await action();
        if (!result.ok) {
          setError(result.error.message);
          return false;
        }
        setNotice(success);
        return true;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const feedback = (
    <>
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}
    </>
  );
  return { run, busy, feedback, setError };
}
