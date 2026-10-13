import { createAuthClient } from '@euroteranga/auth-client';
import { publicEnv } from './env';

/** Browser client for the Core API (public booking reads and CUSTOMER actions). */
export const auth = createAuthClient(publicEnv.NEXT_PUBLIC_API_BASE_URL);
