import { expect, test } from '@playwright/test';

test('a new user signs up, creates a business, and invites a teammate', async ({ page }) => {
  const email = `e2e+${Date.now()}@example.com`;

  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/onboarding/);

  await page.getByLabel('Business name').fill('E2E Outfitters');
  await page.getByRole('button', { name: 'Create business' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole('heading', { name: 'E2E Outfitters' })).toBeVisible();

  await page.getByRole('link', { name: 'Team' }).click();
  await expect(page.getByText('owner')).toBeVisible();
  await page.getByLabel('Teammate email').fill('teammate@example.com');
  await page.getByRole('button', { name: 'Send invite' }).click();
  await expect(page.getByText(/\/invite\//)).toBeVisible();
});

test('signed-out visitors are sent to login and keep their destination safely', async ({
  page,
}) => {
  await page.goto('/team');
  await expect(page).toHaveURL(/\/login\?next=%2Fteam/);
  await page.goto('/login?next=//evil.com');
  await expect(page.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
    'href',
    /next=%2Fdashboard/,
  );
});
