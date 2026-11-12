import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { IEligibilityRepository } from '../core/eligibility/eligibility-engine.js';

export function registerMagicMuteRoutes(app: FastifyInstance, repo: IEligibilityRepository) {
  /**
   * 1-Tap Magic Mute Link
   * Route: GET /m/:token
   * When tapped by the tradie on their phone, instantly mutes the associated contact in Postgres
   * and renders a clean, dark-mode confirmation page.
   */
  app.get('/m/:token', async (req: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
    const { token } = req.params;

    const result = await repo.redeemMagicLinkToken(token);

    reply.type('text/html');

    if (!result.success) {
      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invalid Link</title>
  <style>
    body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 16px; padding: 32px 24px; max-width: 360px; width: 90%; }
    h2 { color: #f85149; margin-top: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h2>⚠️ Link Invalid</h2>
    <p>This link is no longer valid or could not be found.</p>
  </div>
</body>
</html>`;
    }

    const isUnmuted = result.actionTaken === 'unmuted';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${isUnmuted ? 'Contact Unmuted' : 'Contact Muted'}</title>
  <style>
    body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 16px; padding: 32px 24px; max-width: 360px; width: 90%; }
    .icon { font-size: 48px; margin-bottom: 12px; }
    h2 { color: ${isUnmuted ? '#58a6ff' : '#3fb950'}; margin: 0 0 8px; }
    p { margin: 0 0 16px; color: #8b949e; font-size: 14px; line-height: 1.4; }
    .badge { background: #21262d; border: 1px solid #30363d; padding: 6px 12px; border-radius: 8px; font-weight: 600; color: #fff; display: inline-block; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${isUnmuted ? '🔓' : '🔕'}</div>
    <h2>${isUnmuted ? 'Contact Unmuted' : 'Contact Muted'}</h2>
    <p>${
      isUnmuted
        ? 'This number has been upgraded to a verified client. The AI will never auto-mute them again.'
        : 'This number is now muted and will never receive automated AI texts or missed-call replies again.'
    }</p>
    <div class="badge">${result.targetPhone}</div>
  </div>
</body>
</html>`;
  });
}

