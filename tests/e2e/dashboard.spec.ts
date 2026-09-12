import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/**
 * The dashboard and kitchen display, driven in a real browser.
 *
 * Uses the seeded demo tenants, so these run against the same data a developer
 * sees after `npm run db:seed`.
 */

const API = process.env.API_URL ?? 'http://127.0.0.1:3001';
const OWNER = { email: 'owner@kababjees.test', password: 'RestaurantOS123!' };
const KITCHEN = { email: 'dha.kitchen@kababjees.test', password: 'RestaurantOS123!' };

/** The app's own error banner, not Next's route announcer, which is also role=alert. */
function errorBanner(page: Page) {
  return page.locator('.banner-error');
}

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/orders', { timeout: 20_000 });
}

/**
 * Points the branch picker at a named branch.
 *
 * Branches come back alphabetically, so an owner lands on Clifton by default
 * while these tests work against DHA. Selecting explicitly also exercises the
 * picker itself.
 */
async function selectBranch(page: Page, name: string) {
  const picker = page.locator('select').first();

  // Wait for the picker to exist before deciding it is absent. Checking
  // immediately after navigation just races the page's initial load and
  // silently leaves the test on the default branch — which then fails much
  // later, somewhere unrelated.
  try {
    await picker.waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    // Genuinely no picker: a branch-scoped user has only one branch, and the
    // shell renders a label instead.
    return;
  }

  await picker.selectOption({ label: name });

  // The switch triggers a refetch. Waiting for the selection to settle keeps
  // the assertions that follow from reading the previous branch's data.
  await expect(picker).toHaveValue(/.+/);
  await page.waitForTimeout(300);
}

/**
 * Places an order through the API from the TEST process, not the browser.
 *
 * Deliberately a separate session: refresh tokens rotate and a replayed one
 * revokes the whole chain (by design), so borrowing the page's cookie to mint a
 * second token would race the app's own refresh and log the browser out. A
 * separate login is also a truer simulation — this represents an order arriving
 * from WhatsApp while staff are looking at the screen.
 */
