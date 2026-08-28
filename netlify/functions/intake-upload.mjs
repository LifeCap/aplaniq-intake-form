import { getStore } from '@netlify/blobs';
import {
  AUDIT_STORE,
  UPLOAD_CHUNK_BYTES,
  jsonResponse,
  logIntakeEvent,
  normalizeFileName,
  providerErrorClass,
  text,
} from './intake-core.mjs';

const RANGE_RE = /^bytes=(\d+)-(\d+)$/;

function parseInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function uploadError(message, status = 400) {
  return { ok: false, status, error: message };
}

function updatedSession(target, patch) {
  return { ...target, ...patch };
}

export async function uploadIntakeChunk(request, deps = {}) {
  if (request.method !== 'PUT') return uploadError('Method not allowed.', 405);

  const url = new URL(request.url);
  const auditId = text(url.searchParams.get('auditId'));
  const uploadId = text(url.searchParams.get('uploadId'));
  const offset = parseInteger(url.searchParams.get('offset'));
  const total = parseInteger(url.searchParams.get('total'));

  if (!auditId || !uploadId) return uploadError('Missing upload target.');
  if (offset === null || total === null || offset < 0 || total <= 0 || offset > total) return uploadError('Invalid upload range.');

  const store = deps.store || getStore(AUDIT_STORE);
  const recordText = await store.get(auditId, { type: 'text' });
  if (!recordText) return uploadError('Intake was not found.', 404);

  const record = JSON.parse(recordText);
  const index = Array.isArray(record.uploadTargets) ? record.uploadTargets.findIndex((item) => item.uploadId === uploadId) : -1;
  if (index < 0) return uploadError('Upload target was not found.', 404);

  const target = record.uploadTargets[index];
  if (!target.uploadUrl) return uploadError('Upload target is unavailable.', 410);
  if (target.status === 'uploaded') {
    return { ok: true, status: 200, uploadComplete: true, uploadedBytes: target.size, file: { name: target.name, id: target.fileId || '', webViewLink: target.webViewLink || '', status: 'uploaded' } };
  }
  if (offset !== target.uploadedBytes) return uploadError('Upload is out of sync. Please retry your submission.', 409);
  if (total !== target.size) return uploadError('Upload size does not match the prepared file.', 400);

  const chunk = await request.arrayBuffer();
  const chunkBytes = chunk.byteLength;
  if (!chunkBytes) return uploadError('Upload chunk was empty.');
  if (chunkBytes > UPLOAD_CHUNK_BYTES) return uploadError('Upload chunk exceeded the server limit.', 413);

  const chunkEnd = offset + chunkBytes - 1;
  if (chunkEnd > target.size - 1) return uploadError('Upload chunk exceeded file size.');
  if (chunkEnd < target.size - 1 && chunkBytes % (256 * 1024) !== 0) {
    return uploadError('Intermediate chunks must be aligned to 256 KB.');
  }

  const fetchImpl = deps.fetch || fetch;
  const response = await fetchImpl(target.uploadUrl, {
    method: 'PUT',
    headers: {
      'content-length': String(chunkBytes),
      'content-range': `bytes ${offset}-${chunkEnd}/${target.size}`,
      'content-type': target.type || request.headers.get('content-type') || 'application/octet-stream',
    },
    body: chunk,
  });

  const responseText = await response.text();
  let nextBytes = target.uploadedBytes;
  let fileId = target.fileId || '';
  let webViewLink = target.webViewLink || '';
  let status = target.status;

  if (response.status === 308) {
    const rangeHeader = response.headers.get('range');
    const match = rangeHeader ? RANGE_RE.exec(rangeHeader) : null;
    nextBytes = match ? Number(match[2]) + 1 : chunkEnd + 1;
    status = 'uploading';
  } else if (response.ok) {
    nextBytes = target.size;
    status = 'uploaded';
    if (responseText) {
      const result = JSON.parse(responseText);
      fileId = text(result.id);
      webViewLink = text(result.webViewLink);
    }
  } else {
    throw new Error(`Drive upload failed with status ${response.status}.`);
  }

  record.uploadTargets[index] = updatedSession(target, {
    uploadedBytes: nextBytes,
    status,
    fileId,
    webViewLink,
  });
  await store.set(auditId, JSON.stringify(record));

  return {
    ok: true,
    status: 200,
    uploadComplete: status === 'uploaded',
    uploadedBytes: nextBytes,
    file: status === 'uploaded'
      ? { name: normalizeFileName(target.name), id: fileId, webViewLink, status: 'uploaded' }
      : null,
  };
}

export default async function handler(request) {
  try {
    const result = await uploadIntakeChunk(request);
    if (!result.ok) return jsonResponse(result.status, { error: result.error });
    return jsonResponse(200, {
      uploadComplete: result.uploadComplete,
      uploadedBytes: result.uploadedBytes,
      file: result.file,
    });
  } catch (error) {
    console.error('Unable to upload intake file chunk.', error);
    const auditId = text(new URL(request.url).searchParams.get('auditId'));
    logIntakeEvent('intake_upload_failed', { auditId, stage: 'upload', errorClass: providerErrorClass(error) });
    return jsonResponse(502, { error: 'We could not upload that file chunk. Please try again.' });
  }
}
