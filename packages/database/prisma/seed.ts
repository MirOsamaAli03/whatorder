/**
 * Seeds reference data and two demo tenants.
 *
 * Reference data (permissions, the eight system roles and their grants) is
 * idempotent and belongs in every environment. The demo tenants are for
 * development only and are refused in production.
 *
 * Two demo tenants on purpose: a multi-branch chain and a single-branch home
 * kitchen. ENGINEERING_SPEC.md 75 requires the same application to serve both,
 * so both stay exercised from the first sprint rather than the chain shape
 * quietly becoming the only one that works.
 *
 * Runs as the schema owner, which is exempt from RLS — that is what allows it
 * to write rows for several tenants in one pass.
 */
import { PrismaClient } from '@prisma/client';
import { ROLE_PERMISSIONS } from '@restaurant-os/domain';
import {
  ALL_PERMISSIONS,
  BranchStatus,
  Language,
  MembershipStatus,
  OrganizationStatus,
  OrganizationType,
  SystemRole,
  UserStatus,
} from '@restaurant-os/types';
import * as argon2 from 'argon2';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(resolve(process.cwd(), '../../.env'));

const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) {
  console.error('DATABASE_URL_ADMIN is required to seed (the seed writes across tenants).');
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: adminUrl } } });

/** Demo password. Overridable, and never used outside development. */
const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'RestaurantOS123!';

function permissionCategory(key: string): string {
  return key.split('.')[0] ?? 'general';
}

async function seedPermissions(): Promise<Map<string, string>> {
  const byKey = new Map<string, string>();

  for (const key of ALL_PERMISSIONS) {
    const permission = await prisma.permission.upsert({
      where: { key },
      update: { category: permissionCategory(key) },
      create: { key, category: permissionCategory(key), description: null },
    });
    byKey.set(key, permission.id);
  }

  console.log(`  permissions: ${byKey.size}`);
  return byKey;
}

async function seedSystemRoles(permissionIds: Map<string, string>): Promise<Map<string, string>> {
  const byName = new Map<string, string>();

  for (const [roleName, permissions] of Object.entries(ROLE_PERMISSIONS)) {
    // Compound unique lookups on a nullable column are awkward in Prisma, and
    // the partial index roles_system_name_unique is what actually guarantees
    // uniqueness here, so find-then-write rather than upsert.
    const existing = await prisma.role.findFirst({ where: { tenantId: null, name: roleName } });

    const role =
      existing ??
      (await prisma.role.create({
        data: {
          tenantId: null,
          name: roleName,
          isSystem: true,
          description: `System role: ${roleName}`,
        },
      }));

    // Rewrite the grants each run so a change to ROLE_PERMISSIONS in code
    // reaches the database on the next seed.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: permissions
        .map((key) => permissionIds.get(key))
        .filter((id): id is string => Boolean(id))
        .map((permissionId) => ({ tenantId: null, roleId: role.id, permissionId })),
    });

    byName.set(roleName, role.id);
  }

  console.log(`  system roles: ${byName.size}`);
  return byName;
}

interface DemoStaff {
  email: string;
  name: string;
  role: string;
  /** Branch slugs this member is confined to; omitted for org-wide roles. */
  branchSlugs?: string[];
}

