import twilio from 'twilio';
import { env } from '../config/env.js';
import { ITelephonyProvider, SendSmsParams } from './telephony.interface.js';

export class TwilioProvider implements ITelephonyProvider {
  private client?: twilio.Twilio;

  constructor() {
    if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
      this.client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
    }
  }

  generateForwardingMarkup(targetPhone: string, statusCallbackUrl: string, timeoutSeconds: number = 18): string {
    const response = new twilio.twiml.VoiceResponse();
    const dial = response.dial({
      timeout: timeoutSeconds,
      action: statusCallbackUrl,
      method: 'POST',
    });
    dial.number(targetPhone);
    return response.toString();
  }

  async sendSms({ to, from, body }: SendSmsParams): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.client) {
      return { success: false, error: 'Twilio client not initialized (missing credentials)' };
    }

    try {
      const message = await this.client.messages.create({
        to,
        from,
        body,
      });
      return { success: true, messageId: message.sid };
    } catch (err: any) {
      console.error('[TwilioProvider] SMS send failure:', err);
      return { success: false, error: err.message };
    }
  }

  validateWebhook(signature: string, url: string, params: Record<string, any>): boolean {
    if (!env.TWILIO_AUTH_TOKEN) return true; // Bypass in dev if not set
    return twilio.validateRequest(env.TWILIO_AUTH_TOKEN, signature, url, params);
  }
}
