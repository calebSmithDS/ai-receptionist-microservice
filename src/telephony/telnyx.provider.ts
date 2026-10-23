import { env } from '../config/env.js';
import { ITelephonyProvider, SendSmsParams } from './telephony.interface.js';

/**
 * Telnyx Provider implementation for high-volume, low-cost SMS & call routing
 */
export class TelnyxProvider implements ITelephonyProvider {
  private apiKey?: string;

  constructor() {
    this.apiKey = env.TELNYX_API_KEY;
  }

  generateForwardingMarkup(targetPhone: string, statusCallbackUrl: string, timeoutSeconds: number = 18): string {
    // Telnyx supports TeXML (Twilio XML compatible)
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="${timeoutSeconds}" action="${statusCallbackUrl}" method="POST">
    <Number>${targetPhone}</Number>
  </Dial>
</Response>`;
  }

  async sendSms({ to, from, body }: SendSmsParams): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.apiKey) {
      return { success: false, error: 'Telnyx API key not configured' };
    }

    try {
      const response = await fetch('https://api.telnyx.com/v2/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          from,
          to,
          text: body,
        }),
      });

      const data = (await response.json()) as any;
      if (!response.ok) {
        return { success: false, error: data?.errors?.[0]?.detail || 'Telnyx SMS error' };
      }

      return { success: true, messageId: data.data?.id };
    } catch (err: any) {
      console.error('[TelnyxProvider] SMS send failure:', err);
      return { success: false, error: err.message };
    }
  }

  validateWebhook(_signature: string, _url: string, _params: Record<string, any>): boolean {
    // Telnyx signature verification using public key can be hooked here
    return true;
  }
}