async function seedTenant(
  input: {
    name: string;
    slug: string;
    type: OrganizationType;
    branches: Array<{ name: string; slug: string; city: string; dineIn?: boolean }>;
    staff: DemoStaff[];
  },
  roleIds: Map<string, string>,
  passwordHash: string,
): Promise<void> {
  const organization = await prisma.organization.upsert({
    where: { slug: input.slug },
    update: {},
    create: {
      name: input.name,
      slug: input.slug,
      type: input.type,
      status: OrganizationStatus.ACTIVE,
      currency: 'PKR',
      timezone: 'Asia/Karachi',
      defaultLanguage: Language.EN,
      // Kitchens serving past midnight report those orders against the
      // previous business day (plan 2.6).
      businessDayStartMinutes: 240,
      settings: {
        taxPercent: 15,
        deliveryFee: '150.00',
        minimumOrder: '500.00',
        orderAcknowledgementTimeoutSeconds: 60,
      },
    },
  });

  const branchIdBySlug = new Map<string, string>();
  for (const branch of input.branches) {
    const row = await prisma.branch.upsert({
      where: { tenantId_slug: { tenantId: organization.id, slug: branch.slug } },
      update: {},
      create: {
        tenantId: organization.id,
        name: branch.name,
        slug: branch.slug,
        city: branch.city,
        status: BranchStatus.ACTIVE,
        deliveryEnabled: true,
        pickupEnabled: true,
        dineInEnabled: branch.dineIn ?? false,
        reservationsEnabled: branch.dineIn ?? false,
        openingHours: {
          mon: [{ open: '11:00', close: '23:59' }],
          tue: [{ open: '11:00', close: '23:59' }],
          wed: [{ open: '11:00', close: '23:59' }],
          thu: [{ open: '11:00', close: '23:59' }],
          fri: [{ open: '11:00', close: '23:59' }],
          sat: [{ open: '11:00', close: '23:59' }],
          sun: [{ open: '11:00', close: '23:59' }],
        },
      },
    });
    branchIdBySlug.set(branch.slug, row.id);
  }

  for (const member of input.staff) {
    const user = await prisma.user.upsert({
      where: { email: member.email },
      update: {},
      create: {
        email: member.email,
        name: member.name,
        passwordHash,
        status: UserStatus.ACTIVE,
      },
    });

    const membership = await prisma.membership.upsert({
      where: { userId_tenantId: { userId: user.id, tenantId: organization.id } },
      update: { status: MembershipStatus.ACTIVE },
      create: {
        userId: user.id,
        tenantId: organization.id,
        status: MembershipStatus.ACTIVE,
      },
    });

    const roleId = roleIds.get(member.role);
    if (roleId) {
      await prisma.membershipRole.upsert({
        where: { membershipId_roleId: { membershipId: membership.id, roleId } },
        update: {},
        create: { tenantId: organization.id, membershipId: membership.id, roleId },
      });
    }

    await prisma.membershipBranch.deleteMany({ where: { membershipId: membership.id } });
    for (const slug of member.branchSlugs ?? []) {
      const branchId = branchIdBySlug.get(slug);
      if (!branchId) continue;
      await prisma.membershipBranch.create({
        data: { tenantId: organization.id, membershipId: membership.id, branchId },
      });
    }
  }

  console.log(
    `  ${input.name}: ${input.branches.length} branch(es), ${input.staff.length} staff member(s)`,
  );
}


interface DemoOption {
  name: string;
  priceDelta?: string;
}

interface DemoModifier {
  name: string;
  selectionType: 'SINGLE' | 'MULTIPLE';
  required?: boolean;
  minSelections?: number;
  maxSelections?: number;
  options: DemoOption[];
}

interface DemoItem {
  name: string;
  nameUrdu?: string;
  basePrice: string;
  costPrice?: string;
  description?: string;
  preparationTimeMinutes?: number;
  availability?: 'AVAILABLE' | 'OUT_OF_STOCK' | 'HIDDEN';
  variants?: Array<{ name: string; price: string; isDefault?: boolean }>;
  modifiers?: string[];
}

interface DemoCategory {
  name: string;
  nameUrdu?: string;
  items: DemoItem[];
}

/**
 * Seeds a menu for a tenant.
 *
 * Deliberately not a flat list of items: it exercises variants, shared modifier
 * groups, the item-to-modifier join table and per-branch overrides, so that the
 * parts of the schema that spec v1 omitted are covered by real data rather than
 * only by tests.
 */
