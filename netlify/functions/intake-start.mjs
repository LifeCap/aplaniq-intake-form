import { createHash } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import {
  AUDIT_STORE,
  DRIVE_FOLDER_MIME,
  MAX_BODY_BYTES,
  buildSummaryJson,
  clientFolderName,
  createAuditId,
  jsonResponse,
  logIntakeEvent,
  missingEnvironment,
  normalizeFileName,
  providerErrorClass,
  safeDriveName,
  validateIntakePayload,
} from './intake-core.mjs';

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const TOKEN_API = 'https://oauth2.googleapis.com/token';

export function googleConfigStatus(env = process.env) {
  const missing = missingEnvironment(env, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_DRIVE_PARENT_FOLDER_ID']);
  return { ready: missing.length === 0, missing };
}

export function requireGoogleConfig(env = process.env) {
  const status = googleConfigStatus(env);
  if (!status.ready) {
    throw new Error('Google Drive is not configured.');
  }
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_DRIVE_PARENT_FOLDER_ID } = env;
  return { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_DRIVE_PARENT_FOLDER_ID };
}

export async function refreshGoogleAccessToken(fetchImpl = fetch, env = process.env) {
  const config = requireGoogleConfig(env);
  const response = await fetchImpl(TOKEN_API, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      refresh_token: config.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error('Unable to authorize Google Drive.');
  return body.access_token;
}

async function driveJson(fetchImpl, token, url, body) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.id) throw new Error(result.error?.message || 'Google Drive request failed.');
  return result;
}

export async function createDriveFolder(fetchImpl, token, name, parentId) {
  return driveJson(fetchImpl, token, DRIVE_API, {
    name: safeDriveName(name),
    mimeType: DRIVE_FOLDER_MIME,
    parents: parentId ? [parentId] : undefined,
  });
}

export async function createDriveJsonFile(fetchImpl, token, name, parentId, content) {
  const boundary = `aplaniq-${Date.now()}`;
  const metadata = { name: normalizeFileName(name), parents: [parentId], mimeType: 'application/json' };
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    content,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  const response = await fetchImpl(`${DRIVE_UPLOAD_API}?uploadType=multipart&fields=id,webViewLink`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.id) throw new Error(result.error?.message || 'Unable to create Drive summary file.');
  return result;
}

export async function createUploadSession(fetchImpl, token, file, parentId) {
  const response = await fetchImpl(`${DRIVE_UPLOAD_API}?uploadType=resumable&fields=id,webViewLink`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
      'x-upload-content-type': file.type,
      'x-upload-content-length': String(file.size),
    },
    body: JSON.stringify({
      name: file.name,
      parents: [parentId],
      mimeType: file.type,
    }),
  });
  const uploadUrl = response.headers.get('location');
  if (!response.ok || !uploadUrl) throw new Error('Unable to create Drive upload session.');
  return uploadUrl;
}

function categoryFolderId(file, folders) {
  if (file.category === 'brand') return folders.brand.id;
  if (file.category === 'website') return folders.website.id;
  if (file.category === 'references') return folders.references.id;
  return folders.documents.id;
}

export async function startIntake(payload, deps = {}) {
  const validation = validateIntakePayload(payload);
  if (!validation.ok) return { ok: false, status: 400, error: validation.error };

  const now = deps.now || new Date();
  const submittedAt = now.toISOString();
  const auditId = createAuditId(now, deps.uuid);
  const fetchImpl = deps.fetch || fetch;
  const env = deps.env || process.env;
  const store = deps.store || getStore(AUDIT_STORE);
  const files = validation.files.map((file) => ({ ...file, status: 'pending' }));
  const intakeRecord = {
    auditId,
    submittedAt,
    data: validation.data,
    files,
    folderId: null,
    folderUrl: '',
    folders: {},
    uploadTargets: [],
    drive: { status: 'pending', errorClass: null },
    status: 'received',
    payloadHash: createHash('sha256').update(JSON.stringify({ data: validation.data, files })).digest('hex'),
  };
  await store.set(auditId, JSON.stringify(intakeRecord));

  try {
    const token = await refreshGoogleAccessToken(fetchImpl, env);
    const yearFolder = await createDriveFolder(fetchImpl, token, String(now.getUTCFullYear()), env.GOOGLE_DRIVE_PARENT_FOLDER_ID);
    const clientFolder = await createDriveFolder(fetchImpl, token, clientFolderName(validation.data, auditId), yearFolder.id);
    const folderUrl = clientFolder.webViewLink || `https://drive.google.com/drive/folders/${clientFolder.id}`;
    const folders = {
      summary: await createDriveFolder(fetchImpl, token, '01 Intake Summary', clientFolder.id),
      brand: await createDriveFolder(fetchImpl, token, '02 Brand Assets', clientFolder.id),
      website: await createDriveFolder(fetchImpl, token, '03 Website Assets', clientFolder.id),
      documents: await createDriveFolder(fetchImpl, token, '04 Documents', clientFolder.id),
      references: await createDriveFolder(fetchImpl, token, '05 References', clientFolder.id),
    };
    await createDriveJsonFile(fetchImpl, token, `${auditId}-summary.json`, folders.summary.id, buildSummaryJson(validation.data, auditId, submittedAt, folderUrl, files));
    const uploadTargets = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      uploadTargets.push({ uploadId: `upload-${index + 1}`, name: file.name, size: file.size, type: file.type, category: file.category, uploadUrl: await createUploadSession(fetchImpl, token, file, categoryFolderId(file, folders)) });
    }
    Object.assign(intakeRecord, {
      folderId: clientFolder.id,
      folderUrl,
      folders: Object.fromEntries(Object.entries(folders).map(([key, folder]) => [key, folder.id])),
      uploadTargets: uploadTargets.map(({ uploadUrl, ...target }) => ({ ...target, uploadUrl, uploadedBytes: 0, status: 'pending' })),
      drive: { status: 'ready', errorClass: null },
      status: 'upload_pending',
    });
    await store.set(auditId, JSON.stringify(intakeRecord));
    logIntakeEvent('intake_started', { auditId, stage: 'drive', driveStatus: 'ready' });
    return { ok: true, auditId, folderUrl, uploadTargets: uploadTargets.map(({ uploadUrl, ...target }) => target), driveStatus: 'ready' };
  } catch (error) {
    intakeRecord.drive = { status: 'failed', errorClass: providerErrorClass(error) };
    intakeRecord.status = 'drive_unavailable';
    await store.set(auditId, JSON.stringify(intakeRecord));
    logIntakeEvent('intake_drive_unavailable', { auditId, stage: 'drive', errorClass: intakeRecord.drive.errorClass });
    return { ok: true, auditId, folderUrl: '', uploadTargets: [], driveStatus: 'failed' };
  }
}

export default async function handler(request) {
  if (request.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' });
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY_BYTES) return jsonResponse(413, { error: 'Submission is too large.' });

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse(400, { error: 'Invalid submission.' });
  }

  try {
    const result = await startIntake(payload);
    if (!result.ok) return jsonResponse(result.status, { error: result.error });
    return jsonResponse(200, result);
  } catch (error) {
    console.error('Unable to start intake.', error);
    return jsonResponse(503, { error: 'We could not record your intake. Please try again.' });
  }
}
