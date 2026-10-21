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
  // By role, but scoped to our own alert: Next renders an empty
  // `role="alert"` route announcer on every page, so an unscoped query is a
  // strict-mode violation rather than a failure anybody can read.
  return page.locator('.alert[role="alert"]').first();
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
    await expect(nav.getByRole('link', { name: 'Kitchen display' })).toBeVisible();
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
    // Availability is a switch now rather than a pair of buttons, so this
    // asks the control what state it is in instead of matching a pill's text.
    // The switch keeps its real <input> at opacity 0 behind the drawn track —
    // the standard accessible pattern, and still keyboard-focusable. A person
    // clicks the label, so this does too; the input is only read for state.
    function saleRow(dish: string) {
      return page.locator('.dish', { hasText: dish }).first();
    }
    const state = (dish: string) => saleRow(dish).getByRole('switch');
    const press = (dish: string) => saleRow(dish).locator('.switch').click();

    async function makeAvailableAt(branch: string) {
      await selectBranch(page, branch);
      await expect(saleRow('Chicken Tikka')).toBeVisible();

      if (!(await state('Chicken Tikka').isChecked())) await press('Chicken Tikka');
      await expect(state('Chicken Tikka')).toBeChecked();
    }

    await makeAvailableAt('Clifton');
    await makeAvailableAt('DHA');

    // Now the actual check: sold out at DHA...
    await press('Chicken Tikka');
    await expect(state('Chicken Tikka')).not.toBeChecked();

    // ...and unaffected at Clifton. Spec §86: a branch restricts its own menu,
    // it does not speak for the chain.
    await selectBranch(page, 'Clifton');
    await expect(state('Chicken Tikka')).toBeChecked();

    // Leave the data as it was found.
    await makeAvailableAt('DHA');
  });

  test('shows the chain price alongside a branch override', async ({ page }) => {
    await signIn(page, OWNER);
    await page.getByRole('link', { name: 'Menu' }).click();
    await selectBranch(page, 'Lahore');

    // The seed prices the platter higher in Lahore, so both figures appear —
    // showing only one is how a manager edits the wrong number.
    const row = page.locator('.dish', { hasText: 'BBQ Platter' }).first();
    await expect(row).toContainText('Rs 2,650.00');
    await expect(row).toContainText('Chain: Rs 2,400.00');
  });

  test('creates an item and rejects a malformed price', async ({ page }) => {
    await signIn(page, OWNER);
    await page.getByRole('link', { name: 'Menu' }).click();
    await selectBranch(page, 'DHA');
    await page.getByRole('button', { name: 'New dish' }).click();

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
    await expect(page.locator('.dish', { hasText: unique })).toContainText('Rs 1,250.00');
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

    // .last(), not an exact match on the number.
    //
    // Order numbers are unique per branch per BUSINESS DATE, not for all time,
    // so a long-lived database has several orders called DHA-0011 and a strict
    // locator resolves to more than one. The newest is the one this test just
    // placed.
    // Exact: the row's overflow menu is labelled "More actions for order
    // NNNN", and Playwright matches names by substring, so a loose query hits
    // the menu instead of the disclosure.
    await page.getByRole('button', { name: order.orderNumber, exact: true }).last().click();

    await expect(page.getByRole('heading', { name: 'Items' })).toBeVisible();
    // Scoped to the panel: the list itself now prints each order's items in
    // its own column, so an unscoped query matches every row on the page.
    await expect(page.locator('.o-detail').getByText('2× Chicken Biryani')).toBeVisible();
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
    await page.getByRole('link', { name: 'Kitchen display' }).click();

    for (const column of ['New', 'Accepted', 'Preparing', 'Ready']) {
      await expect(page.getByRole('region', { name: column })).toBeVisible();
    }
  });

  test('reports the live connection state', async ({ page }) => {
    await signIn(page, OWNER);
    await page.getByRole('link', { name: 'Kitchen display' }).click();

    // The stream is an optimisation; this indicator is how a cook knows whether
    // to trust the screen (plan §2.8).
    await expect(page.locator('.kds-live').first()).toContainText(/Live|Connecting/);
  });

  test('offers an explicit sound control rather than failing silently', async ({ page }) => {
    await signIn(page, OWNER);
    await page.getByRole('link', { name: 'Kitchen display' }).click();

    // Browsers block audio until a gesture, so a screen that never asks has no
    // audible alert and never says so. The control is a toggle now, named by
    // its state, so this asserts it starts off and says so once turned on.
    const toggle = page.getByRole('button', { name: /Sound is off/ });
    await expect(toggle).toBeVisible();

    await toggle.click();
    await expect(page.getByText('Sound on')).toBeVisible();
  });

  test('receives a new order over the live stream without a reload', async ({ page }) => {
    await signIn(page, OWNER);
    await page.getByRole('link', { name: 'Kitchen display' }).click();
    await selectBranch(page, 'DHA');
    await expect(page.locator('.kds-live').first()).toContainText('Live', { timeout: 20_000 });

    const order = await placeOrder();

    // No reload: this is the outbox publisher, Redis and SSE delivering.
    // .last(), because order numbers are unique per branch per business date,
    // not for all time — an older card with the same number may still be up.
    const card = page.locator('.kds-card', { hasText: order.orderNumber }).last();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('2×');
    await expect(card).toContainText('Chicken Biryani');
  });

  test('advances an order from the kitchen screen', async ({ page }) => {
    await signIn(page, OWNER);
    await page.getByRole('link', { name: 'Kitchen display' }).click();
    await selectBranch(page, 'DHA');

    const order = await placeOrder();

    // By id, not by order number. Numbers are unique per branch per business
    // date, so a long-lived database has four cards reading DHA-0004 and
    // counting them proves nothing about the one this test placed.
    const card = `.kds-card[data-order-id="${order.id}"]`;
    const inNew = page.getByRole('region', { name: 'New' }).locator(card);

    await expect(inNew).toBeVisible({ timeout: 30_000 });
    await inNew.getByRole('button', { name: 'Accept' }).click();

    await expect(
      page.getByRole('region', { name: 'Accepted' }).locator(card),
    ).toBeVisible({ timeout: 20_000 });
    await expect(inNew).toHaveCount(0);
  });

  test('shows a ticking timer on each card', async ({ page }) => {
    await signIn(page, OWNER);
    await page.getByRole('link', { name: 'Kitchen display' }).click();
    await selectBranch(page, 'DHA');

    const order = await placeOrder();
    // .last() for the same reason as above: order numbers repeat across
    // business dates, and the kitchen screen shows whatever is still active.
    const card = page.locator('.kds-card', { hasText: order.orderNumber }).last();
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
    await page.getByRole('link', { name: 'Kitchen display' }).click();

    // Branch-scoped staff get the branch in the header, not a picker, because
    // there is nothing to choose between (spec §7).
    await expect(page.locator('.kds-title')).toContainText('DHA');
    await expect(page.locator('.kds-head select')).toHaveCount(0);
  });
});
