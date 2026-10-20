import { createHash, createHmac, randomBytes } from 'node:crypto';
import type {
  WaveCheckoutCreate,
  WaveCheckoutSession,
  WaveGateway,
} from '../../src/payments/providers/wave-payment.provider.js';

export const syntheticWaveApiKey = () => `wave_sn_prod_${randomBytes(24).toString('hex')}`;
export const syntheticWaveWebhookSecret = () => `wave_sn_WHS_${randomBytes(24).toString('hex')}`;
export const syntheticWaveRequestSigningSecret = () =>
  `wave_sn_AKS_${randomBytes(24).toString('hex')}`;

export interface FakeWaveCreateCall {
  input: WaveCheckoutCreate;
}

export class FakeWaveGateway implements WaveGateway {
  readonly createCalls: FakeWaveCreateCall[] = [];
  readonly searchCalls: string[] = [];
  readonly expireCalls: string[] = [];
  readonly getCalls: string[] = [];
  readonly sessions = new Map<string, WaveCheckoutSession[]>();
  override: Partial<WaveCheckoutSession> = {};
  failNext: Error | null = null;
  failAfterCreate: Error | null = null;
  expireResult: 'EXPIRED' | 'CONFLICT' = 'EXPIRED';
  statusAfterConflict: Partial<WaveCheckoutSession> = {
    checkout_status: 'expired',
    payment_status: 'cancelled',
  };
  onCreate: (() => Promise<void>) | null = null;

  static sessionIdFor(reference: string): string {
    return `cos-${createHash('sha256').update(reference).digest('hex').slice(0, 16)}`;
  }

  async createCheckout(input: WaveCheckoutCreate): Promise<WaveCheckoutSession> {
    this.createCalls.push({ input: structuredClone(input) });
    if (this.onCreate) await this.onCreate();
    const before = this.failNext;
    this.failNext = null;
    if (before) throw before;
    const id = FakeWaveGateway.sessionIdFor(input.client_reference);
    const session: WaveCheckoutSession = {
      id,
      amount: input.amount,
      checkout_status: 'open',
      client_reference: input.client_reference,
      currency: input.currency,
      error_url: input.error_url,
      payment_status: 'processing',
      success_url: input.success_url,
      wave_launch_url: `https://pay.wave.com/c/${id}`,
      when_created: '2026-10-20T12:00:00Z',
      when_expires: '2026-10-20T12:30:00Z',
      ...this.override,
    };
    this.sessions.set(input.client_reference, [session]);
    const after = this.failAfterCreate;
    this.failAfterCreate = null;
    if (after) throw after;
    return session;
  }

  findCheckoutsByClientReference(reference: string): Promise<readonly WaveCheckoutSession[]> {
    this.searchCalls.push(reference);
    const failure = this.failNext;
    this.failNext = null;
    if (failure) return Promise.reject(failure);
    return Promise.resolve(this.sessions.get(reference) ?? []);
  }

  expireCheckout(id: string): Promise<'EXPIRED' | 'CONFLICT'> {
    this.expireCalls.push(id);
    const failure = this.failNext;
    this.failNext = null;
    if (failure) return Promise.reject(failure);
    return Promise.resolve(this.expireResult);
  }

  async getCheckout(id: string): Promise<WaveCheckoutSession> {
    this.getCalls.push(id);
    const source = [...this.sessions.values()].flat().find((session) => session.id === id);
    if (!source) throw new Error('synthetic checkout not found');
    return { ...source, ...this.statusAfterConflict };
  }
}

let eventCounter = 0;

export function waveCheckoutEvent(input: {
  sessionId: string;
  paymentReference: string;
  amount?: string;
  currency?: string;
  eventId?: string;
  type?: string;
  checkoutStatus?: string;
  paymentStatus?: string;
  session?: Record<string, unknown>;
}): string {
  const id = input.eventId ?? `EV_${String(++eventCounter).padStart(6, '0')}ABCDEF`;
  return JSON.stringify({
    id,
    type: input.type ?? 'checkout.session.completed',
    data: {
      id: input.sessionId,
      amount: input.amount ?? '24900',
      checkout_status: input.checkoutStatus ?? 'complete',
      client_reference: input.paymentReference,
      currency: input.currency ?? 'XOF',
      error_url: 'https://client.example.test/compte?paiement=abandon-wave',
      payment_status: input.paymentStatus ?? 'succeeded',
      success_url: 'https://client.example.test/compte?paiement=retour-wave',
      wave_launch_url: `https://pay.wave.com/c/${input.sessionId}`,
      when_created: '2026-10-20T12:00:00Z',
      when_expires: '2026-10-20T12:30:00Z',
      ...input.session,
    },
  });
}

export function waveWebhookSignature(raw: string | Buffer, secret: string, timestamp: number) {
  const signature = createHmac('sha256', secret)
    .update(String(timestamp))
    .update(raw)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}
