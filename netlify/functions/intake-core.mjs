import { randomUUID } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export const MAX_BODY_BYTES = 96 * 1024;
export const AUDIT_STORE = 'aplaniq-intake-audit';
export const MAX_FILE_COUNT = 20;
export const MAX_FILE_BYTES = 250 * 1024 * 1024;
export const MAX_TOTAL_FILE_BYTES = 1024 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

const REQUIRED_FIELDS = [
  'companyName',
  'contactName',
  'contactEmail',
  'contactPhone',
  'industry',
  'projectType',
  'services',
  'primaryGoal',
  'timeline',
  'brandTone',
  'agreeTerms',
];

const FIELD_LIMITS = {
  companyName: 160,
  contactName: 160,
  contactTitle: 160,
  contactEmail: 254,
  contactPhone: 64,
  industry: 80,
  currentWebsite: 500,
  projectType: 200,
  services: 300,
  primaryGoal: 120,
  timeline: 80,
  budget: 80,
  websiteNeeds: 600,
  repairNeeds: 600,
  marketingNeeds: 600,
  brandTone: 240,
  brandValues: 300,
  contentPreferences: 600,
  referenceLinks: 800,
  accessNotes: 600,
  additionalNotes: 1200,
  agreeTerms: 10,
  agreeMarketing: 10,
  companyWebsite: 200,
};

export const FIELD_LABELS = {
  companyName: 'Company name',
  contactName: 'Primary contact',
  contactTitle: 'Title',
  contactEmail: 'Email',
  contactPhone: 'Phone',
  industry: 'Industry',
  currentWebsite: 'Current website',
  projectType: 'Project type',
  services: 'Services requested',
  primaryGoal: 'Primary goal',
  timeline: 'Timeline',
  budget: 'Budget range',
  websiteNeeds: 'Website build needs',
  repairNeeds: 'Website repair needs',
  marketingNeeds: 'Marketing deliverable needs',
  brandTone: 'Brand tone',
  brandValues: 'Core brand values',
  contentPreferences: 'Content preferences',
  referenceLinks: 'Reference links',
  accessNotes: 'Secure access notes',
  additionalNotes: 'Additional notes',
  agreeTerms: 'Submission agreement accepted',
  agreeMarketing: 'Marketing updates requested',
};

const PDF_FIELDS = Object.keys(FIELD_LABELS);

const BLOCKED_EXTENSIONS = new Set([
  'ade', 'adp', 'apk', 'app', 'asp', 'aspx', 'bat', 'bin', 'cmd', 'com', 'cpl', 'dll', 'dmg',
  'exe', 'gadget', 'hta', 'ins', 'iso', 'jar', 'js', 'jse', 'lnk', 'msc', 'msi', 'msp', 'mst',
  'php', 'pif', 'ps1', 'scr', 'sh', 'vb', 'vbe', 'vbs', 'ws', 'wsc', 'wsf', 'wsh',
]);

const ALLOWED_EXTENSIONS = new Set([
  'ai', 'csv', 'doc', 'docx', 'fig', 'gif', 'heic', 'jpeg', 'jpg', 'key', 'numbers', 'pages',
  'pdf', 'png', 'ppt', 'pptx', 'psd', 'rtf', 'sketch', 'svg', 'txt', 'webp', 'xls', 'xlsx',
  'zip',
]);

export function text(value) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
}

export function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function easternTime(isoTime) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'long',
    timeStyle: 'long',
  }).format(new Date(isoTime));
}

export function createAuditId(now = new Date(), uuid = randomUUID()) {
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `APL-${date}-${uuid.slice(0, 8).toUpperCase()}`;
}

export function safeDriveName(value, fallback = 'Client') {
  const cleaned = text(value).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '').slice(0, 80).trim();
  return cleaned || fallback;
}

export function clientFolderName(data, auditId) {
  return `${auditId} - ${safeDriveName(data.companyName)}`;
}

export function normalizeFileName(name) {
  const cleaned = text(name).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').slice(0, 180).trim();
  return cleaned || `upload-${randomUUID()}`;
}

function extensionFor(name) {
  const match = /\.([^.]+)$/.exec(name.toLowerCase());
  return match ? match[1] : '';
}

function arrayText(payload, field) {
  if (Array.isArray(payload[field])) return payload[field].map(text).filter(Boolean).join(', ');
  return text(payload[field]);
}

