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

test('the Connections page guides a new owner and never echoes query text', async ({ page }) => {
  const email = `e2e+conn${Date.now()}@example.com`;
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Business name').fill('E2E Connections');
  await page.getByRole('button', { name: 'Create business' }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  await page.getByRole('link', { name: 'Connections' }).click();
  await expect(page.getByRole('heading', { name: 'Connections' })).toBeVisible();
  await expect(page.getByText(/Connect your Shopify store to see your real profit/)).toBeVisible();

  await page.getByLabel('Your Shopify store address').fill('evil.com');
  await expect(page.getByText(/does not look like a Shopify address/)).toBeVisible();
  await page.getByLabel('Your Shopify store address').fill('my-store');
  await expect(page.getByText('We will connect my-store.myshopify.com.')).toBeVisible();

  await page.goto('/connections?shopify_error=%3Cscript%3Ealert(1)%3C/script%3E');
  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).not.toContainText('script');
  await page.goto('/connections?shopify=connected');
  await expect(page.getByRole('status').filter({ hasText: 'connected' })).toBeVisible();
});

// Unverified locally: needs the API, Supabase and a browser (runs in CI).
test('a signed-out Shopify callback goes to login and keeps its query for the way back', async ({
  page,
}) => {
  await page.goto('/connections/shopify/callback?code=x&state=y&hmac=z');
  await expect(page).toHaveURL(/\/login\?next=/);
  const next = new URL(page.url()).searchParams.get('next');
  expect(next).toBe('/connections/shopify/callback?code=x&state=y&hmac=z');
});
