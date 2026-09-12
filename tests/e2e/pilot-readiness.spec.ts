import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/**
 * The two screens that decide whether a restaurant can be onboarded and run
 * without an engineer: the conversations inbox (backlog B-24) and the WhatsApp
 * and notification settings (B-21).
 *
 * Driven in a real browser for the reason the other browser suite exists: the
 * API tests prove the server behaves, and only a browser proves that a manager
 * can actually read a waiting customer and reply to them.
 */

const API = process.env.API_URL ?? 'http://127.0.0.1:3001';
const OWNER = { email: 'ali@homekitchen.test', password: 'RestaurantOS123!' };
const CONTACT = `+9230055${Math.floor(10000 + Math.random() * 89999)}`;

/**
 * Signs in from the TEST process and returns an access token.
 *
 * Deliberately independent of the browser's session: borrowing the browser's
 * refresh cookie races the app's own refresh, and rotation with reuse detection
 * then revokes the whole chain — which is a bug this suite already found once.
 */
async function apiToken(): Promise<string> {
  const response = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(OWNER),
  });

  const body = await response.json();
  if (!body?.data?.accessToken) {
    throw new Error(`Could not sign in from the test process: ${JSON.stringify(body)}`);
  }
  return body.data.accessToken as string;
}

async function apiCall(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(`${API}/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });

  const payload = await response.json().catch(() => null);
  return { status: response.status, data: payload?.data ?? payload };
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/orders', { timeout: 20_000 });
}

/**
 * Puts a customer into HUMAN_HANDOFF by actually talking to the bot.
 *
 * Through the webhook rather than by writing rows: the point of this suite is
 * that the whole path works, and a hand-written session would not prove the bot
 * ever hands anything over.
 */
async function askForAPerson(token: string, phoneNumberId: string): Promise<void> {
  const say = async (text: string) => {
    await fetch(`${API}/api/v1/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: phoneNumberId },
                  messages: [
                    {
                      id: `wamid-${randomUUID()}`,
                      from: CONTACT.slice(1),
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: 'text',
                      text: { body: text },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    });
  };

  await say('salam');
  await say('I want to speak to a person about my order');
}

