import { MenuItemAvailability, SystemRole } from '@restaurant-os/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeaders,
  cleanupTenants,
  createTenant,
  createTestContext,
  ensureReferenceData,
  login,
  type TestContext,
  type TestTenant,
} from './helpers/test-context';

/**
 * Menu management (ENGINEERING_SPEC.md 10, 60, 86).
 *
 * The branch-override cases carry most of the weight. Spec v1 has one global
 * price and one global availability flag; a chain prices by city and runs out
 * of stock one branch at a time, so the resolution rules — and the rule that a
 * branch may restrict but never loosen — are what these tests pin down.
 */
describe('menu', () => {
  let context: TestContext;
  let tenant: TestTenant;
  let other: TestTenant;
  const created: TestTenant[] = [];

  let ownerToken: string;
  let dhaBranchId: string;
  let cliftonBranchId: string;

  beforeAll(async () => {
    context = await createTestContext();
    await ensureReferenceData(context.admin);

    tenant = await createTenant(context.admin, {
      slug: 'menu-chain',
      branchSlugs: ['dha', 'clifton'],
      users: [
        { key: 'owner', role: SystemRole.OWNER },
        { key: 'manager', role: SystemRole.BRANCH_MANAGER, branches: [0] },
        { key: 'cashier', role: SystemRole.CASHIER, branches: [0] },
        { key: 'kitchen', role: SystemRole.KITCHEN_STAFF, branches: [0] },
      ],
    });

    other = await createTenant(context.admin, {
      slug: 'menu-rival',
      branchSlugs: ['main'],
      users: [{ key: 'owner', role: SystemRole.OWNER }],
    });

    created.push(tenant, other);

    ownerToken = await login(context.app, tenant.users.owner!.email);
    dhaBranchId = tenant.branchIds[0]!;
    cliftonBranchId = tenant.branchIds[1]!;
  });

  afterAll(async () => {
    await cleanupTenants(context.admin, created);
    await context.close();
  });

  async function post(url: string, payload: Record<string, unknown>, token = ownerToken) {
    return context.app.inject({ method: 'POST', url, headers: authHeaders(token), payload });
  }
  async function patch(url: string, payload: Record<string, unknown>, token = ownerToken) {
    return context.app.inject({ method: 'PATCH', url, headers: authHeaders(token), payload });
  }
  async function put(url: string, payload: Record<string, unknown>, token = ownerToken) {
    return context.app.inject({ method: 'PUT', url, headers: authHeaders(token), payload });
  }
  async function get(url: string, token = ownerToken) {
    return context.app.inject({ method: 'GET', url, headers: authHeaders(token) });
  }
  async function del(url: string, token = ownerToken) {
    return context.app.inject({ method: 'DELETE', url, headers: authHeaders(token) });
  }

  /** Creates a category and an item, returning both ids. */
  async function seedItem(name: string, price: string) {
    const category = await post('/api/v1/menu/categories', { name: `${name} category` });
    const categoryId = category.json().data.id as string;

    const item = await post('/api/v1/menu/items', {
      name,
      basePrice: price,
      categoryId,
    });
    return { categoryId, itemId: item.json().data.id as string };
  }

  describe('categories and items', () => {
    it('creates a category and an item, and returns them in the menu', async () => {
      const { categoryId, itemId } = await seedItem('Chicken Burger', '700.00');

      const menu = await get('/api/v1/menu');
      expect(menu.statusCode).toBe(200);

      const category = menu
        .json()
        .data.categories.find((entry: { id: string }) => entry.id === categoryId);

      expect(category).toBeTruthy();
      const item = category.items.find((entry: { id: string }) => entry.id === itemId);
      expect(item.name).toBe('Chicken Burger');
      expect(item.price).toBe('700.00');
      expect(item.availability).toBe(MenuItemAvailability.AVAILABLE);
    });

    it('takes currency from the organization, not the request body', async () => {
      const response = await post('/api/v1/menu/items', {
        name: 'Currency test',
        basePrice: '100.00',
        currency: 'USD',
      });

      expect(response.statusCode).toBe(201);
      // Zod strips the unknown key and the service reads the organization's
      // currency, so a client cannot price an item in another currency.
      expect(response.json().data.currency).toBe('PKR');
    });

    it('rejects a price that is not a plain decimal string', async () => {
      for (const basePrice of ['1,250.00', 'Rs 700', '700.123', '']) {
        const response = await post('/api/v1/menu/items', { name: 'Bad price', basePrice });
        expect(response.statusCode, basePrice).toBe(422);
        expect(response.json().error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('rejects a category from another tenant', async () => {
      const rivalToken = await login(context.app, other.users.owner!.email);
      const rivalCategory = await post('/api/v1/menu/categories', { name: 'Rival' }, rivalToken);
      const rivalCategoryId = rivalCategory.json().data.id as string;

      const response = await post('/api/v1/menu/items', {
        name: 'Cross tenant',
        basePrice: '100.00',
        categoryId: rivalCategoryId,
      });

      // RLS makes the foreign category invisible, so it reads as missing.
      expect(response.statusCode).toBe(404);
    });

    it('archives an item instead of deleting it', async () => {
      const { itemId } = await seedItem('To be archived', '250.00');

      const response = await del(`/api/v1/menu/items/${itemId}`);
      expect(response.statusCode).toBe(200);

      // The row survives, so historical orders stay resolvable (spec 13).
      const row = await context.admin.menuItem.findUnique({ where: { id: itemId } });
      expect(row).toBeTruthy();
      expect(row!.isActive).toBe(false);

      const menu = await get('/api/v1/menu');
      const allItems = menu
        .json()
        .data.categories.flatMap((category: { items: Array<{ id: string }> }) => category.items);
      expect(allItems.some((item: { id: string }) => item.id === itemId)).toBe(false);
    });

    it('keeps items when their category is archived', async () => {
      const { categoryId, itemId } = await seedItem('Orphan candidate', '300.00');

      await del(`/api/v1/menu/categories/${categoryId}`);

      const menu = await get('/api/v1/menu?includeHidden=true');
      const stillThere = menu
        .json()
        .data.categories.flatMap((category: { items: Array<{ id: string }> }) => category.items)
        .some((item: { id: string }) => item.id === itemId);

      expect(stillThere).toBe(true);
    });
  });

  describe('branch price and availability (spec 86)', () => {
    it('prices an item differently at one branch', async () => {
      const { itemId } = await seedItem('Biryani', '450.00');

      const response = await put(`/api/v1/menu/items/${itemId}/branches/${cliftonBranchId}`, {
        price: '520.00',
      });
      expect(response.statusCode).toBe(200);

      const dha = await get(`/api/v1/menu/items/${itemId}?branchId=${dhaBranchId}`);
      const clifton = await get(`/api/v1/menu/items/${itemId}?branchId=${cliftonBranchId}`);

      expect(dha.json().data.price).toBe('450.00');
      expect(clifton.json().data.price).toBe('520.00');
      // The tenant-wide figure is still reported for management screens.
      expect(clifton.json().data.basePrice).toBe('450.00');
      expect(clifton.json().data.hasBranchOverride).toBe(true);
    });

    it('marks an item sold out at one branch only', async () => {
      const { itemId } = await seedItem('Karahi', '1200.00');

      const response = await post(`/api/v1/menu/items/${itemId}/availability`, {
        availability: MenuItemAvailability.OUT_OF_STOCK,
        branchId: dhaBranchId,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.scope).toBe('BRANCH');

      const dha = await get(`/api/v1/menu/items/${itemId}?branchId=${dhaBranchId}`);
      const clifton = await get(`/api/v1/menu/items/${itemId}?branchId=${cliftonBranchId}`);

      expect(dha.json().data.availability).toBe(MenuItemAvailability.OUT_OF_STOCK);
      expect(clifton.json().data.availability).toBe(MenuItemAvailability.AVAILABLE);
      // Sold out is still listed — the customer sees it greyed out, not gone.
      expect(dha.json().data.isVisible).toBe(true);
    });

    it('does not let a branch re-enable a centrally hidden item', async () => {
      const { itemId } = await seedItem('Discontinued', '199.00');

      await post(`/api/v1/menu/items/${itemId}/availability`, {
        availability: MenuItemAvailability.HIDDEN,
      });
      await post(`/api/v1/menu/items/${itemId}/availability`, {
        availability: MenuItemAvailability.AVAILABLE,
        branchId: dhaBranchId,
      });

      const dha = await get(`/api/v1/menu/items/${itemId}?branchId=${dhaBranchId}`);
      // The safety property: an item withdrawn chain-wide stays withdrawn.
      expect(dha.json().data.availability).toBe(MenuItemAvailability.HIDDEN);
      expect(dha.json().data.isVisible).toBe(false);
    });

    it('clears an override back to the inherited values', async () => {
      const { itemId } = await seedItem('Reverting', '800.00');

      await put(`/api/v1/menu/items/${itemId}/branches/${dhaBranchId}`, { price: '999.00' });
      let dha = await get(`/api/v1/menu/items/${itemId}?branchId=${dhaBranchId}`);
      expect(dha.json().data.price).toBe('999.00');

      const cleared = await del(`/api/v1/menu/items/${itemId}/branches/${dhaBranchId}`);
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().data.cleared).toBe(true);

      dha = await get(`/api/v1/menu/items/${itemId}?branchId=${dhaBranchId}`);
      expect(dha.json().data.price).toBe('800.00');
      expect(dha.json().data.hasBranchOverride).toBe(false);
    });

    it('refuses a branch the caller has no access to', async () => {
      const { itemId } = await seedItem('Scoped', '100.00');
      const managerToken = await login(context.app, tenant.users.manager!.email);

      const ownBranch = await context.app.inject({
        method: 'POST',
        url: `/api/v1/menu/items/${itemId}/availability`,
        headers: authHeaders(managerToken),
        payload: { availability: MenuItemAvailability.OUT_OF_STOCK, branchId: dhaBranchId },
      });
      expect(ownBranch.statusCode).toBe(200);

      const siblingBranch = await context.app.inject({
        method: 'POST',
        url: `/api/v1/menu/items/${itemId}/availability`,
        headers: authHeaders(managerToken),
        payload: { availability: MenuItemAvailability.OUT_OF_STOCK, branchId: cliftonBranchId },
      });
      expect(siblingBranch.statusCode).toBe(403);
      expect(siblingBranch.json().error.code).toBe('BRANCH_ACCESS_DENIED');
    });

    it('refuses a branch belonging to another tenant', async () => {
      const { itemId } = await seedItem('Foreign branch', '100.00');

      const response = await post(`/api/v1/menu/items/${itemId}/availability`, {
        availability: MenuItemAvailability.OUT_OF_STOCK,
        branchId: other.branchIds[0],
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('modifiers', () => {
    it('creates a group with options and attaches it to an item', async () => {
      const { itemId } = await seedItem('Zinger', '650.00');

      const modifier = await post('/api/v1/menu/modifiers', {
        name: 'Choose your sauce',
        selectionType: 'SINGLE',
        required: true,
        options: [
          { name: 'Garlic', priceDelta: '0.00' },
          { name: 'Chilli', priceDelta: '50.00' },
        ],
      });
      expect(modifier.statusCode).toBe(201);
      const modifierId = modifier.json().data.id as string;

      const attach = await put(`/api/v1/menu/items/${itemId}/modifiers`, {
        modifierIds: [modifierId],
      });
      expect(attach.statusCode).toBe(200);

      const item = await get(`/api/v1/menu/items/${itemId}`);
      const groups = item.json().data.modifiers;
      expect(groups).toHaveLength(1);
      expect(groups[0].name).toBe('Choose your sauce');
      expect(groups[0].required).toBe(true);
      expect(groups[0].options.map((option: { name: string }) => option.name).sort()).toEqual([
        'Chilli',
        'Garlic',
      ]);
    });

    it('rejects a self-contradictory group', async () => {
      // SINGLE selection with room for three choices would make every possible
      // selection invalid at order time.
      const response = await post('/api/v1/menu/modifiers', {
        name: 'Contradictory',
        selectionType: 'SINGLE',
        maxSelections: 3,
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a contradiction introduced by a partial update', async () => {
      const created = await post('/api/v1/menu/modifiers', {
        name: 'Toppings',
        selectionType: 'MULTIPLE',
        maxSelections: 4,
      });
      const modifierId = created.json().data.id as string;

      // Only selectionType changes, but the stored maxSelections of 4 now
      // conflicts with it — checked against the merged result, not the patch.
      const response = await patch(`/api/v1/menu/modifiers/${modifierId}`, {
        selectionType: 'SINGLE',
      });

      expect(response.statusCode).toBe(422);
    });

    it('refuses to attach a modifier from another tenant', async () => {
      const { itemId } = await seedItem('Attach test', '100.00');
      const rivalToken = await login(context.app, other.users.owner!.email);

      const rivalModifier = await post(
        '/api/v1/menu/modifiers',
        { name: 'Rival sauce', options: [{ name: 'X' }] },
        rivalToken,
      );
      const rivalModifierId = rivalModifier.json().data.id as string;

      const response = await put(`/api/v1/menu/items/${itemId}/modifiers`, {
        modifierIds: [rivalModifierId],
      });

      expect(response.statusCode).toBe(404);
    });

    it('replaces the whole set when attaching', async () => {
      const { itemId } = await seedItem('Replace test', '100.00');

      const first = await post('/api/v1/menu/modifiers', { name: 'First group' });
      const second = await post('/api/v1/menu/modifiers', { name: 'Second group' });

      await put(`/api/v1/menu/items/${itemId}/modifiers`, {
        modifierIds: [first.json().data.id],
      });
      await put(`/api/v1/menu/items/${itemId}/modifiers`, {
        modifierIds: [second.json().data.id],
      });

      const item = await get(`/api/v1/menu/items/${itemId}`);
      expect(item.json().data.modifiers).toHaveLength(1);
      expect(item.json().data.modifiers[0].id).toBe(second.json().data.id);
    });
  });

  describe('variants', () => {
    it('adds variants and keeps only one default', async () => {
      const { itemId } = await seedItem('Pizza', '900.00');

      await post(`/api/v1/menu/items/${itemId}/variants`, {
        name: 'Small',
        price: '900.00',
        isDefault: true,
      });
      await post(`/api/v1/menu/items/${itemId}/variants`, {
        name: 'Large',
        price: '1500.00',
        isDefault: true,
      });

      const item = await get(`/api/v1/menu/items/${itemId}`);
      const variants = item.json().data.variants;
      expect(variants).toHaveLength(2);
      // Setting a new default must clear the previous one.
      expect(variants.filter((variant: { isDefault: boolean }) => variant.isDefault)).toHaveLength(
        1,
      );
    });

    it('rejects a duplicate variant name on the same item', async () => {
      const { itemId } = await seedItem('Duplicate variants', '100.00');

      await post(`/api/v1/menu/items/${itemId}/variants`, { name: 'Regular', price: '100.00' });
      const response = await post(`/api/v1/menu/items/${itemId}/variants`, {
        name: 'Regular',
        price: '120.00',
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('CONFLICT');
    });
  });

  describe('audit and events', () => {
    it('records a price change as PRICE_CHANGE, not a plain update', async () => {
      const { itemId } = await seedItem('Priced', '500.00');

      await patch(`/api/v1/menu/items/${itemId}`, { basePrice: '550.00' });

      const entries = await context.admin.auditLog.findMany({
        where: { entityType: 'MenuItem', entityId: itemId, action: 'PRICE_CHANGE' },
      });

      expect(entries).toHaveLength(1);
      expect((entries[0]!.oldValues as { basePrice: string }).basePrice).toBe('500.00');
      expect((entries[0]!.newValues as { basePrice: string }).basePrice).toBe('550.00');
    });

    it('records a rename as a plain update', async () => {
      const { itemId } = await seedItem('Renamed', '500.00');

      await patch(`/api/v1/menu/items/${itemId}`, { name: 'Renamed twice' });

      const priceChanges = await context.admin.auditLog.findMany({
        where: { entityType: 'MenuItem', entityId: itemId, action: 'PRICE_CHANGE' },
      });
      expect(priceChanges).toHaveLength(0);
    });

    it('writes an outbox event when availability changes', async () => {
      const { itemId } = await seedItem('Eventful', '400.00');

      await post(`/api/v1/menu/items/${itemId}/availability`, {
        availability: MenuItemAvailability.OUT_OF_STOCK,
      });

      const events = await context.admin.outboxEvent.findMany({
        where: { aggregateId: itemId, eventType: 'MenuItemAvailabilityChanged' },
      });

      expect(events).toHaveLength(1);
      const payload = events[0]!.payload as {
        menuItemId: string;
        branchId: string | null;
        availability: string;
      };
      expect(payload.menuItemId).toBe(itemId);
      // null means the change applies to every branch.
      expect(payload.branchId).toBeNull();
      expect(payload.availability).toBe('OUT_OF_STOCK');
      expect(events[0]!.status).toBe('PENDING');
      expect(events[0]!.tenantId).toBe(tenant.organizationId);
    });

    it('writes the event atomically with the change it describes', async () => {
      const { itemId } = await seedItem('Atomic', '400.00');

      await post(`/api/v1/menu/items/${itemId}/availability`, {
        availability: MenuItemAvailability.HIDDEN,
        branchId: dhaBranchId,
      });

      const [item, events] = await Promise.all([
        context.admin.menuItem.findUnique({ where: { id: itemId } }),
        context.admin.outboxEvent.findMany({ where: { aggregateId: itemId } }),
      ]);

      // The tenant-wide value is untouched; the event reports what the branch
      // will actually show.
      expect(item!.availability).toBe(MenuItemAvailability.AVAILABLE);
      expect(events).toHaveLength(1);
      expect((events[0]!.payload as { branchId: string }).branchId).toBe(dhaBranchId);
      expect((events[0]!.payload as { availability: string }).availability).toBe('HIDDEN');
    });
  });

  describe('permissions and isolation', () => {
    it('lets kitchen staff read the menu but not change it', async () => {
      const kitchenToken = await login(context.app, tenant.users.kitchen!.email);

      const read = await get('/api/v1/menu', kitchenToken);
      expect(read.statusCode).toBe(200);

      const write = await post(
        '/api/v1/menu/items',
        { name: 'Unauthorised', basePrice: '100.00' },
        kitchenToken,
      );
      expect(write.statusCode).toBe(403);
      expect(write.json().error.code).toBe('PERMISSION_DENIED');
    });

    it('lets a branch manager mark items sold out but not create or delete them', async () => {
      const { itemId } = await seedItem('Manager scope', '100.00');
      const managerToken = await login(context.app, tenant.users.manager!.email);

      const soldOut = await context.app.inject({
        method: 'POST',
        url: `/api/v1/menu/items/${itemId}/availability`,
        headers: authHeaders(managerToken),
        payload: { availability: MenuItemAvailability.OUT_OF_STOCK, branchId: dhaBranchId },
      });
      expect(soldOut.statusCode).toBe(200);

      const create = await post(
        '/api/v1/menu/items',
        { name: 'Nope', basePrice: '1.00' },
        managerToken,
      );
      expect(create.statusCode).toBe(403);

      const remove = await del(`/api/v1/menu/items/${itemId}`, managerToken);
      expect(remove.statusCode).toBe(403);
    });

    it('never shows one tenant another tenant\'s menu', async () => {
      await seedItem('Secret recipe', '999.00');
      const rivalToken = await login(context.app, other.users.owner!.email);

      const rivalMenu = await get('/api/v1/menu', rivalToken);
      const names = rivalMenu
        .json()
        .data.categories.flatMap((category: { items: Array<{ name: string }> }) => category.items)
        .map((item: { name: string }) => item.name);

      expect(names).not.toContain('Secret recipe');
    });

    it('hides another tenant\'s item behind a 404 even with its real id', async () => {
      const { itemId } = await seedItem('Target', '100.00');
      const rivalToken = await login(context.app, other.users.owner!.email);

      const read = await get(`/api/v1/menu/items/${itemId}`, rivalToken);
      expect(read.statusCode).toBe(404);

      const write = await patch(`/api/v1/menu/items/${itemId}`, { basePrice: '1.00' }, rivalToken);
      expect(write.statusCode).toBe(404);

      const unchanged = await context.admin.menuItem.findUniqueOrThrow({ where: { id: itemId } });
      expect(unchanged.basePrice.toString()).toBe('100');
    });
  });
});
