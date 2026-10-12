import type { AuthMailMessage, AuthMailProvider } from '../../src/auth/mail/auth-mail.provider.js';

/**
 * Test-only mail transport: keeps messages in memory so tests can read the
 * links they contain. There is no HTTP endpoint exposing them.
 */
export class FakeAuthMailProvider implements AuthMailProvider {
  readonly messages: AuthMailMessage[] = [];
  /** When set, every send fails (simulates an SMTP outage). */
  failing = false;

  send(message: AuthMailMessage): Promise<void> {
    if (this.failing) return Promise.reject(new Error('SMTP unavailable (simulated)'));
    this.messages.push(message);
    return Promise.resolve();
  }

  to(address: string): AuthMailMessage[] {
    return this.messages.filter((message) => message.to.toLowerCase() === address.toLowerCase());
  }

  /** Waits for the n-th message to an address (delivery is asynchronous). */
  async waitFor(address: string, count = 1, timeoutMs = 3_000): Promise<AuthMailMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const received = this.to(address);
      if (received.length >= count) return received[count - 1] as AuthMailMessage;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`No mail #${count} received for ${address}`);
  }

  /** Lets pending asynchronous sends settle before asserting "no mail". */
  async settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function tokenFromMail(message: AuthMailMessage): string {
  const token = /#token=([A-Za-z0-9_-]{43})/.exec(message.text)?.[1];
  if (!token) throw new Error('No token link in mail');
  return token;
}