async function seedMenu(
  organizationSlug: string,
  modifierDefinitions: DemoModifier[],
  categories: DemoCategory[],
  branchOverrides: Array<{ branchSlug: string; itemName: string; price?: string; availability?: 'AVAILABLE' | 'OUT_OF_STOCK' | 'HIDDEN' }> = [],
): Promise<void> {
  const organization = await prisma.organization.findUnique({ where: { slug: organizationSlug } });
  if (!organization) return;

  const tenantId = organization.id;

  const modifierIdByName = new Map<string, string>();
  for (const definition of modifierDefinitions) {
    let modifier = await prisma.modifier.findFirst({
      where: { tenantId, name: definition.name },
    });

    if (!modifier) {
      modifier = await prisma.modifier.create({
        data: {
          tenantId,
          name: definition.name,
          selectionType: definition.selectionType,
          required: definition.required ?? false,
          minSelections: definition.minSelections ?? 0,
          maxSelections:
            definition.maxSelections ?? (definition.selectionType === 'SINGLE' ? 1 : 5),
          options: {
            create: definition.options.map((option, index) => ({
              tenantId,
              name: option.name,
              priceDelta: option.priceDelta ?? '0.00',
              sortOrder: index,
            })),
          },
        },
      });
    }
    modifierIdByName.set(definition.name, modifier.id);
  }

  const itemIdByName = new Map<string, string>();

  for (const [categoryIndex, categoryDefinition] of categories.entries()) {
    let category = await prisma.menuCategory.findFirst({
      where: { tenantId, name: categoryDefinition.name },
    });

    if (!category) {
      category = await prisma.menuCategory.create({
        data: {
          tenantId,
          name: categoryDefinition.name,
          nameLocalized: categoryDefinition.nameUrdu ? { UR: categoryDefinition.nameUrdu } : {},
          sortOrder: categoryIndex,
        },
      });
    }

    for (const [itemIndex, itemDefinition] of categoryDefinition.items.entries()) {
      let item = await prisma.menuItem.findFirst({
        where: { tenantId, name: itemDefinition.name },
      });

      if (!item) {
        item = await prisma.menuItem.create({
          data: {
            tenantId,
            categoryId: category.id,
            name: itemDefinition.name,
            nameLocalized: itemDefinition.nameUrdu ? { UR: itemDefinition.nameUrdu } : {},
            description: itemDefinition.description ?? null,
            basePrice: itemDefinition.basePrice,
            costPrice: itemDefinition.costPrice ?? null,
            currency: organization.currency,
            preparationTimeMinutes: itemDefinition.preparationTimeMinutes ?? 15,
            availability: itemDefinition.availability ?? 'AVAILABLE',
            sortOrder: itemIndex,
            variants: {
              create: (itemDefinition.variants ?? []).map((variant, variantIndex) => ({
                tenantId,
                name: variant.name,
                price: variant.price,
                isDefault: variant.isDefault ?? variantIndex === 0,
                sortOrder: variantIndex,
              })),
            },
          },
        });

        for (const [linkIndex, modifierName] of (itemDefinition.modifiers ?? []).entries()) {
          const modifierId = modifierIdByName.get(modifierName);
          if (!modifierId) continue;
          await prisma.menuItemModifier.create({
            data: { tenantId, menuItemId: item.id, modifierId, sortOrder: linkIndex },
          });
        }
      }

      itemIdByName.set(itemDefinition.name, item.id);
    }
  }

  for (const override of branchOverrides) {
    const branch = await prisma.branch.findFirst({
      where: { tenantId, slug: override.branchSlug },
    });
    const menuItemId = itemIdByName.get(override.itemName);
    if (!branch || !menuItemId) continue;

    await prisma.branchMenuOverride.upsert({
      where: { branchId_menuItemId: { branchId: branch.id, menuItemId } },
      update: {
        ...(override.price !== undefined ? { price: override.price } : {}),
        ...(override.availability !== undefined ? { availability: override.availability } : {}),
      },
      create: {
        tenantId,
        branchId: branch.id,
        menuItemId,
        price: override.price ?? null,
        availability: override.availability ?? null,
      },
    });
  }

  const itemCount = await prisma.menuItem.count({ where: { tenantId } });
  console.log(`  ${organization.name}: ${itemCount} menu item(s)`);
}


interface DemoZone {
  branchSlug: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMetres: number;
  deliveryFee: string;
  minimumOrder?: string;
  sortOrder: number;
}

/**
 * Seeds delivery zones (ENGINEERING_SPEC.md 29).
 *
 * Zones are what make branch selection and the delivery fee deterministic, and
 * overlapping zones are resolved by sortOrder — a cheap inner zone beats the
 * wider, dearer one it sits inside.
 */
