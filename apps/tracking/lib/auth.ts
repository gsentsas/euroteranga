import { createAuthClient } from '@euroteranga/auth-client';
import { publicEnv } from './env';

export const auth = createAuthClient(publicEnv.NEXT_PUBLIC_API_BASE_URL);
