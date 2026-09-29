import { test, expect } from '@playwright/test';

test('canonical routes, old bookmarks and genuine 404', async ({ page, request }) => {
  const legacy = await request.get('/signin.html?next=%2Fclient%2Frfqs', { maxRedirects: 0 });
  expect(legacy.status()).toBe(308);
  expect(legacy.headers().location).toBe('/signin?next=%2Fclient%2Frfqs');
  await page.goto('/signin');
  await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/signin');
  expect((await request.get('/client/this-route-does-not-exist')).status()).toBe(404);
});

test('client and vendor registration controls work without submitting', async ({ page }) => {
  await page.goto('/signup#client');
  await expect(page.locator('#clientForm')).toBeVisible();
  await expect(page.locator('#submitClientRegistration')).toBeDisabled();
  await page.locator('#clientClickwrapAccept').check();
  await expect(page.locator('#submitClientRegistration')).toBeEnabled();
  await page.goto('/signup#vendor');
  await expect(page.locator('#vendorForm')).toBeVisible();
  await expect(page.locator('#tradeLicenseFile')).toHaveCount(0);
});

test('forgot password form and mobile navigation render', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/signin');
  await page.locator('#forgotToggle').click();
  await expect(page.locator('#forgotEmail')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  expect(overflow).toBe(false);
});

test('protected workspaces require a real session', async ({ page }) => {
  await page.goto('/admin/dashboard');
  await expect(page).toHaveURL(/\/signin\?next=/);
});
