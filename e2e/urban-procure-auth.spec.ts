import { test, expect, type Page } from '@playwright/test';

test.skip(process.env.RUN_MUTATING_E2E !== '1', 'Requires an isolated staging backend and explicit opt-in.');

const stamp = Date.now();
const QA = {
  email: `qa.auth.${stamp}@example.com`,
  password: 'QaPass1234!',
  company: 'QA Auth Desk LLC',
  name: 'QA Runner',
  phone: '+971501234567'
};

async function openSignupClient(page: Page) {
  await page.goto('/signup');
  await expect(page.getByRole('heading', { name: 'Create Account' })).toBeVisible();
  await page.locator('button.role-select').filter({ hasText: 'Client / Contractor' }).click();
  await expect(page.locator('#clientForm #email')).toBeVisible();
}

async function fillClientSignup(page: Page, email: string, password: string) {
  await page.locator('#companyName').fill(QA.company);
  await page.locator('#contactPerson').fill(QA.name);
  await page.locator('#phone').fill(QA.phone);
  await page.locator('#clientForm #email').fill(email);
  await page.locator('#clientForm #password').fill(password);
  await page.locator('#confirmPassword').fill(password);
  await page.locator('#clientClickwrapAccept').check();
  await expect(page.locator('#submitClientRegistration')).toBeEnabled();
}

async function signInAsQa(page: Page) {
  await page.goto('/signin');
  await page.locator('#signInForm #email').fill(QA.email);
  await page.locator('#signInForm #password').fill(QA.password);
  await Promise.all([
    page.waitForURL(/\/client\/dashboard/i, { timeout: 25_000 }),
    page.locator('#signInForm button[type="submit"]').click()
  ]);
  await expect(page.getByText(/Overview|Client workspace/i).first()).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.describe('Signup Flow', () => {
  test('signup fails with invalid email', async ({ page }) => {
    await openSignupClient(page);
    await fillClientSignup(page, 'not-an-email', QA.password);
    await page.locator('#submitClientRegistration').click();
    const email = page.locator('#clientForm #email');
    const invalid = await email.evaluate((el: HTMLInputElement) => !el.checkValidity());
    expect(invalid).toBeTruthy();
  });

  test('signup fails with weak password', async ({ page }) => {
    await openSignupClient(page);
    await fillClientSignup(page, `qa.weak.${stamp}@example.com`, '123');
    await page.locator('#submitClientRegistration').click();
    const pwd = page.locator('#clientForm #password');
    const invalid = await pwd.evaluate((el: HTMLInputElement) => !el.checkValidity());
    const shown = await page.locator('#clientFormMsg').isVisible().catch(() => false);
    expect(invalid || shown).toBeTruthy();
  });

  test('signup succeeds with valid data', async ({ page }) => {
    await openSignupClient(page);
    await fillClientSignup(page, QA.email, QA.password);
    await Promise.all([
      page.waitForURL(/dashboard-client|signin/i, { timeout: 25_000 }),
      page.locator('#submitClientRegistration').click()
    ]);
    await expect(page).toHaveURL(/\/client\/dashboard|\/signin/i);
  });

  test('signup fails on duplicate email', async ({ page }) => {
    await openSignupClient(page);
    await fillClientSignup(page, QA.email, QA.password);
    await page.locator('#submitClientRegistration').click();
    await expect(page.locator('#clientFormMsg')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#clientFormMsg')).toContainText(/already|exists|registered|sign in/i);
  });
});

test.describe('Login Flow', () => {
  test('login page loads', async ({ page }) => {
    await page.goto('/signin');
    await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible();
    await expect(page.locator('#signInForm #email')).toBeVisible();
    await expect(page.locator('#signInForm #password')).toBeVisible();
    await expect(page.locator('#signInForm button[type="submit"]')).toHaveText(/^Sign In$/i);
  });

  test('login fails with wrong password', async ({ page }) => {
    await page.goto('/signin');
    await page.locator('#signInForm #email').fill(QA.email);
    await page.locator('#signInForm #password').fill('WrongPass!999');
    await page.locator('#signInForm button[type="submit"]').click();
    await expect(page.locator('#signInMsg')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#signInMsg')).toContainText(/not recognised|invalid|password|account/i);
    await expect(page).toHaveURL(/signin/i);
  });

  test('login succeeds with correct creds', async ({ page }) => {
    await signInAsQa(page);
  });

  test('session persists on reload', async ({ page }) => {
    await signInAsQa(page);
    await page.reload();
    await expect(page).toHaveURL(/\/client\/dashboard/i);
    await expect(page.getByText(/Overview|Client workspace/i).first()).toBeVisible();
  });

  test('logout clears session', async ({ page }) => {
    await signInAsQa(page);
    await page.locator('#signOutBtn').click();
    await page.waitForURL(/\/$|signin/i, { timeout: 15_000 });
    await page.goto('/client/dashboard');
    await expect(page).toHaveURL(/signin/i);
  });

  test('forgot password flow starts', async ({ page }) => {
    await page.goto('/signin');
    await page.locator('#forgotToggle').click();
    await expect(page.locator('#forgotPanel')).toBeVisible();
    await page.locator('#forgotEmail').fill(QA.email);
    await page.locator('#forgotForm button[type="submit"]').click();
    await expect(page.locator('#forgotMsg')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#forgotMsg')).toContainText(/reset link|inbox|spam|sent/i);
  });
});
