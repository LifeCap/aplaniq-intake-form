import { createHash, randomUUID } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import nodemailer from 'nodemailer';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const MAX_BODY_BYTES = 32 * 1024;
const AUDIT_STORE = 'aplaniq-intake-audit';
const REQUIRED_FIELDS = ['companyName', 'contactName', 'contactEmail', 'contactPhone', 'industry', 'brandTone', 'services', 'primaryGoal', 'timeline'];
const FIELD_LIMITS = {
  companyName: 160,
  contactName: 160,
  contactTitle: 160,
  contactEmail: 254,
  contactPhone: 64,
  industry: 80,
  companyOverview: 500,
  currentWebsite: 500,
  brandTone: 200,
  brandValues: 300,
  uniqueProposition: 300,
  brandExamples: 300,
  services: 300,
  primaryGoal: 80,
  currentChallenges: 400,
  targetAudience: 300,
  timeline: 80,
  budget: 80,
  additionalNotes: 1000,
  chatbotPurpose: 200,
  agreeTerms: 10,
  agreeMarketing: 10,
  companyWebsite: 200,
};

const FIELD_LABELS = {
  companyName: 'Company name', contactName: 'Primary contact', contactTitle: 'Title', contactEmail: 'Email', contactPhone: 'Phone',
  industry: 'Industry', companyOverview: 'Company overview', currentWebsite: 'Current website', brandTone: 'Brand tone',
  brandValues: 'Core brand values', uniqueProposition: 'What makes you different?', brandExamples: 'Reference brand or competitor',
  services: 'Services of interest', primaryGoal: 'Primary goal', currentChallenges: 'Current challenge', targetAudience: 'Primary audience',
  timeline: 'Timeline', budget: 'Budget range', additionalNotes: 'Additional details', chatbotPurpose: 'Chatbot purpose',
  agreeTerms: 'Submission agreement accepted', agreeMarketing: 'Marketing updates requested',
};

const PDF_FIELDS = Object.keys(FIELD_LABELS);

function text(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function easternTime(isoTime) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', dateStyle: 'long', timeStyle: 'long',
  }).format(new Date(isoTime));
}

export function createAuditId(now = new Date(), uuid = randomUUID()) {
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `APL-${date}-${uuid.slice(0, 8).toUpperCase()}`;
}

export function validateSubmission(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, error: 'Invalid submission.' };

  const data = {};
  for (const [field, limit] of Object.entries(FIELD_LIMITS)) {
    const value = text(payload[field]);
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
  return { ok: true, data };
}

function wrapText(value, font, size, width) {
  const words = value.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width || !line) line = candidate;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

export async function buildPdf(data, auditId, submittedAt) {
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
  const ensureSpace = (height) => { if (y - height < margin) newPage(); };

  page.drawText('APLANIQ', { x: margin, y, size: 21, font: bold, color: rgb(0.05, 0.14, 0.2) });
  y -= 28;
  page.drawText('Client Intake Submission', { x: margin, y, size: 15, font: bold, color: rgb(0.05, 0.14, 0.2) });
  y -= 24;
  page.drawText(`Audit ID: ${auditId}`, { x: margin, y, size: bodySize, font: regular });
  y -= 15;
  page.drawText(`Received: ${easternTime(submittedAt)}`, { x: margin, y, size: bodySize, font: regular });
  y -= 24;

  for (const field of PDF_FIELDS) {
    const value = data[field] || 'Not provided';
    const lines = wrapText(value, regular, bodySize, pageSize[0] - margin * 2);
    ensureSpace(16 + lines.length * lineHeight + 7);
    page.drawText(FIELD_LABELS[field], { x: margin, y, size: 10, font: bold, color: rgb(0.05, 0.14, 0.2) });
    y -= 14;
    for (const line of lines) {
      page.drawText(line, { x: margin, y, size: bodySize, font: regular, color: rgb(0.1, 0.1, 0.1) });
      y -= lineHeight;
    }
    y -= 7;
  }
  return pdf.save();
}

function smtpTransport() {
  const { SMTP_HOST, SMTP_PORT = '465', SMTP_USER, SMTP_PASSWORD } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) throw new Error('SMTP is not configured.');
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
  });
}

export default async function handler(request) {
  if (request.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' });
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY_BYTES) return jsonResponse(413, { error: 'Submission is too large.' });

  let payload;
  try { payload = await request.json(); } catch { return jsonResponse(400, { error: 'Invalid submission.' }); }
  const validation = validateSubmission(payload);
  if (!validation.ok) return jsonResponse(400, { error: validation.error });

  const submittedAt = new Date().toISOString();
  const auditId = createAuditId(new Date(submittedAt));
  const recipient = process.env.INTAKE_RECIPIENT || 'hello@aplaniq.co';
  const payloadHash = createHash('sha256').update(JSON.stringify(validation.data)).digest('hex');
  const store = getStore(AUDIT_STORE);
  const auditRecord = { auditId, submittedAt, submittedAtEastern: easternTime(submittedAt), companyName: validation.data.companyName, contactEmail: validation.data.contactEmail, recipient, status: 'received', payloadHash };

  try {
    await store.set(auditId, JSON.stringify(auditRecord));
  } catch (error) {
    console.error('Unable to create intake audit record.', error);
    return jsonResponse(503, { error: 'Unable to process your intake. Please try again.' });
  }

  try {
    const pdf = await buildPdf(validation.data, auditId, submittedAt);
    const result = await smtpTransport().sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: recipient,
      replyTo: validation.data.contactEmail,
      subject: `New APLANIQ intake: ${validation.data.companyName} (${auditId})`,
      text: `A new APLANIQ intake is attached as a PDF.\n\nAudit ID: ${auditId}\nReceived: ${easternTime(submittedAt)}`,
      attachments: [{ filename: `aplaniq-intake-${auditId}.pdf`, content: Buffer.from(pdf), contentType: 'application/pdf' }],
    });
    auditRecord.status = 'delivered';
    auditRecord.emailMessageId = result.messageId || null;
    try { await store.set(auditId, JSON.stringify(auditRecord)); }
    catch (error) { console.error('Intake email sent but audit delivery update failed.', error); }
    return jsonResponse(200, { ok: true, auditId });
  } catch (error) {
    console.error(`Intake delivery failed for ${auditId}.`, error);
    auditRecord.status = 'delivery_failed';
    auditRecord.failureReason = 'SMTP delivery failed';
    try { await store.set(auditId, JSON.stringify(auditRecord)); }
    catch (auditError) { console.error('Unable to record intake delivery failure.', auditError); }
    return jsonResponse(502, { error: 'We could not send your intake. Please try again shortly.' });
  }
}