test.describe('pilot readiness', () => {
  let token: string;
  let phoneNumberId: string;

  test.beforeAll(async () => {
    token = await apiToken();

    // Connect a number through the API the settings screen uses, so the rest of
    // the suite has something to work with.
    phoneNumberId = `pn-e2e-${randomUUID().slice(0, 8)}`;
    const created = await apiCall(token, '/notifications/whatsapp/accounts', {
      method: 'POST',
      body: { phoneNumberId, displayNumber: '03009990000', provider: 'log' },
    });

    expect(created.status).toBe(201);
    await askForAPerson(token, phoneNumberId);
  });

  test.afterAll(async () => {
    const accounts = (await apiCall(token, '/notifications/whatsapp/accounts')).data as Array<{
      id: string;
      phoneNumberId: string;
    }>;

    for (const account of accounts) {
      if (account.phoneNumberId === phoneNumberId) {
        await apiCall(token, `/notifications/whatsapp/accounts/${account.id}`, {
          method: 'PATCH',
          body: { isActive: false },
        });
      }
    }
  });

  test('the navigation shows how many customers are waiting', async ({ page }) => {
    await signIn(page);

    // The badge is the whole point: nobody keeps an inbox tab open during a
    // dinner rush, so the number has to be visible from wherever they are.
    const link = page.getByRole('link', { name: /Conversations/ });
    await expect(link).toBeVisible();
    await expect(link.locator('.nav-badge')).toHaveText(/[1-9]/, { timeout: 20_000 });
  });

  test('a waiting customer can be read and replied to', async ({ page }) => {
    await signIn(page);
    await page.getByRole('link', { name: /Conversations/ }).click();
    await page.waitForURL('**/conversations');

    // Waiting time is the loudest thing on the row.
    const row = page.locator('.inbox-row', { hasText: CONTACT });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.locator('.pill')).toContainText('waiting');

    await row.click();

    // The thread shows what the customer said and what the bot already replied.
    await expect(page.locator('.bubble-in').last()).toContainText('speak to a person');
    await expect(page.locator('.bubble-out').last()).toContainText('passed this conversation');

    const reply = `Sorry about that — checking now. ${randomUUID().slice(0, 6)}`;
    await page.locator('.thread-reply textarea').fill(reply);
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.locator('.bubble-out').last()).toContainText(reply, { timeout: 15_000 });
  });

  test('handing back to the bot clears the conversation from the inbox', async ({ page }) => {
    await signIn(page);
    await page.goto('/conversations');

    const row = page.locator('.inbox-row', { hasText: CONTACT });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();

    await page.getByRole('button', { name: 'Hand back to the bot' }).click();

    // Gone from the default list, which shows only who is waiting.
    await expect(page.locator('.inbox-row', { hasText: CONTACT })).toHaveCount(0, {
      timeout: 15_000,
    });

    // Still there with the filter off — handed back, not deleted.
    await page.getByLabel('Show all conversations').check();
    await expect(page.locator('.inbox-row', { hasText: CONTACT })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('a number can be connected without an engineer', async ({ page }) => {
    await signIn(page);
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.waitForURL('**/settings');

    const newNumberId = `pn-ui-${randomUUID().slice(0, 8)}`;

    await page.getByLabel('Phone number ID').fill(newNumberId);
    await page.getByLabel('Number', { exact: true }).fill('03211234567');
    await page.getByLabel('Access token').fill('a-secret-token-value');
    await page.getByRole('button', { name: 'Connect' }).click();

    const row = page.locator('tr', { hasText: newNumberId });
    await expect(row).toBeVisible({ timeout: 15_000 });
    // Recorded as set, never shown: a settings page displaying an access token
    // is one screenshot away from leaking it.
    await expect(row).toContainText('Set');
    await expect(page.locator('body')).not.toContainText('a-secret-token-value');

    await row.getByRole('button', { name: 'Deactivate' }).click();
    await expect(row).toContainText('inactive', { timeout: 15_000 });
  });

  test('a rejected template is impossible to miss', async ({ page }) => {
    // The single likeliest reason a restaurant's customers stop hearing from
    // them, and it fails silently everywhere else.
    const accounts = (await apiCall(token, '/notifications/whatsapp/accounts')).data as Array<{
      id: string;
      phoneNumberId: string;
    }>;
    const account = accounts.find((row) => row.phoneNumberId === phoneNumberId)!;

    const providerName = `order_confirmed_${randomUUID().slice(0, 6)}`;

    const template = await apiCall(token, '/notifications/whatsapp/templates', {
      method: 'POST',
      body: {
        accountId: account.id,
        templateKey: 'order_confirmed',
        providerName,
        category: 'UTILITY',
        body: 'Hi {{1}}, order {{2}} at {{3}} is confirmed.',
      },
    });

    const templateId = (template.data as { id: string }).id;

    await apiCall(token, `/notifications/whatsapp/templates/${templateId}`, {
      method: 'PATCH',
      body: {
        status: 'REJECTED',
        rejectionReason: 'Promotional content in a utility template',
      },
    });

    await signIn(page);
    await page.goto('/settings');

    // Called out at the top of the page, not buried in the table.
    await expect(page.locator('.error').first()).toContainText('rejected or paused', {
      timeout: 15_000,
    });
    // And Meta's own words next to the template it refused, since that is the
    // only text that says how to fix it. Scoped to this run's template: a dev
    // database accumulates rejected ones, which is itself realistic.
    const row = page.locator('tr', { hasText: providerName });
    await expect(row.locator('.error-inline')).toContainText('Promotional content');
  });

  test('notification channels can be turned off and stay off', async ({ page }) => {
    await signIn(page);
    await page.goto('/settings');

    const toggle = page.getByLabel('SMS for CUSTOMER');
    await expect(toggle).toBeVisible({ timeout: 15_000 });

    const wasOn = await toggle.isChecked();
    await toggle.click();
    await page.waitForTimeout(500);

    await page.reload();
    await expect(page.getByLabel('SMS for CUSTOMER')).toBeChecked({ checked: !wasOn });

    // Put it back, so a re-run starts where this one did.
    await page.getByLabel('SMS for CUSTOMER').click();
  });
});
