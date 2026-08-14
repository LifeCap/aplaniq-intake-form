import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sampleImagePath = path.resolve(__dirname, '..', '..', 'aplaniq-wordmark-white-2048.png');

test('submits an intake with an uploaded image', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');

  await page.getByLabel('Company name *').fill('Acme LLC');
  await page.getByLabel('Your name *').fill('Jane Doe');
  await page.getByLabel('Email *').fill('jane@example.com');
  await page.getByLabel('Phone *').fill('555-0100');
  await page.getByLabel('Industry *').selectOption('services');
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByRole('checkbox', { name: 'New website or redesign' }).check();
  await page.getByRole('textbox', { name: 'If you need a new website or redesign, what should it include?' }).fill('Home, services, contact form, and booking.');
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByRole('checkbox', { name: 'Website design and build' }).check();
  await page.getByLabel('Main goal *').selectOption('launch');
  await page.getByLabel('When do you want to start or launch? *').selectOption('quarter');
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByRole('checkbox', { name: 'Professional and formal' }).check();
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByLabel('Choose files').setInputFiles(sampleImagePath);
  await expect(page.locator('#fileList')).toContainText('aplaniq-wordmark-white-2048.png');
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByLabel(/I agree to the terms above/i).check();
  await page.getByRole('button', { name: 'Submit Intake' }).click();

  await expect(page.getByRole('heading', { name: 'Submission received' })).toBeVisible();
  await expect(page.getByText('Your intake has been received.')).toBeVisible();
  expect(pageErrors, `Unexpected page errors: ${pageErrors.join('\n')}`).toEqual([]);
});
