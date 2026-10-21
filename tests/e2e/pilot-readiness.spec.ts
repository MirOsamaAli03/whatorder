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
    const response = await apiCall(token, '/notifications/whatsapp/accounts');

    // A failed call returns an error envelope rather than a list, and cleanup
    // throwing would replace a real test failure with a confusing one about
    // teardown.
    const accounts = Array.isArray(response.data)
      ? (response.data as Array<{ id: string; phoneNumberId: string }>)
      : [];

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
    await expect(link.locator('.badge')).toHaveText(/[1-9]/, { timeout: 20_000 });
  });

  test('a waiting customer can be read and replied to', async ({ page }) => {
    await signIn(page);
    await page.getByRole('link', { name: /Conversations/ }).click();
    await page.waitForURL('**/conversations');

    // Waiting time is the loudest thing on the row.
    const row = page.locator('.inbox-row', { hasText: CONTACT });
    await expect(row).toBeVisible({ timeout: 20_000 });
    // The wait is its own block on the row now, not a pill at the end of it.
    await expect(row.locator('.wait')).toBeVisible();

    await row.click();

    // The thread shows what the customer said and what the bot already replied.
    await expect(page.locator('.msg-in .bubble').last()).toContainText('speak to a person');
    await expect(page.locator('.msg-out .bubble').last()).toContainText('passed this conversation');

    const reply = `Sorry about that — checking now. ${randomUUID().slice(0, 6)}`;
    await page.locator('.composer textarea').fill(reply);
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.locator('.msg-out .bubble').last()).toContainText(reply, { timeout: 15_000 });
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
    // The box is drawn; the real input sits behind it at opacity 0. Click what a
    // person clicks.
    await page.locator('.inbox-list-head .check').click();
    await expect(page.locator('.inbox-row', { hasText: CONTACT })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('a number can be connected without an engineer', async ({ page }) => {
    await signIn(page);
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.waitForURL('**/settings');

    const newNumberId = `pn-ui-${randomUUID().slice(0, 8)}`;

    // The form is behind a button now: a restaurant arriving here has a phone
    // in their hand and no idea what a "phone number ID" is, so the steps come
    // first and the five fields only when they ask for them.
    await page.getByRole('button', { name: /^Connect (a WhatsApp|another) number$/ }).click();

    await page.getByLabel('Phone number ID').fill(newNumberId);
    await page.getByLabel('Number', { exact: true }).fill('03211234567');
    await page.getByLabel('Access token').fill('a-secret-token-value');
        // Exact: Playwright matches names by substring, and "Disconnect" contains
    // "Connect" — an inexact query here resolved to two dozen buttons.
    await page.getByRole('button', { name: 'Connect', exact: true }).click();

    const row = page.locator('.wa-status', { hasText: newNumberId });
    await expect(row).toBeVisible({ timeout: 15_000 });
    // Recorded as stored, never shown: a settings page displaying an access
    // token is one screenshot away from leaking it.
    await expect(row).toContainText('Access token stored');
    await expect(page.locator('body')).not.toContainText('a-secret-token-value');

    await row.getByRole('button', { name: 'Disconnect' }).click();
    await expect(row).toContainText('Paused', { timeout: 15_000 });
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
    // Scoped to our own alert: Next renders an empty role="alert" route
    // announcer on every page, and .first() can land on it.
    await expect(page.locator('.alert[role="alert"]').first()).toContainText('not usable', {
      timeout: 15_000,
    });
    // And Meta's own words next to the template it refused, since that is the
    // only text that says how to fix it. Scoped to this run's template: a dev
    // database accumulates rejected ones, which is itself realistic.
    const row = page.locator('.tpl', { hasText: providerName });
    await expect(row.locator('.field-error')).toContainText('Promotional content');
  });

  test('notification channels can be turned off and stay off', async ({ page }) => {
    await signIn(page);
    await page.goto('/settings');

    // The grid's boxes are drawn, with the real input behind at opacity 0, so
    // the state is read from the input and the click lands on the label.
    const cell = page
      .locator('.ngrid tr', { hasText: 'The customer' })
      .locator('.check')
      .nth(1);
    const state = () => page.getByLabel('Text message for The customer');

    await expect(state()).toHaveCount(1, { timeout: 15_000 });
    const wasOn = await state().isChecked();

    await cell.click();
    await page.waitForTimeout(500);

    await page.reload();
    await expect(state()).toBeChecked({ checked: !wasOn });

    // Put it back, so a re-run starts where this one did.
    await page
      .locator('.ngrid tr', { hasText: 'The customer' })
      .locator('.check')
      .nth(1)
      .click();
  });
});
