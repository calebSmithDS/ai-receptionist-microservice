import { env } from '../config/env.js';

export interface SendSmsParams {
  from: string;
  to: string;
  body: string;
}

export class TwilioSmsClient {
  private accountSid?: string;
  private authToken?: string;

  constructor() {
    this.accountSid = env.TWILIO_ACCOUNT_SID;
    this.authToken = env.TWILIO_AUTH_TOKEN;
  }

  /**
   * Dispatches an outbound SMS message via Twilio REST API
   */
  async sendSms(params: SendSmsParams): Promise<{ success: boolean; messageSid?: string }> {
    if (!this.accountSid || !this.authToken) {
      console.info(
        `[TwilioSmsClient] (Simulation) To: ${params.to} | From: ${params.from} | Body: "${params.body}"`
      );
      return { success: true, messageSid: 'SIMULATED_' + Date.now() };
    }

    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
      const authHeader = 'Basic ' + Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');

      const formData = new URLSearchParams({
        From: params.from,
        To: params.to,
        Body: params.body,
      });

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[TwilioSmsClient] Failed to send SMS via Twilio API:', errorText);
        return { success: false };
      }

      const json = (await response.json()) as any;
      return { success: true, messageSid: json.sid };
    } catch (error) {
      console.error('[TwilioSmsClient] Network error dispatching SMS:', error);
      return { success: false };
    }
  }
}

