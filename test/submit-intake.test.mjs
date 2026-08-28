import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPdf, clientFolderName, createAuditId, validateFileManifest, validateIntakePayload } from '../netlify/functions/intake-core.mjs';
import { startIntake } from '../netlify/functions/intake-start.mjs';
import { completeIntake } from '../netlify/functions/intake-complete.mjs';
import { uploadIntakeChunk } from '../netlify/functions/intake-upload.mjs';
import { intakeHealth } from '../netlify/functions/intake-health.mjs';

const validSubmission = {
  companyName: 'Acme LLC',
  contactName: 'Jane Doe',
  contactTitle: 'Owner',
  contactEmail: 'jane@example.com',
  contactPhone: '555-0100',
  industry: 'services',
  currentWebsite: 'https://example.com',
  projectType: ['website-build'],
  services: ['website', 'seo-aeo'],
  primaryGoal: 'launch',
  timeline: 'quarter',
  budget: '5k-15k',
  websiteNeeds: 'Five-page site with lead form.',
  repairNeeds: '',
  marketingNeeds: 'SEO pages.',
  brandTone: ['friendly', 'educational'],
  brandValues: 'Trust',
  contentPreferences: 'Clear, practical copy.',
  referenceLinks: 'https://example.org',
  accessNotes: 'CMS access may be needed later.',
  additionalNotes: 'Need first draft quickly.',
  agreeTerms: 'on',
  agreeMarketing: 'on',
  companyWebsite: '',
  files: [{ name: 'logo.png', size: 1024, type: 'image/png', category: 'brand' }],
};

function memoryStore(seed = {}) {
  const records = new Map(Object.entries(seed));
  return {
    records,
    async get(key) {
      return records.get(key) || null;
    },
    async set(key, value) {
      records.set(key, value);
    },
  };
}

function driveFetchMock() {
  let counter = 0;
  return async (url) => {
    if (String(url).includes('oauth2.googleapis.com')) return Response.json({ access_token: 'token' });
    if (String(url).includes('uploadType=resumable')) {
      return new Response('', {
        status: 200,
        headers: { location: `https://uploads.example/session-${++counter}` },
      });
    }
    return Response.json({ id: `drive-${++counter}`, webViewLink: `https://drive.example/${counter}` });
  };
}

const env = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REFRESH_TOKEN: 'refresh-token',
  GOOGLE_DRIVE_PARENT_FOLDER_ID: 'parent-folder',
  SMTP_HOST: 'smtp.example.com',
  SMTP_USER: 'hello@aplaniq.co',
  SMTP_PASSWORD: 'secret',
  INTAKE_RECIPIENT: 'hello@aplaniq.co',
};

test('accepts a complete website intake', () => {
  const result = validateIntakePayload(validSubmission);
  assert.equal(result.ok, true);
  assert.equal(result.data.companyName, 'Acme LLC');
  assert.equal(result.data.projectType, 'website-build');
  assert.equal(result.files[0].category, 'brand');
});

test('rejects missing required fields, invalid email, bad URL, and honeypot input', () => {
  assert.equal(validateIntakePayload({ ...validSubmission, agreeTerms: '' }).ok, false);
  assert.equal(validateIntakePayload({ ...validSubmission, brandTone: [] }).ok, false);
  assert.equal(validateIntakePayload({ ...validSubmission, services: [] }).ok, false);
  assert.equal(validateIntakePayload({ ...validSubmission, contactEmail: 'not-an-email' }).ok, false);
  assert.equal(validateIntakePayload({ ...validSubmission, currentWebsite: 'ftp://example.com' }).ok, false);
  assert.equal(validateIntakePayload({ ...validSubmission, companyWebsite: 'https://spam.example' }).ok, false);
});

test('validates file manifest count, size, total, and allowlist', () => {
  assert.equal(validateFileManifest([{ name: 'brand.pdf', size: 1000, type: 'application/pdf', category: 'documents' }]).ok, true);
  assert.equal(validateFileManifest([{ name: 'run.exe', size: 1000, type: 'application/octet-stream', category: 'documents' }]).ok, false);
  assert.equal(validateFileManifest([{ name: 'huge.pdf', size: 251 * 1024 * 1024, type: 'application/pdf', category: 'documents' }]).ok, false);
  assert.equal(validateFileManifest(Array.from({ length: 21 }, (_, i) => ({ name: `file-${i}.pdf`, size: 1000, type: 'application/pdf', category: 'documents' }))).ok, false);
});

