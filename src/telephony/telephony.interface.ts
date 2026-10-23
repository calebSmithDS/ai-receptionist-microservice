export interface SendSmsParams {
  to: string;
  from: string;
  body: string;
}

export interface ITelephonyProvider {
  /**
   * Generates response markup (e.g. TwiML) to forward incoming call to tradie's mobile with timeout
   */
  generateForwardingMarkup(targetPhone: string, statusCallbackUrl: string, timeoutSeconds?: number): string;

  /**
   * Sends an outbound SMS
   */
  sendSms(params: SendSmsParams): Promise<{ success: boolean; messageId?: string; error?: string }>;

  /**
   * Validates webhook signatures
   */
  validateWebhook(signature: string, url: string, params: Record<string, any>): boolean;
}
