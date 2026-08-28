import { jsonResponse } from './intake-core.mjs';
import { smtpConfigStatus } from './intake-complete.mjs';
import { googleConfigStatus } from './intake-start.mjs';

export function intakeHealth(env = process.env) {
  const smtp = smtpConfigStatus(env);
  const googleDrive = googleConfigStatus(env);
  return { ok: smtp.ready && googleDrive.ready, smtp, googleDrive };
}

export default async function handler(request) {
  if (request.method !== 'GET') return jsonResponse(405, { error: 'Method not allowed.' });
  return jsonResponse(200, intakeHealth());
}