async function seedDeliveryZones(organizationSlug: string, zones: DemoZone[]): Promise<void> {
  const organization = await prisma.organization.findUnique({ where: { slug: organizationSlug } });
  if (!organization) return;

  let created = 0;

  for (const zone of zones) {
    const branch = await prisma.branch.findFirst({
      where: { tenantId: organization.id, slug: zone.branchSlug },
    });
    if (!branch) continue;

    const existing = await prisma.deliveryZone.findFirst({
      where: { branchId: branch.id, name: zone.name },
    });
    if (existing) continue;

    await prisma.deliveryZone.create({
      data: {
        tenantId: organization.id,
        branchId: branch.id,
        name: zone.name,
        centerLatitude: zone.latitude,
        centerLongitude: zone.longitude,
        radiusMetres: zone.radiusMetres,
        deliveryFee: zone.deliveryFee,
        minimumOrder: zone.minimumOrder ?? null,
        sortOrder: zone.sortOrder,
      },
    });
    created += 1;
  }

  const total = await prisma.deliveryZone.count({ where: { tenantId: organization.id } });
  console.log(`  ${organization.name}: ${total} zone(s) (${created} new)`);
}

async function main(): Promise<void> {
  console.log('Seeding reference data...');
  const permissionIds = await seedPermissions();
  const roleIds = await seedSystemRoles(permissionIds);

  if (process.env.NODE_ENV === 'production' && process.env.SEED_DEMO_DATA !== 'true') {
    console.log('\nProduction environment: skipping demo tenants.');
    return;
  }

  console.log('\nSeeding demo tenants...');
  const passwordHash = await argon2.hash(DEMO_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  // A chain, to keep multi-branch and branch-scoped access exercised.
  await seedTenant(
    {
      name: 'Kababjees Demo',
      slug: 'kababjees-demo',
      type: OrganizationType.CHAIN,
      branches: [
        { name: 'DHA', slug: 'dha', city: 'Karachi', dineIn: true },
        { name: 'Clifton', slug: 'clifton', city: 'Karachi', dineIn: true },
        { name: 'Gulshan', slug: 'gulshan', city: 'Karachi' },
        { name: 'Lahore', slug: 'lahore', city: 'Lahore', dineIn: true },
      ],
      staff: [
        { email: 'owner@kababjees.test', name: 'Chain Owner', role: SystemRole.OWNER },
        {
          email: 'regional@kababjees.test',
          name: 'Regional Manager',
          role: SystemRole.REGIONAL_MANAGER,
        },
        {
          email: 'dha.manager@kababjees.test',
          name: 'DHA Branch Manager',
          role: SystemRole.BRANCH_MANAGER,
          branchSlugs: ['dha'],
        },
        {
          email: 'dha.cashier@kababjees.test',
          name: 'DHA Cashier',
          role: SystemRole.CASHIER,
          branchSlugs: ['dha'],
        },
        {
          email: 'dha.kitchen@kababjees.test',
          name: 'DHA Kitchen',
          role: SystemRole.KITCHEN_STAFF,
          branchSlugs: ['dha'],
        },
      ],
    },
    roleIds,
    passwordHash,
  );

  // A home kitchen: one branch, one person wearing every hat.
  await seedTenant(
    {
      name: 'Ali Home Kitchen',
      slug: 'ali-home-kitchen',
      type: OrganizationType.HOME_KITCHEN,
      branches: [{ name: 'Main Kitchen', slug: 'main', city: 'Karachi' }],
      staff: [{ email: 'ali@homekitchen.test', name: 'Ali', role: SystemRole.OWNER }],
    },
    roleIds,
    passwordHash,
  );

  console.log('\nSeeding demo menus...');

  await seedMenu(
    'kababjees-demo',
    [
      {
        name: 'Spice level',
        selectionType: 'SINGLE',
        required: true,
        options: [{ name: 'Mild' }, { name: 'Medium' }, { name: 'Hot' }],
      },
      {
        name: 'Add-ons',
        selectionType: 'MULTIPLE',
        maxSelections: 4,
        options: [
          { name: 'Extra cheese', priceDelta: '120.00' },
          { name: 'Extra patty', priceDelta: '250.00' },
          { name: 'Raita', priceDelta: '80.00' },
          { name: 'No onions', priceDelta: '0.00' },
        ],
      },
    ],
    [
      {
        name: 'BBQ',
        nameUrdu: 'باربی کیو',
        items: [
          {
            name: 'Chicken Tikka',
            nameUrdu: 'چکن تکہ',
            basePrice: '650.00',
            costPrice: '310.00',
            preparationTimeMinutes: 20,
            modifiers: ['Spice level'],
          },
          {
            name: 'Beef Seekh Kebab',
            basePrice: '750.00',
            costPrice: '390.00',
            preparationTimeMinutes: 22,
            modifiers: ['Spice level'],
          },
          {
            name: 'BBQ Platter',
            basePrice: '2400.00',
            costPrice: '1150.00',
            preparationTimeMinutes: 35,
            variants: [
              { name: 'For two', price: '2400.00', isDefault: true },
              { name: 'For four', price: '4300.00' },
            ],
            modifiers: ['Spice level', 'Add-ons'],
          },
        ],
      },
      {
        name: 'Burgers',
        items: [
          {
            name: 'Chicken Burger',
            basePrice: '700.00',
            costPrice: '280.00',
            modifiers: ['Add-ons'],
          },
          {
            name: 'Zinger Burger',
            basePrice: '780.00',
            costPrice: '320.00',
            modifiers: ['Spice level', 'Add-ons'],
          },
        ],
      },
      {
        name: 'Rice',
        items: [
          {
            name: 'Chicken Biryani',
            nameUrdu: 'چکن بریانی',
            basePrice: '450.00',
            costPrice: '190.00',
            modifiers: ['Spice level'],
          },
        ],
      },
      {
        name: 'Beverages',
        items: [
          { name: 'Soft Drink', basePrice: '120.00', costPrice: '60.00', preparationTimeMinutes: 1 },
          { name: 'Fresh Lime', basePrice: '250.00', costPrice: '70.00', preparationTimeMinutes: 5 },
        ],
      },
    ],
    [
      // Lahore prices above Karachi, and the platter is off at Gulshan tonight.
      { branchSlug: 'lahore', itemName: 'BBQ Platter', price: '2650.00' },
      { branchSlug: 'lahore', itemName: 'Chicken Tikka', price: '720.00' },
      { branchSlug: 'gulshan', itemName: 'BBQ Platter', availability: 'OUT_OF_STOCK' },
    ],
  );

  await seedMenu(
    'ali-home-kitchen',
    [
      {
        name: 'Portion',
        selectionType: 'SINGLE',
        required: true,
        options: [{ name: 'Half' }, { name: 'Full', priceDelta: '600.00' }],
      },
    ],
    [
      {
        name: 'Home Specials',
        items: [
          {
            name: 'Chicken Karahi',
            nameUrdu: 'چکن کڑاہی',
            basePrice: '1200.00',
            costPrice: '620.00',
            preparationTimeMinutes: 30,
            modifiers: ['Portion'],
          },
          {
            name: 'Daal Chawal',
            basePrice: '350.00',
            costPrice: '110.00',
            preparationTimeMinutes: 15,
          },
        ],
      },
    ],
  );

  console.log('\nSeeding delivery zones...');

  // Real Karachi and Lahore coordinates, so a delivery quote against a plausible
  // address behaves the way it would in production rather than around (0,0).
  await seedDeliveryZones('kababjees-demo', [
    { branchSlug: 'dha', name: 'DHA core', latitude: 24.8008, longitude: 67.0114, radiusMetres: 4000, deliveryFee: '120.00', sortOrder: 0 },
    { branchSlug: 'dha', name: 'DHA extended', latitude: 24.8008, longitude: 67.0114, radiusMetres: 9000, deliveryFee: '220.00', minimumOrder: '900.00', sortOrder: 1 },
    { branchSlug: 'clifton', name: 'Clifton', latitude: 24.8138, longitude: 67.0299, radiusMetres: 5000, deliveryFee: '150.00', sortOrder: 0 },
    { branchSlug: 'gulshan', name: 'Gulshan', latitude: 24.9204, longitude: 67.0971, radiusMetres: 6000, deliveryFee: '150.00', sortOrder: 0 },
    { branchSlug: 'lahore', name: 'Gulberg', latitude: 31.5204, longitude: 74.3587, radiusMetres: 8000, deliveryFee: '180.00', sortOrder: 0 },
  ]);

  await seedDeliveryZones('ali-home-kitchen', [
    { branchSlug: 'main', name: 'Nearby', latitude: 24.8607, longitude: 67.0011, radiusMetres: 5000, deliveryFee: '100.00', sortOrder: 0 },
  ]);

  console.log(`\nDemo accounts use the password: ${DEMO_PASSWORD}`);
  console.log('Sign in with owner@kababjees.test or ali@homekitchen.test');
}

main()
  .catch((error: unknown) => {
    console.error('\nSeed failed:', error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