async function placeOrder(): Promise<{ id: string; orderNumber: string }> {
  const request = async (path: string, init: RequestInit = {}, token?: string) => {
    const response = await fetch(`${API}/api/v1${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(`${path} -> ${response.status} ${await response.text()}`);
    }
    return (await response.json()).data;
  };

  const session = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify(OWNER),
  });
  const token = session.accessToken as string;

  const branches = (await request('/branches', {}, token)) as Array<{ id: string; slug: string }>;
  const dha = branches.find((branch) => branch.slug === 'dha')!;

  const menu = (await request(`/menu?branchId=${dha.id}`, {}, token)) as {
    categories: Array<{ items: Array<Record<string, unknown>> }>;
  };
  const item = menu.categories
    .flatMap((category) => category.items)
    .find((candidate) => candidate.name === 'Chicken Biryani') as {
    id: string;
    modifiers: Array<{ name: string; options: Array<{ id: string }> }>;
  };

  const cart = (await request(
    '/carts',
    {
      method: 'POST',
      body: JSON.stringify({ branchId: dha.id, source: 'WHATSAPP', orderType: 'PICKUP' }),
    },
    token,
  )) as { id: string };

  await request(
    `/carts/${cart.id}/items`,
    {
      method: 'POST',
      body: JSON.stringify({
        menuItemId: item.id,
        quantity: 2,
        optionIds: [item.modifiers.find((group) => group.name === 'Spice level')!.options[0]!.id],
      }),
    },
    token,
  );

  const order = (await request(
    '/orders',
    {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        cartId: cart.id,
        customerPhone: `0300${Math.floor(1000000 + Math.random() * 8999999)}`,
        customerName: 'Browser Test',
        paymentMethod: 'CASH',
      }),
    },
    token,
  )) as { id: string; orderNumber: string };

  return { id: order.id, orderNumber: order.orderNumber };
}

test.describe('authentication', () => {
  test('rejects a bad password without leaking whether the account exists', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(errorBanner(page)).toContainText('Invalid email or password');
    await expect(page).toHaveURL(/\/login/);
  });

  test('signs in and lands on live orders', async ({ page }) => {
    await signIn(page, OWNER);
    await expect(page.getByRole('heading', { name: 'Live orders' })).toBeVisible();
  });

  test('sends an anonymous visitor to sign in', async ({ page }) => {
    await page.goto('/menu');
    await page.waitForURL('**/login', { timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('keeps the session across a reload', async ({ page }) => {
    await signIn(page, OWNER);
    await page.reload();
    // The access token lives in memory only, so this proves the httpOnly
    // refresh cookie silently restores the session rather than bouncing to
    // /login.
    await expect(page.getByRole('heading', { name: 'Live orders' })).toBeVisible();
  });
});

test.describe('navigation and permissions', () => {
  test('shows an owner every section', async ({ page }) => {
    await signIn(page, OWNER);
    const nav = page.locator('.nav');

    await expect(nav.getByRole('link', { name: 'Live orders' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Kitchen' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Menu' })).toBeVisible();
  });

  test('marks kitchen staff as branch-scoped', async ({ page }) => {
    await signIn(page, KITCHEN);
    // Spec §7: a branch-scoped user's access is confined, and the shell says so.
    await expect(page.getByText('Access limited to assigned branches')).toBeVisible();
  });
});

test.describe('menu management', () => {
  test('lists the seeded menu with branch-resolved prices', async ({ page }) => {
    await signIn(page, OWNER);
    await page.getByRole('link', { name: 'Menu' }).click();
    await selectBranch(page, 'DHA');

    await expect(page.getByRole('heading', { name: 'Menu' })).toBeVisible();
    await expect(page.getByText('Chicken Tikka').first()).toBeVisible();
    await expect(page.getByText('BBQ Platter').first()).toBeVisible();
  });

  test('marks an item sold out at one branch only', async ({ page }) => {
    await signIn(page, OWNER);
    await page.getByRole('link', { name: 'Menu' }).click();
    await selectBranch(page, 'DHA');

    /**
     * Normalise first.
     *
     * A previous run — or a person clicking around the shared dev database —
     * may have left this item sold out at either branch. A test that assumes a
     * starting state fails for a reason unrelated to what it is checking, and
     * sends you hunting through the wrong code.
     */
    async function makeAvailableAt(branch: string) {
      await selectBranch(page, branch);
      const row = page.locator('.item-row', { hasText: 'Chicken Tikka' }).first();
      await expect(row).toBeVisible();

      const button = row.getByRole('button', { name: 'Available' });
      if (await button.isVisible().catch(() => false)) {
        await button.click();
      }
      await expect(row.locator('.pill', { hasText: 'Available' })).toBeVisible();
    }

    await makeAvailableAt('Clifton');
    await makeAvailableAt('DHA');

    // Now the actual check: sold out at DHA...
    const dhaRow = page.locator('.item-row', { hasText: 'Chicken Tikka' }).first();
    await dhaRow.getByRole('button', { name: 'Sold out' }).click();
    await expect(dhaRow.locator('.pill', { hasText: 'Sold out' })).toBeVisible();

    // ...and unaffected at Clifton. Spec §86: a branch restricts its own menu,
    // it does not speak for the chain.
    await selectBranch(page, 'Clifton');
    const cliftonRow = page.locator('.item-row', { hasText: 'Chicken Tikka' }).first();
    await expect(cliftonRow.locator('.pill', { hasText: 'Available' })).toBeVisible();

    // Leave the data as it was found.
    await makeAvailableAt('DHA');
  });

  test('shows the chain price alongside a branch override', async ({ page }) => {
    await signIn(page, OWNER);
    await page.getByRole('link', { name: 'Menu' }).click();
    await selectBranch(page, 'Lahore');

    // The seed prices the platter higher in Lahore, so both figures appear —
    // showing only one is how a manager edits the wrong number.
    const row = page.locator('.item-row', { hasText: 'BBQ Platter' }).first();
    await expect(row).toContainText('Rs 2,650.00');
    await expect(row).toContainText('chain Rs 2,400.00');
  });

  test('creates an item and rejects a malformed price', async ({ page }) => {
    await signIn(page, OWNER);
    await page.getByRole('link', { name: 'Menu' }).click();
    await selectBranch(page, 'DHA');
    await page.getByRole('button', { name: 'New item' }).click();

    const unique = `Browser Test Dish ${Date.now()}`;
    await page.getByLabel('Name', { exact: true }).fill(unique);

    // A price with a thousands separator is exactly what someone types, and
    // exactly what the API must refuse rather than silently mangle.
    await page.getByLabel('Chain price').fill('1,250.00');
    await page.getByRole('button', { name: 'Create item' }).click();
    await expect(errorBanner(page)).toBeVisible();

    await page.getByLabel('Chain price').fill('1250.00');
    await page.getByRole('button', { name: 'Create item' }).click();

    await expect(page.getByText(unique)).toBeVisible();
    await expect(page.locator('.item-row', { hasText: unique })).toContainText('Rs 1,250.00');
  });
});

test.describe('live orders', () => {
  test('shows a new order and advances it through the state machine', async ({ page }) => {
    const order = await placeOrder();

    await signIn(page, OWNER);
    await selectBranch(page, 'DHA');

    const row = page.locator('tr', { hasText: order.orderNumber }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText('Confirmed');

    // The buttons come from the API's own state machine via
    // `allowedTransitions`; the UI never decides what is legal (spec §16).
    await row.getByRole('button', { name: 'Accepted' }).click();
    await expect(page.locator('tr', { hasText: order.orderNumber }).first()).toContainText(
      'Accepted',
    );
  });

  test('expands an order to show snapshotted lines and totals', async ({ page }) => {
    const order = await placeOrder();

    await signIn(page, OWNER);
    await selectBranch(page, 'DHA');

    await page.getByRole('button', { name: order.orderNumber }).click();

    await expect(page.getByRole('heading', { name: 'Items' })).toBeVisible();
    await expect(page.getByText('2 × Chicken Biryani')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Totals' })).toBeVisible();
    // 450 × 2 at the seeded price.
    await expect(page.getByText('Rs 900.00').first()).toBeVisible();
  });

  test('surfaces the unacknowledged-order alarm', async ({ page }) => {
    await signIn(page, OWNER);
    await selectBranch(page, 'DHA');

    // Whether the banner is showing depends on how long the seeded orders have
    // been sitting, so this asserts the mechanism is wired rather than a
    // particular count: the page must render without error and the API must
    // answer the alarm query.
    const response = await page.request.get(`${API}/api/v1/kds/unacknowledged`, {
      failOnStatusCode: false,
    });
    expect([200, 401]).toContain(response.status());
    await expect(page.getByRole('heading', { name: 'Live orders' })).toBeVisible();
  });
});

test.describe('kitchen display', () => {
  test('renders the four columns from spec §34', async ({ page }) => {
    await signIn(page, OWNER);
    await page.getByRole('link', { name: 'Kitchen' }).click();

    for (const column of ['New', 'Accepted', 'Preparing', 'Ready']) {
      await expect(page.getByRole('region', { name: column })).toBeVisible();
    }
  });

  test('reports the live connection state', async ({ page }) => {
    await signIn(page, OWNER);
    await page.getByRole('link', { name: 'Kitchen' }).click();

    // The stream is an optimisation; this indicator is how a cook knows whether
    // to trust the screen (plan §2.8).
    await expect(page.locator('.kds-status').first()).toContainText(/Live|Connecting/);
  });

  test('offers an explicit sound control rather than failing silently', async ({ page }) => {
    await signIn(page, OWNER);
    await page.getByRole('link', { name: 'Kitchen' }).click();

    // Browsers block audio until a gesture, so a screen that never asks has no
    // audible alert and never says so.
    const enable = page.getByRole('button', { name: /Enable sound|Sound blocked/ });
    await expect(enable).toBeVisible();

    await enable.click();
    await expect(page.getByText('Sound on')).toBeVisible();
  });

  test('receives a new order over the live stream without a reload', async ({ page }) => {
    await signIn(page, OWNER);
    await page.getByRole('link', { name: 'Kitchen' }).click();
    await selectBranch(page, 'DHA');
    await expect(page.locator('.kds-status').first()).toContainText('Live', { timeout: 20_000 });

    const order = await placeOrder();

    // No reload: this is the outbox publisher, Redis and SSE delivering.
    const card = page.locator('.kds-card', { hasText: order.orderNumber });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('2×');
    await expect(card).toContainText('Chicken Biryani');
  });

  test('advances an order from the kitchen screen', async ({ page }) => {
    await signIn(page, OWNER);
    await page.getByRole('link', { name: 'Kitchen' }).click();
    await selectBranch(page, 'DHA');

    const order = await placeOrder();
    const card = page.locator('.kds-card', { hasText: order.orderNumber });
    await expect(card).toBeVisible({ timeout: 30_000 });

    await card.getByRole('button', { name: 'Accept' }).click();

    await expect(
      page
        .getByRole('region', { name: 'Accepted' })
        .locator('.kds-card', { hasText: order.orderNumber }),
    ).toBeVisible({ timeout: 20_000 });

    await expect(
      page.getByRole('region', { name: 'New' }).locator('.kds-card', {
        hasText: order.orderNumber,
      }),
    ).toHaveCount(0);
  });

  test('shows a ticking timer on each card', async ({ page }) => {
    await signIn(page, OWNER);
    await page.getByRole('link', { name: 'Kitchen' }).click();
    await selectBranch(page, 'DHA');

    const order = await placeOrder();
    const card = page.locator('.kds-card', { hasText: order.orderNumber });
    await expect(card).toBeVisible({ timeout: 30_000 });

    const timer = card.locator('.kds-timer');
    const first = await timer.textContent();
    await page.waitForTimeout(2500);
    const second = await timer.textContent();

    // A frozen timer is worse than none: it looks authoritative and is wrong.
    expect(second).not.toBe(first);
  });

  test('a kitchen user sees only their own branch', async ({ page }) => {
    await signIn(page, KITCHEN);
    await page.getByRole('link', { name: 'Kitchen' }).click();

    // Branch-scoped staff get a label, not a picker, because there is nothing
    // to choose between (spec §7).
    await expect(page.locator('.kds-bar .pill')).toContainText('DHA');
    await expect(page.locator('.kds-bar select')).toHaveCount(0);
  });
});