export function validateFileManifest(files = []) {
  if (!Array.isArray(files)) return { ok: false, error: 'Invalid file manifest.' };
  if (files.length > MAX_FILE_COUNT) return { ok: false, error: `Upload up to ${MAX_FILE_COUNT} files.` };

  let totalBytes = 0;
  const sanitized = [];
  for (const file of files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) return { ok: false, error: 'Invalid file manifest.' };
    const name = normalizeFileName(file.name);
    const size = Number(file.size);
    const type = text(file.type) || 'application/octet-stream';
    const category = ['brand', 'website', 'documents', 'references'].includes(file.category) ? file.category : 'documents';
    const ext = extensionFor(name);

    if (!Number.isSafeInteger(size) || size <= 0) return { ok: false, error: `Invalid size for ${name}.` };
    if (size > MAX_FILE_BYTES) return { ok: false, error: `${name} is larger than 250 MB.` };
    if (BLOCKED_EXTENSIONS.has(ext) || !ALLOWED_EXTENSIONS.has(ext)) return { ok: false, error: `${name} is not an accepted file type.` };

    totalBytes += size;
    sanitized.push({ name, size, type, category });
  }

  if (totalBytes > MAX_TOTAL_FILE_BYTES) return { ok: false, error: 'Uploads cannot exceed 1 GB total.' };
  return { ok: true, files: sanitized, totalBytes };
}

export function validateIntakePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, error: 'Invalid submission.' };

  const data = {};
  for (const [field, limit] of Object.entries(FIELD_LIMITS)) {
    const value = ['projectType', 'services', 'brandTone'].includes(field) ? arrayText(payload, field) : text(payload[field]);
    if (value.length > limit) return { ok: false, error: `Invalid ${FIELD_LABELS[field] || field}.` };
    data[field] = value;
  }

  if (data.companyWebsite) return { ok: false, error: 'Unable to submit this intake.' };
  if (REQUIRED_FIELDS.some((field) => !data[field])) return { ok: false, error: 'Please complete all required fields.' };
  if (!/^\S+@\S+\.\S+$/.test(data.contactEmail)) return { ok: false, error: 'Please provide a valid email address.' };
  if (data.currentWebsite) {
    try {
      const url = new URL(data.currentWebsite);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported protocol');
    } catch {
      return { ok: false, error: 'Please provide a valid website URL.' };
    }
  }
  if (data.agreeTerms !== 'on' && data.agreeTerms !== 'true') return { ok: false, error: 'Please accept the submission agreement.' };

  const fileValidation = validateFileManifest(payload.files || []);
  if (!fileValidation.ok) return fileValidation;

  return { ok: true, data, files: fileValidation.files, totalFileBytes: fileValidation.totalBytes };
}

function wrapText(value, font, size, width) {
  const words = value.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width || !line) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export async function buildPdf(data, auditId, submittedAt, folderUrl = '', files = []) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageSize = [612, 792];
  const margin = 48;
  const bodySize = 10;
  const lineHeight = 14;
  let page = pdf.addPage(pageSize);
  let y = pageSize[1] - margin;

  const newPage = () => {
    page = pdf.addPage(pageSize);
    y = pageSize[1] - margin;
  };
  const ensureSpace = (height) => {
    if (y - height < margin) newPage();
  };
  const drawField = (label, value) => {
    const lines = wrapText(value || 'Not provided', regular, bodySize, pageSize[0] - margin * 2);
    ensureSpace(16 + lines.length * lineHeight + 7);
    page.drawText(label, { x: margin, y, size: 10, font: bold, color: rgb(0.05, 0.14, 0.2) });
    y -= 14;
    for (const line of lines) {
      page.drawText(line, { x: margin, y, size: bodySize, font: regular, color: rgb(0.1, 0.1, 0.1) });
      y -= lineHeight;
    }
    y -= 7;
  };

  page.drawText('APLANIQ', { x: margin, y, size: 21, font: bold, color: rgb(0.05, 0.14, 0.2) });
  y -= 28;
  page.drawText('Website and Marketing Intake Submission', { x: margin, y, size: 15, font: bold, color: rgb(0.05, 0.14, 0.2) });
  y -= 24;
  drawField('Audit ID', auditId);
  drawField('Received', easternTime(submittedAt));
  if (folderUrl) drawField('Google Drive folder', folderUrl);

  for (const field of PDF_FIELDS) drawField(FIELD_LABELS[field], data[field]);
  drawField('Uploaded files', files.length ? files.map((file) => `${file.name} (${file.category})`).join(', ') : 'No files uploaded');

  return pdf.save();
}

export function buildSummaryJson(data, auditId, submittedAt, folderUrl, files) {
  return JSON.stringify({
    auditId,
    submittedAt,
    submittedAtEastern: easternTime(submittedAt),
    folderUrl,
    contact: {
      companyName: data.companyName,
      contactName: data.contactName,
      contactEmail: data.contactEmail,
      contactPhone: data.contactPhone,
    },
    intake: data,
    files,
  }, null, 2);
}
