import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPdf, createAuditId, validateSubmission } from '../netlify/functions/submit-intake.mjs';

const validSubmission = {
  companyName: 'Acme LLC', contactName: 'Jane Doe', contactTitle: 'Owner', contactEmail: 'jane@example.com', contactPhone: '555-0100',
  industry: 'services', companyOverview: 'A helpful company.', currentWebsite: 'https://example.com', brandTone: 'friendly',
  brandValues: 'Trust', uniqueProposition: 'Fast support.', brandExamples: '', services: 'website, seo', primaryGoal: 'leads',
  currentChallenges: '', targetAudience: '', timeline: 'quarter', budget: 'mid', additionalNotes: '', chatbotPurpose: '', agreeTerms: 'on', agreeMarketing: 'on', companyWebsite: '',
};

test('accepts a complete intake', () => {
  const result = validateSubmission(validSubmission);
  assert.equal(result.ok, true);
  assert.equal(result.data.companyName, 'Acme LLC');
});

test('rejects missing agreement, invalid email, and honeypot input', () => {
  assert.equal(validateSubmission({ ...validSubmission, agreeTerms: '' }).ok, false);
  assert.equal(validateSubmission({ ...validSubmission, brandTone: '' }).ok, false);
  assert.equal(validateSubmission({ ...validSubmission, services: '' }).ok, false);
  assert.equal(validateSubmission({ ...validSubmission, contactEmail: 'not-an-email' }).ok, false);
  assert.equal(validateSubmission({ ...validSubmission, companyWebsite: 'https://spam.example' }).ok, false);
});

test('creates collision-resistant audit IDs', () => {
  const now = new Date('2026-08-12T12:00:00.000Z');
  const first = createAuditId(now, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  const second = createAuditId(now, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  assert.match(first, /^APL-20260812-AAAAAAAA$/);
  assert.notEqual(first, second);
});

test('builds a non-empty PDF', async () => {
  const pdf = await buildPdf(validSubmission, 'APL-20260812-AAAAAAAA', '2026-08-12T12:00:00.000Z');
  assert.ok(pdf.length > 1000);
  assert.equal(Buffer.from(pdf).subarray(0, 4).toString(), '%PDF');
});
