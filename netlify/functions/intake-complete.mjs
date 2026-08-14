import { getStore } from '@netlify/blobs';
import nodemailer from 'nodemailer';
import {
  AUDIT_STORE,
  MAX_BODY_BYTES,
  buildPdf,
  buildSummaryJson,
  jsonResponse,
  normalizeFileName,
  text,
} from './intake-core.mjs';
import { createDriveJsonFile, refreshGoogleAccessToken } from './intake-start.mjs';

const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

function smtpTransport(env = process.env) {
  const { SMTP_HOST, SMTP_PORT = '465', SMTP_USER, SMTP_PASSWORD } = env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) throw new Error('SMTP is not configured.');
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
  });
}

function uploadedFileMap(uploadedFiles = []) {
  const map = new Map();
  if (!Array.isArray(uploadedFiles)) return map;
  for (const file of uploadedFiles) {
    if (!file || typeof file !== 'object') continue;
    map.set(normalizeFileName(file.name), {
      name: normalizeFileName(file.name),
      id: text(file.id),
      webViewLink: text(file.webViewLink),
      status: text(file.status) || 'uploaded',
    });
  }
  return map;
}

function uploadSessionMap(uploadTargets = []) {
  const map = new Map();
  if (!Array.isArray(uploadTargets)) return map;
  for (const item of uploadTargets) {
    if (!item || typeof item !== 'object') continue;
    map.set(normalizeFileName(item.name), {
      name: normalizeFileName(item.name),
      id: text(item.fileId),
      webViewLink: text(item.webViewLink),
      status: text(item.status),
    });
  }
  return map;
}

async function createDriveBinaryFile(fetchImpl, token, name, parentId, content, mimeType) {
  const boundary = `aplaniq-${Date.now()}`;
  const metadata = { name: normalizeFileName(name), parents: [parentId], mimeType };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await fetchImpl(`${DRIVE_UPLOAD_API}?uploadType=multipart&fields=id,webViewLink`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.id) throw new Error(result.error?.message || 'Unable to create Drive PDF file.');
  return result;
}

export async function completeIntake(payload, deps = {}) {
  const auditId = text(payload?.auditId);
  if (!auditId) return { ok: false, status: 400, error: 'Missing audit ID.' };

  const store = deps.store || getStore(AUDIT_STORE);
  const recordText = await store.get(auditId, { type: 'text' });
  if (!recordText) return { ok: false, status: 404, error: 'Intake was not found.' };

  const record = JSON.parse(recordText);
  const uploaded = uploadedFileMap(payload?.uploadedFiles);
  const uploadSessions = uploadSessionMap(record.uploadTargets);
  const files = (record.files || []).map((file) => ({
    ...file,
    ...(uploadSessions.get(file.name) || {}),
    ...(uploaded.get(file.name) || {}),
    status: uploaded.has(file.name) ? 'uploaded' : text((uploadSessions.get(file.name) || {}).status) || file.status,
  }));

  const submittedAt = record.submittedAt || new Date().toISOString();
  const fetchImpl = deps.fetch || fetch;
  const env = deps.env || process.env;
  const recipient = env.INTAKE_RECIPIENT || 'hello@aplaniq.co';
  const pdf = await buildPdf(record.data, auditId, submittedAt, record.folderUrl, files);

  let summaryFile = null;
  let pdfFile = null;
  if (record.folders?.summary) {
    const token = await refreshGoogleAccessToken(fetchImpl, env);
    summaryFile = await createDriveJsonFile(fetchImpl, token, `${auditId}-completed-summary.json`, record.folders.summary, buildSummaryJson(record.data, auditId, submittedAt, record.folderUrl, files));
    pdfFile = await createDriveBinaryFile(fetchImpl, token, `aplaniq-intake-${auditId}.pdf`, record.folders.summary, pdf, 'application/pdf');
  }

  const result = await (deps.transport || smtpTransport(env)).sendMail({
    from: env.SMTP_FROM || env.SMTP_USER,
    to: recipient,
    replyTo: record.data.contactEmail,
    subject: `New APLANIQ website intake: ${record.data.companyName} (${auditId})`,
    text: [
      'A new APLANIQ website and marketing intake is ready.',
      '',
      `Audit ID: ${auditId}`,
      `Company: ${record.data.companyName}`,
      `Contact: ${record.data.contactName} <${record.data.contactEmail}>`,
      `Drive folder: ${record.folderUrl}`,
      `Uploaded files: ${files.length}`,
    ].join('\n'),
    attachments: [{ filename: `aplaniq-intake-${auditId}.pdf`, content: Buffer.from(pdf), contentType: 'application/pdf' }],
  });

  const completedRecord = {
    ...record,
    files,
    status: 'delivered',
    completedAt: new Date().toISOString(),
    recipient,
    summaryFile,
    pdfFile,
    emailMessageId: result.messageId || null,
  };
  await store.set(auditId, JSON.stringify(completedRecord));

  return { ok: true, auditId, folderUrl: record.folderUrl };
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
    const result = await completeIntake(payload);
    if (!result.ok) return jsonResponse(result.status, { error: result.error });
    return jsonResponse(200, result);
  } catch (error) {
    console.error('Unable to complete intake.', error);
    return jsonResponse(502, { error: 'We could not finish your intake. Please try again shortly.' });
  }
}