test('creates collision-resistant audit IDs and safe folder names', () => {
  const now = new Date('2026-08-12T12:00:00.000Z');
  const first = createAuditId(now, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  const second = createAuditId(now, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  assert.match(first, /^APL-20260812-AAAAAAAA$/);
  assert.notEqual(first, second);
  assert.equal(clientFolderName({ companyName: 'Acme: LLC / East' }, first), 'APL-20260812-AAAAAAAA - Acme LLC  East');
});

test('builds a non-empty PDF summary', async () => {
  const result = validateIntakePayload(validSubmission);
  const pdf = await buildPdf(result.data, 'APL-20260812-AAAAAAAA', '2026-08-12T12:00:00.000Z', 'https://drive.example/folder', result.files);
  assert.ok(pdf.length > 1000);
  assert.equal(Buffer.from(pdf).subarray(0, 4).toString(), '%PDF');
});

test('starts intake by creating Drive folders and upload sessions', async () => {
  const store = memoryStore();
  const result = await startIntake(validSubmission, {
    env,
    fetch: driveFetchMock(),
    store,
    now: new Date('2026-08-12T12:00:00.000Z'),
    uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  });
  assert.equal(result.ok, true);
  assert.equal(result.auditId, 'APL-20260812-AAAAAAAA');
  assert.equal(result.uploadTargets.length, 1);
  assert.equal(result.uploadTargets[0].uploadId, 'upload-1');
  assert.equal('uploadUrl' in result.uploadTargets[0], false);
  assert.ok(store.records.has('APL-20260812-AAAAAAAA'));
  const record = JSON.parse(await store.get('APL-20260812-AAAAAAAA'));
  assert.match(record.uploadTargets[0].uploadUrl, /^https:\/\/uploads\.example/);
});

test('completes intake by storing status and emailing hello inbox', async () => {
  const auditId = 'APL-20260812-AAAAAAAA';
  const parsed = validateIntakePayload(validSubmission);
  const store = memoryStore({
    [auditId]: JSON.stringify({
      auditId,
      submittedAt: '2026-08-12T12:00:00.000Z',
      data: parsed.data,
      files: parsed.files,
      folderUrl: 'https://drive.example/folder',
      folders: { summary: 'summary-folder' },
      status: 'upload_pending',
    }),
  });
  const sent = [];
  const result = await completeIntake({
    auditId,
    uploadedFiles: [{ name: 'logo.png', id: 'file-1', webViewLink: 'https://drive.example/file-1' }],
  }, {
    env,
    fetch: driveFetchMock(),
    store,
    transport: { sendMail: async (message) => { sent.push(message); return { messageId: 'msg-1' }; } },
  });

  assert.equal(result.ok, true);
  assert.equal(sent[0].to, 'hello@aplaniq.co');
  const record = JSON.parse(await store.get(auditId));
  assert.equal(record.status, 'delivered');
  assert.equal(record.files[0].status, 'uploaded');
});

test('continues with email-only delivery when Google Drive is unavailable', async () => {
  const store = memoryStore();
  const start = await startIntake(validSubmission, {
    env: { ...env, GOOGLE_REFRESH_TOKEN: '' },
    fetch: driveFetchMock(),
    store,
    now: new Date('2026-08-12T12:00:00.000Z'),
    uuid: 'cccccccc-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  });
  assert.equal(start.ok, true);
  assert.equal(start.driveStatus, 'failed');
  assert.deepEqual(start.uploadTargets, []);

  const sent = [];
  const result = await completeIntake({ auditId: start.auditId, uploadedFiles: [] }, {
    env: { ...env, GOOGLE_REFRESH_TOKEN: '' },
    store,
    transport: { sendMail: async (message) => { sent.push(message); return { messageId: 'msg-fallback' }; } },
  });
  assert.equal(result.ok, true);
  assert.equal(sent[0].to, 'hello@aplaniq.co');
  const record = JSON.parse(await store.get(start.auditId));
  assert.equal(record.status, 'delivered');
  assert.equal(record.drive.status, 'failed');
});

test('records a clear delivery failure when SMTP cannot send', async () => {
  const auditId = 'APL-20260812-BBBBBBBB';
  const parsed = validateIntakePayload(validSubmission);
  const store = memoryStore({
    [auditId]: JSON.stringify({ auditId, submittedAt: '2026-08-12T12:00:00.000Z', data: parsed.data, files: parsed.files, folderUrl: '', folders: {}, drive: { status: 'failed', errorClass: 'configuration' } }),
  });
  const result = await completeIntake({ auditId, uploadedFiles: [] }, {
    env,
    store,
    transport: { sendMail: async () => { throw new Error('SMTP authentication failed'); } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  const record = JSON.parse(await store.get(auditId));
  assert.equal(record.status, 'delivery_failed');
  assert.equal(record.deliveryErrorClass, 'authentication');
});

test('reports separate SMTP and Google configuration readiness', () => {
  assert.deepEqual(intakeHealth({}), {
    ok: false,
    smtp: { ready: false, missing: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD'] },
    googleDrive: { ready: false, missing: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_DRIVE_PARENT_FOLDER_ID'] },
  });
  assert.equal(intakeHealth(env).ok, true);
});

test('uploads a chunk through the Netlify proxy and stores file metadata', async () => {
  const auditId = 'APL-20260812-AAAAAAAA';
  const store = memoryStore({
    [auditId]: JSON.stringify({
      auditId,
      files: [{ name: 'logo.png', size: 4, type: 'image/png', category: 'brand', status: 'pending' }],
      uploadTargets: [{
        uploadId: 'upload-1',
        name: 'logo.png',
        size: 4,
        type: 'image/png',
        category: 'brand',
        uploadUrl: 'https://uploads.example/session-1',
        uploadedBytes: 0,
        status: 'pending',
      }],
    }),
  });
  const request = new Request('https://example.com/.netlify/functions/intake-upload?auditId=APL-20260812-AAAAAAAA&uploadId=upload-1&offset=0&total=4', {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    body: Uint8Array.from([1, 2, 3, 4]),
  });

  const result = await uploadIntakeChunk(request, {
    store,
    fetch: async () => Response.json({ id: 'file-1', webViewLink: 'https://drive.example/file-1' }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.uploadComplete, true);
  assert.equal(result.file.id, 'file-1');
  const record = JSON.parse(await store.get(auditId));
  assert.equal(record.uploadTargets[0].status, 'uploaded');
  assert.equal(record.uploadTargets[0].uploadedBytes, 4);
});
