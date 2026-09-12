# Restaurant OS
## Engineering Specification v1.0

## 1. Product Definition

Restaurant OS is a multi-tenant SaaS platform for restaurants, restaurant chains, home kitchens, and local food vendors.

The platform combines:

- WhatsApp ordering
- Online ordering
- POS
- Kitchen Display System
- Payments
- Order tracking
- Customer notifications
- Table reservations
- QR/table ordering
- Menu management
- Customer CRM
- Delivery management
- Inventory
- Analytics
- AI ordering assistant
- AI business assistant
- AI recommendations
- Marketing automation

The core principle is:

> WhatsApp, Web, QR, POS and future channels are interfaces over one centralized restaurant/order platform.

No channel should contain independent business logic.

---

# 2. Primary Goals

The system must:

1. Never silently lose an order.
2. Ensure every order belongs to exactly one tenant.
3. Support multiple branches per tenant.
4. Support restaurant chains and single-location businesses.
5. Support WhatsApp ordering.
6. Support human staff taking orders through POS.
7. Support online payments and cash on delivery.
8. Support real-time kitchen/order updates.
9. Notify customers and restaurant staff about important order events.
10. Support table reservations where enabled.
11. Allow restaurants to manage menus dynamically.
12. Provide analytics and AI-driven business insights.
13. Keep AI separate from transactional business logic.
14. Make all financial/order operations deterministic and auditable.
15. Be extensible to additional payment, delivery and messaging providers.

---

# 3. Non-Goals for Initial MVP

Do NOT implement all of the following in the first release:

- Kubernetes
- Kafka
- Multi-region deployment
- Complex accounting
- Full ERP
- Advanced ML forecasting
- Complex warehouse management
- Native mobile applications
- Multiple delivery providers
- Offline POS synchronization
- Advanced loyalty
- Franchise accounting

The architecture must allow these later, but MVP should remain operationally simple.

---

# 4. Architecture

Use a modular monolith initially.

Recommended structure:

```text
restaurant-os/
│
├── apps/
│   ├── api/
│   ├── dashboard/
│   ├── customer-web/
│   ├── kitchen/
│   └── ai-worker/
│
├── packages/
│   ├── database/
│   ├── auth/
│   ├── types/
│   ├── events/
│   ├── whatsapp/
│   ├── payments/
│   ├── notifications/
│   └── ui/
│
├── infrastructure/
│   ├── docker/
│   └── migrations/
│
├── docs/
│
├── tests/
│
└── ENGINEERING_SPEC.md
```

Do not prematurely split the system into microservices.

Use clear module boundaries so individual modules can later become services.

---

# 5. Recommended Technology

## Frontend

- TypeScript
- React
- Next.js or TanStack Start
- Tailwind CSS
- Component library where appropriate
- WebSocket/SSE for real-time updates

## Backend

Preferred:

- Node.js
- TypeScript
- Fastify or NestJS

AI/ML workers:

- Python where useful

## Database

PostgreSQL is the primary transactional database.

## Cache / Queue

Redis.

For initial asynchronous jobs:

- BullMQ or equivalent Redis-backed queue

Do not introduce Kafka unless scale actually requires it.

## Object Storage

S3-compatible object storage.

Used for:

- menu images
- receipts
- restaurant assets
- customer-uploaded files if eventually required

## Authentication

Use secure session/JWT architecture with:

- RBAC
- tenant isolation
- refresh token/session handling
- optional 2FA for privileged users

---

# 6. Multi-Tenant Model

The top-level entity is:

```text
Organization
```

Every restaurant business is an organization/tenant.

Example:

```text
Kababjees
├── DHA
├── Clifton
├── Gulshan
└── Lahore
```

A home kitchen:

```text
Ali Home Kitchen
└── Main Kitchen
```

Every tenant-owned record must contain:

```text
tenant_id
```

Branch-specific records must contain:

```text
tenant_id
branch_id
```

Never trust tenant_id supplied by the client.

Tenant context must be derived from the authenticated user/session.

---

# 7. Tenant Isolation

Every database query involving tenant-owned data must enforce tenant isolation.

Example:

```text
WHERE tenant_id = currentTenantId
```

Never allow:

```text
GET /orders/:id
```

to return an order simply because the order ID exists.

It must additionally verify:

```text
order.tenant_id === authenticatedUser.tenant_id
```

For branch-restricted users:

```text
order.branch_id IN authorizedBranches
```

Create reusable tenant-scoping utilities.

Do not rely on developers remembering to manually add tenant filters everywhere.

---

# 8. Core Domain Modules

Backend modules:

```text
auth
tenants
branches
users
roles
menu
customers
orders
payments
reservations
tables
kitchen
delivery
notifications
promotions
inventory
analytics
ai
integrations
audit
```

---

# 9. Database Schema

## organizations

```text
id UUID PK
name VARCHAR
slug VARCHAR UNIQUE
type ENUM
status ENUM
currency VARCHAR
timezone VARCHAR
logo_url TEXT
created_at TIMESTAMP
updated_at TIMESTAMP
```

Types:

```text
RESTAURANT
CHAIN
HOME_KITCHEN
FOOD_VENDOR
```

---

## branches

```text
id UUID PK
tenant_id UUID FK
name VARCHAR
slug VARCHAR
address TEXT
city VARCHAR
latitude DECIMAL
longitude DECIMAL
phone VARCHAR
status ENUM
opening_hours JSONB
delivery_enabled BOOLEAN
pickup_enabled BOOLEAN
dine_in_enabled BOOLEAN
reservations_enabled BOOLEAN
created_at TIMESTAMP
updated_at TIMESTAMP
```

---

## users

```text
id UUID PK
tenant_id UUID FK
name VARCHAR
email VARCHAR
phone VARCHAR
password_hash TEXT
status ENUM
created_at TIMESTAMP
updated_at TIMESTAMP
```

---

## roles

```text
id UUID PK
tenant_id UUID FK NULL
name VARCHAR
```

System roles:

```text
PLATFORM_ADMIN
OWNER
REGIONAL_MANAGER
BRANCH_MANAGER
CASHIER
KITCHEN_STAFF
DELIVERY_RIDER
VIEWER
```

---

## permissions

Examples:

```text
orders.view
orders.create
orders.update
orders.cancel

payments.view
payments.refund

menu.view
menu.create
menu.update
menu.delete

customers.view
customers.update

analytics.view

branches.view
branches.manage

staff.view
staff.manage

reservations.view
reservations.manage
```

---

# 10. Menu Schema

## menu_categories

```text
id UUID PK
tenant_id UUID
name VARCHAR
description TEXT
sort_order INTEGER
is_active BOOLEAN
created_at
updated_at
```

## menu_items

```text
id UUID PK
tenant_id UUID
category_id UUID
name VARCHAR
description TEXT
image_url TEXT
base_price DECIMAL
cost_price DECIMAL NULL
currency VARCHAR
preparation_time_minutes INTEGER
is_available BOOLEAN
is_active BOOLEAN
sort_order INTEGER
created_at
updated_at
```

## menu_item_variants

```text
id UUID PK
menu_item_id UUID
name VARCHAR
price DECIMAL
is_default BOOLEAN
```

## modifiers

```text
id UUID PK
tenant_id UUID
name VARCHAR
selection_type ENUM
required BOOLEAN
min_selections INTEGER
max_selections INTEGER
```

## modifier_options

```text
id UUID PK
modifier_id UUID
name VARCHAR
price_delta DECIMAL
```

Restaurants must be able to mark items:

```text
AVAILABLE
OUT_OF_STOCK
HIDDEN
```

Availability must immediately affect:

- POS
- WhatsApp
- Website
- QR ordering

---

# 11. Customer Schema

## customers

```text
id UUID PK
tenant_id UUID
name VARCHAR
phone VARCHAR
whatsapp_number VARCHAR
email VARCHAR NULL
first_order_at TIMESTAMP
last_order_at TIMESTAMP
total_orders INTEGER
total_spend DECIMAL
created_at
updated_at
```

## customer_addresses

```text
id UUID PK
customer_id UUID
label VARCHAR
address TEXT
city VARCHAR
latitude DECIMAL NULL
longitude DECIMAL NULL
is_default BOOLEAN
```

Do not expose unnecessary customer data to unauthorized staff.

---

# 12. Order Model

Orders are the central business entity.

## orders

```text
id UUID PK
tenant_id UUID
branch_id UUID
customer_id UUID NULL

order_number VARCHAR

source ENUM
order_type ENUM
status ENUM
payment_status ENUM

subtotal DECIMAL
discount_amount DECIMAL
delivery_fee DECIMAL
tax_amount DECIMAL
total DECIMAL

customer_name VARCHAR
customer_phone VARCHAR

delivery_address TEXT NULL
delivery_latitude DECIMAL NULL
delivery_longitude DECIMAL NULL

table_id UUID NULL

notes TEXT NULL

created_at TIMESTAMP
updated_at TIMESTAMP
confirmed_at TIMESTAMP NULL
completed_at TIMESTAMP NULL
cancelled_at TIMESTAMP NULL
```

Sources:

```text
WHATSAPP
WEBSITE
QR
POS
PHONE
ADMIN
```

Order types:

```text
DELIVERY
PICKUP
DINE_IN
```

---

# 13. Order Items

## order_items

```text
id UUID PK
order_id UUID
menu_item_id UUID
item_name_snapshot VARCHAR
unit_price DECIMAL
quantity INTEGER
total_price DECIMAL
notes TEXT
```

Store item snapshots.

If the restaurant changes:

```text
Chicken Burger = Rs. 700
```

an old order must continue displaying the original price/name.

Do not dynamically read historical order prices from the current menu.

---

# 14. Order Item Modifiers

```text
id UUID PK
order_item_id UUID
modifier_name_snapshot VARCHAR
option_name_snapshot VARCHAR
price_delta DECIMAL
```

Again, use snapshots.

---

# 15. Order State Machine

Orders must use a controlled state machine.

Initial:

```text
DRAFT
```

Checkout:

```text
PENDING_PAYMENT
```

After successful payment:

```text
CONFIRMED
```

Restaurant:

```text
ACCEPTED
```

Kitchen:

```text
PREPARING
```

Kitchen:

```text
READY
```

Delivery:

```text
OUT_FOR_DELIVERY
```

Final:

```text
DELIVERED
```

For pickup:

```text
READY
→ COMPLETED
```

For dine-in:

```text
READY
→ COMPLETED
```

Cancellation:

```text
CANCELLED
```

Rejection:

```text
REJECTED
```

Payment failure:

```text
PAYMENT_FAILED
```

Refund:

```text
REFUNDED
```

Invalid state transitions must be rejected.

Example:

```text
DELIVERED → PREPARING
```

must fail.

---

# 16. Order State Transition Rules

Implement one centralized order state transition function:

```text
transitionOrder(orderId, newStatus, actor)
```

This function must:

1. Load order.
2. Verify tenant.
3. Verify actor permissions.
4. Validate current state.
5. Validate target state.
6. Update order.
7. Write audit record.
8. Publish domain event.
9. Trigger asynchronous notifications.

Do not allow arbitrary:

```text
UPDATE orders SET status = ...
```

through controllers.

---

# 17. Idempotency

Order creation and payment operations must support idempotency.

Every external operation that can be retried should have an idempotency key.

Example:

```text
POST /orders
Idempotency-Key: abc123
```

If the same request arrives twice:

```text
first request → creates order
second request → returns existing order
```

This is mandatory for payment/webhook handling.

---

# 18. Payment Architecture

Create a provider abstraction:

```text
PaymentProvider
```

Interface:

```text
createPayment()
verifyPayment()
getPaymentStatus()
refundPayment()
```

Providers can include:

```text
Safepay
JazzCash
Bank/Raast provider
Cash
Future providers
```

Do not couple order logic directly to a specific provider.

---

# 19. Payment Tables

## payments

```text
id UUID PK
tenant_id UUID
order_id UUID
provider VARCHAR
provider_payment_id VARCHAR
amount DECIMAL
currency VARCHAR
status ENUM
created_at
updated_at
```

Statuses:

```text
PENDING
PROCESSING
SUCCEEDED
FAILED
REFUNDED
PARTIALLY_REFUNDED
```

## payment_events

```text
id UUID PK
payment_id UUID
provider_event_id VARCHAR UNIQUE
event_type VARCHAR
payload JSONB
processed_at TIMESTAMP
```

---

# 20. Payment Webhooks

Endpoint:

```text
POST /api/v1/webhooks/payments/:provider
```

Process:

```text
Receive webhook
↓
Verify signature
↓
Check provider event ID
↓
Check idempotency
↓
Find payment
↓
Update payment
↓
Update order
↓
Publish payment event
```

Never trust frontend payment redirects as authoritative payment confirmation.

The provider webhook is authoritative after signature verification.

---

# 21. WhatsApp Architecture

WhatsApp is a channel adapter.

Architecture:

```text
WhatsApp
↓
Webhook
↓
WhatsApp Adapter
↓
Message Normalizer
↓
Conversation Engine
↓
AI / Structured Flow
↓
Domain Command
↓
Order Service
```

WhatsApp-specific code must not contain core order business logic.

---

# 22. WhatsApp Conversation State

Create:

```text
conversation_sessions
```

Fields:

```text
id UUID
tenant_id UUID
customer_id UUID
channel VARCHAR
external_user_id VARCHAR
state VARCHAR
context JSONB
expires_at TIMESTAMP
created_at
updated_at
```

Possible states:

```text
IDLE
BROWSING_MENU
BUILDING_CART
ASKING_ADDRESS
SELECTING_ORDER_TYPE
CONFIRMING_ORDER
AWAITING_PAYMENT
TRACKING_ORDER
RESERVATION_FLOW
HUMAN_HANDOFF
```

---

# 23. WhatsApp Intent System

Supported intents:

```text
GREETING
BROWSE_MENU
SEARCH_MENU
ADD_TO_CART
REMOVE_FROM_CART
UPDATE_CART
CHECKOUT
DELIVERY
PICKUP
DINE_IN
PAYMENT
TRACK_ORDER
CANCEL_ORDER
RESERVE_TABLE
CANCEL_RESERVATION
RECOMMENDATION
CUSTOMER_SUPPORT
HUMAN_HANDOFF
```

AI may classify intent.

But domain services must validate every command.

---

# 24. AI Command Contract

AI should output structured commands.

Example:

```json
{
  "intent": "ADD_TO_CART",
  "items": [
    {
      "menu_item_id": "uuid",
      "quantity": 2
    }
  ]
}
```

Backend then:

```text
validate item
validate availability
validate quantity
calculate price
apply modifiers
update cart
```

Never trust AI-generated:

```text
price
tax
discount
payment status
order status
```

These must come from deterministic backend logic.

---

# 25. Natural Language Ordering

Example:

Customer:

> I want two chicken burgers and fries.

AI resolves:

```text
ADD_TO_CART
```

Backend validates:

```text
Chicken Burger exists
Fries exists
Both available
```

Then updates cart.

AI must not directly write to the database.

---

# 26. AI Recommendation

AI may recommend:

```text
Chicken Burger + Fries + Coke
```

But recommendations must be based on actual menu data.

Provide tools:

```text
searchMenu()
getMenuItem()
getPopularItems()
getDeals()
getCustomerPreferences()
```

The AI must never hallucinate menu items.

---

# 27. Cart

Create:

```text
carts
cart_items
cart_item_modifiers
```

Cart belongs to:

```text
tenant
customer
branch
```

Cart totals must be calculated server-side.

Never accept:

```text
total = 1500
```

from the client as authoritative.

---

# 28. Checkout

Checkout flow:

```text
Cart
↓
Validate restaurant status
↓
Validate branch
↓
Validate item availability
↓
Validate quantities
↓
Calculate subtotal
↓
Calculate discounts
↓
Calculate delivery fee
↓
Calculate tax
↓
Calculate final total
↓
Create pending order
↓
Initialize payment if required
```

---

# 29. Branch Selection

For delivery orders:

```text
Customer location
↓
Eligible branches
↓
Opening hours
↓
Delivery radius
↓
Item availability
↓
Branch capacity
↓
Estimated preparation time
↓
Select branch
```

Initially use deterministic rules.

Later support optimization/AI.

---

# 30. Notification Architecture

All important domain events should publish notifications asynchronously.

Events:

```text
ORDER_CREATED
ORDER_CONFIRMED
ORDER_ACCEPTED
ORDER_REJECTED
ORDER_PREPARING
ORDER_READY
ORDER_OUT_FOR_DELIVERY
ORDER_DELIVERED

PAYMENT_SUCCESS
PAYMENT_FAILED
PAYMENT_REFUNDED

RESERVATION_CREATED
RESERVATION_CONFIRMED
RESERVATION_CANCELLED
```

Notification channels:

```text
WHATSAPP
SMS
EMAIL
PUSH
DASHBOARD
```

---

# 31. Notification Table

```text
notifications

id UUID
tenant_id UUID
event_id UUID
recipient_type VARCHAR
recipient_id UUID
channel VARCHAR
template VARCHAR
payload JSONB
status ENUM
attempts INTEGER
sent_at TIMESTAMP
delivered_at TIMESTAMP NULL
failed_at TIMESTAMP NULL
created_at TIMESTAMP
```

Statuses:

```text
PENDING
PROCESSING
SENT
DELIVERED
FAILED
```

---

# 32. Notification Reliability

Never make order creation depend on successful notification delivery.

Correct:

```text
Order created
↓
Database commit
↓
Event published
↓
Notification queue
↓
WhatsApp/SMS/etc.
```

Incorrect:

```text
Create order
↓
send WhatsApp
↓
if WhatsApp succeeds
    save order
```

Notifications must be retried.

Use exponential backoff.

---

# 33. Unacknowledged Order Protection

Every restaurant order must be monitored.

When:

```text
ORDER_CONFIRMED
```

start acknowledgement timer.

Example:

```text
60 seconds
```

If nobody accepts:

```text
ORDER_ACKNOWLEDGEMENT_TIMEOUT
```

Trigger escalation.

Example:

```text
Kitchen
↓
Branch Manager
↓
Owner
```

Thresholds must be configurable per restaurant.

The dashboard must visually and audibly highlight unacknowledged orders.

---

# 34. Kitchen Display System

Kitchen screen columns:

```text
NEW
ACCEPTED
PREPARING
READY
```

Each order card:

```text
Order #
Order time
Items
Modifiers
Notes
Order type
Table/address where appropriate
Elapsed time
```

Use real-time events.

No polling-only architecture.

---

# 35. Kitchen Timers

Every order should track:

```text
created_at
accepted_at
preparing_at
ready_at
completed_at
```

This enables:

```text
order preparation time
acceptance delay
kitchen delay
delivery time
```

These metrics feed analytics and AI.

---

# 36. POS

POS must support:

```text
DINE_IN
TAKEAWAY
DELIVERY
```

And receive orders from:

```text
POS
WHATSAPP
WEBSITE
QR
```

POS should provide:

```text
fast menu selection
search
categories
cart
modifiers
discounts
payment
receipt
order history
```

---

# 37. POS Order Creation

Staff-created order:

```text
POS
↓
Select customer optionally
↓
Select items
↓
Select order type
↓
Select table/address if needed
↓
Calculate totals
↓
Payment
↓
Create order
↓
Kitchen
```

It must use the same Order Service as WhatsApp and Web.

---

# 38. Reservations

Reservations are optional per branch.

## reservations

```text
id UUID
tenant_id UUID
branch_id UUID
customer_id UUID
table_id UUID NULL
reservation_number VARCHAR
date DATE
start_time TIME
end_time TIME
party_size INTEGER
status ENUM
notes TEXT
created_at
updated_at
```

Statuses:

```text
PENDING
CONFIRMED
SEATED
COMPLETED
CANCELLED
NO_SHOW
```

---

# 39. Tables

## tables

```text
id UUID
tenant_id UUID
branch_id UUID
name VARCHAR
capacity INTEGER
area VARCHAR
status ENUM
```

Statuses:

```text
AVAILABLE
OCCUPIED
RESERVED
CLEANING
DISABLED
```

Reservation logic must prevent conflicting reservations.

---

# 40. Reservation Flow

Customer:

> I want a table tomorrow at 8 for four people.

AI extracts:

```text
date
time
party_size
```

Backend checks:

```text
restaurant hours
table capacity
existing reservations
table availability
```

Then:

```text
PENDING
↓
customer confirmation
↓
CONFIRMED
```

Never let AI independently confirm a reservation without checking the reservation service.

---

# 41. QR Ordering

Each table can have a QR token.

Example:

```text
QR
↓
/order?table_token=abc
```

Token resolves:

```text
tenant
branch
table
```

Customer can order without logging in.

Do not expose raw internal table IDs.

---

# 42. Delivery

## deliveries

```text
id UUID
tenant_id UUID
branch_id UUID
order_id UUID
rider_id UUID NULL
provider VARCHAR NULL
status ENUM
estimated_delivery_at TIMESTAMP
picked_up_at TIMESTAMP NULL
delivered_at TIMESTAMP NULL
```

Statuses:

```text
PENDING
ASSIGNED
ACCEPTED
PICKED_UP
OUT_FOR_DELIVERY
DELIVERED
FAILED
CANCELLED
```

Create a provider abstraction:

```text
DeliveryProvider
```

---

# 43. Customer Tracking

Order tracking endpoint:

```text
GET /api/v1/orders/:id/tracking
```

Customer sees:

```text
Order confirmed ✓
Preparing ✓
Ready ✓
Out for delivery ●
Delivered
```

If GPS delivery is supported:

```text
rider
↓
location update
↓
backend
↓
WebSocket
↓
customer
```

---

# 44. Dashboard

Dashboard navigation:

```text
Overview
Live Orders
POS
Kitchen
Menu
Customers
Reservations
Delivery
Inventory
Promotions
Payments
Analytics
AI Insights
Staff
Branches
Settings
```

The exact navigation should adapt according to tenant type and permissions.

---

# 45. Dashboard Overview

Display:

```text
Today's Revenue
Today's Orders
Average Order Value
Cancellation Rate
Active Orders
Pending Orders
```

Charts:

```text
Revenue over time
Orders over time
Top menu items
Branch performance
Order sources
```

Live section:

```text
New Orders
Preparing
Ready
Out for Delivery
```

---

# 46. Analytics

MVP metrics:

```text
Revenue
Orders
Average Order Value
Cancellation Rate
Refunds
Payment Success Rate
Top Products
Orders by Source
Orders by Branch
Orders by Hour
Preparation Time
Delivery Time
Repeat Customers
```

---

# 47. Profit Analytics

Where cost_price exists:

```text
Revenue
- discounts
- refunds
- payment fees
- delivery cost
- estimated ingredient cost
=
estimated contribution margin
```

Do not present estimates as exact accounting data.

Label them clearly:

```text
Estimated Profit
Estimated Margin
```

---

# 48. Inventory

MVP inventory:

## inventory_items

```text
id UUID
tenant_id UUID
branch_id UUID
name VARCHAR
unit VARCHAR
quantity DECIMAL
minimum_quantity DECIMAL
cost_per_unit DECIMAL
```

## inventory_transactions

```text
id UUID
inventory_item_id UUID
type ENUM
quantity DECIMAL
reference_type VARCHAR
reference_id UUID
created_at
```

Types:

```text
PURCHASE
SALE
WASTE
ADJUSTMENT
RETURN
```

Inventory should eventually connect menu recipes to item consumption.

---

# 49. Promotions

Support:

```text
percentage discount
fixed discount
coupon
item discount
minimum order amount
time-based promotion
branch-specific promotion
```

Promotion rules must be deterministic.

AI may recommend promotions but must not create financial rules without authorization.

---

# 50. CRM

Customer dashboard:

```text
Customer
Phone
Orders
Total Spend
Average Order
Favorite Items
Last Order
Addresses
Coupons
```

Segments:

```text
NEW
ACTIVE
FREQUENT
VIP
INACTIVE
HIGH_VALUE
```

Segmentation initially uses deterministic rules.

---

# 51. Marketing Automation

Campaign model:

```text
campaigns

id
tenant_id
name
segment
channel
message_template
discount_id
scheduled_at
status
```

Track:

```text
sent
delivered
read
clicked
converted
revenue
```

Do not spam customers.

Respect opt-out preferences.

---

# 52. AI Architecture

AI must be a separate layer.

```text
AI Gateway
↓
Intent Router
↓
Agent
↓
Tools
↓
Domain Services
```

AI tools:

```text
search_menu()
get_menu_item()
get_customer_history()
get_popular_items()
get_sales()
get_branch_sales()
get_order_metrics()
get_inventory()
get_reservations()
get_customer_segments()
```

AI must use tools to retrieve current data.

Never inject the entire database into an LLM prompt.

---

# 53. AI Business Assistant

Owner can ask:

```text
How were sales yesterday?

Why are sales down?

Which branch is performing best?

Which products make the most money?

What are my slowest hours?

Which customers haven't ordered recently?

What should I promote today?

Why are orders taking longer tonight?
```

The AI should call appropriate tools and produce concise evidence-backed answers.

---

# 54. AI Recommendations

Examples:

```text
Revenue increased 12% today.

Chicken Tikka is selling 31% above its weekly average.

Your 8–10 PM preparation time increased by 21%.

143 customers have not ordered in 30+ days.

Your BBQ platter has a higher estimated margin than Deal #4.
```

AI recommendations must distinguish:

```text
FACT
ESTIMATE
RECOMMENDATION
```

---

# 55. LLM Provider Abstraction

Create:

```text
LLMProvider
```

Interface:

```text
generate()
structuredOutput()
classify()
summarize()
```

Possible providers:

```text
Gemini
OpenAI
Future providers
```

Business logic must not directly depend on provider-specific SDK calls.

---

# 56. AI Safety Rules

AI must NOT directly:

```text
change prices
refund money
change payment status
mark orders delivered
cancel financial transactions
modify inventory
confirm reservations
```

unless the action is explicitly authorized through a backend tool with permission checks.

AI generates intent.

Backend executes authorized deterministic commands.

---

# 57. Event System

Domain events:

```text
OrderCreated
OrderConfirmed
OrderAccepted
OrderRejected
OrderPreparing
OrderReady
OrderDispatched
OrderDelivered
OrderCancelled

PaymentInitiated
PaymentSucceeded
PaymentFailed
PaymentRefunded

ReservationCreated
ReservationConfirmed
ReservationCancelled
ReservationCompleted

MenuItemAvailabilityChanged
```

Event payload should include:

```text
event_id
event_type
tenant_id
aggregate_id
timestamp
actor
payload
```

---

# 58. Outbox Pattern

For reliable events, use an outbox table.

## outbox_events

```text
id UUID
tenant_id UUID
event_type VARCHAR
aggregate_type VARCHAR
aggregate_id UUID
payload JSONB
status ENUM
attempts INTEGER
created_at
processed_at
```

When a transaction changes business data:

```text
BEGIN
update order
insert outbox event
COMMIT
```

Worker then publishes/processes event.

This prevents:

```text
database updated
but event lost
```

---

# 59. Audit Logs

## audit_logs

```text
id UUID
tenant_id UUID
actor_id UUID NULL
action VARCHAR
entity_type VARCHAR
entity_id UUID
old_values JSONB
new_values JSONB
ip_address VARCHAR NULL
user_agent TEXT NULL
created_at
```

Audit:

```text
price changes
refunds
order cancellation
menu changes
staff changes
permission changes
reservation changes
```

---

# 60. API Structure

Base:

```text
/api/v1
```

Auth:

```text
POST /auth/login
POST /auth/logout
POST /auth/refresh
GET  /auth/me
```

Organizations:

```text
GET /organizations
GET /organizations/:id
PATCH /organizations/:id
```

Branches:

```text
GET /branches
POST /branches
GET /branches/:id
PATCH /branches/:id
```

Menu:

```text
GET /menu
POST /menu/categories
POST /menu/items
PATCH /menu/items/:id
DELETE /menu/items/:id
POST /menu/items/:id/availability
```

Orders:

```text
GET /orders
POST /orders
GET /orders/:id
POST /orders/:id/transition
POST /orders/:id/cancel
```

Payments:

```text
POST /payments
GET /payments/:id
POST /payments/:id/refund
```

Reservations:

```text
GET /reservations
POST /reservations
GET /reservations/:id
POST /reservations/:id/confirm
POST /reservations/:id/cancel
```

Customers:

```text
GET /customers
GET /customers/:id
PATCH /customers/:id
GET /customers/:id/orders
```

Analytics:

```text
GET /analytics/overview
GET /analytics/sales
GET /analytics/orders
GET /analytics/products
GET /analytics/customers
GET /analytics/branches
```

Webhooks:

```text
POST /webhooks/whatsapp
POST /webhooks/payments/:provider
POST /webhooks/delivery/:provider
```

---

# 61. API Rules

Every API endpoint must:

1. Authenticate where required.
2. Resolve tenant from authentication.
3. Validate input.
4. Validate authorization.
5. Validate tenant ownership.
6. Execute domain service.
7. Return standardized response.
8. Log relevant failures.
9. Never expose internal errors to clients.

Use schemas for request validation.

---

# 62. Error Format

Standard response:

```json
{
  "success": false,
  "error": {
    "code": "ORDER_INVALID_STATE",
    "message": "Order cannot be moved from DELIVERED to PREPARING"
  }
}
```

Do not leak:

```text
stack traces
database errors
secrets
provider credentials
internal implementation details
```

---

# 63. Frontend Architecture

Dashboard should be organized by domain:

```text
dashboard/
├── overview
├── orders
├── pos
├── kitchen
├── menu
├── customers
├── reservations
├── delivery
├── inventory
├── promotions
├── payments
├── analytics
├── ai
├── staff
├── branches
└── settings
```

Use shared:

```text
components
hooks
API client
types
permissions
real-time event handling
```

---

# 64. Real-Time Architecture

Use WebSockets or SSE.

Events:

```text
ORDER_CREATED
ORDER_STATUS_CHANGED
PAYMENT_STATUS_CHANGED
RESERVATION_CHANGED
MENU_AVAILABILITY_CHANGED
DELIVERY_LOCATION_CHANGED
```

Dashboard subscribes only to authorized tenant/branch channels.

Example:

```text
tenant:{tenantId}:branch:{branchId}:orders
```

Never allow arbitrary channel subscription.

---

# 65. POS Performance

POS must prioritize speed.

Avoid unnecessary network requests.

Cache:

```text
menu
categories
modifiers
restaurant settings
```

Use optimistic UI where safe.

Financial operations remain server-authoritative.

---

# 66. Security

Required:

```text
HTTPS
secure cookies
RBAC
tenant isolation
input validation
rate limiting
CSRF protection where applicable
webhook signature validation
password hashing
secret management
audit logging
SQL parameterization
CORS configuration
session expiration
2FA for privileged accounts
```

Never store raw card data.

---

# 67. Rate Limiting

Rate-limit:

```text
authentication
WhatsApp webhook processing
public order APIs
reservation APIs
AI APIs
payment endpoints
```

Use Redis-based rate limiting.

---

# 68. Webhook Security

Every webhook provider must have:

```text
signature verification
timestamp validation where supported
idempotency
event ID tracking
replay protection
```

Never blindly trust incoming webhook payloads.

---

# 69. Observability

Implement:

```text
structured logs
request IDs
event IDs
error tracking
metrics
health endpoints
```

Health:

```text
GET /health
GET /ready
```

Readiness checks:

```text
PostgreSQL
Redis
queue
```

Track:

```text
API latency
order creation failures
payment failures
WhatsApp failures
notification failures
queue backlog
AI latency
AI usage/cost
database latency
```

---

# 70. Critical Alerts

Alert when:

```text
payment failure rate spikes
WhatsApp webhook failures spike
notification queue grows
orders remain unacknowledged
database unavailable
Redis unavailable
KDS disconnected
```

Example:

```text
12 confirmed orders have not been acknowledged
for more than 2 minutes.
```

---

# 71. Testing Strategy

Every domain module must have tests.

## Unit tests

Test:

```text
pricing
discounts
tax
delivery fees
order state transitions
reservation availability
permissions
tenant isolation
menu availability
```

## Integration tests

Test:

```text
order creation
payment webhook
WhatsApp webhook
notification flow
reservation creation
POS order
KDS updates
```

## End-to-end tests

At minimum:

```text
WhatsApp order → payment → kitchen → delivery → completion

Website order → payment → kitchen → completion

POS order → kitchen → completion

Reservation → confirmation → cancellation
```

---

# 72. Critical Invariants

These must always be true:

### Invariant 1

An order belongs to exactly one tenant.

### Invariant 2

An order belongs to exactly one branch unless explicitly designed otherwise.

### Invariant 3

Order totals are server calculated.

### Invariant 4

Payment status cannot be manually trusted from the client.

### Invariant 5

Historical order prices do not change when menu prices change.

### Invariant 6

Invalid order state transitions are rejected.

### Invariant 7

Webhook processing is idempotent.

### Invariant 8

Notifications cannot cause an order transaction to fail.

### Invariant 9

AI cannot bypass authorization.

### Invariant 10

A user cannot access another tenant's resources.

---

# 73. Restaurant Onboarding

Initial onboarding:

```text
Create account
↓
Create organization
↓
Create branch
↓
Configure hours
↓
Create/import menu
↓
Configure order types
↓
Configure payment
↓
Connect WhatsApp
↓
Create staff
↓
Go live
```

Menu import can eventually support:

```text
PDF
Excel
CSV
Image
Existing website
```

AI extracts menu data into a draft.

Admin must review before publishing.

---

# 74. Tenant Configuration

Store settings such as:

```text
timezone
currency
tax
service charges
delivery fee
minimum order
order acceptance timeout
reservation duration
notification preferences
WhatsApp settings
payment providers
delivery settings
```

Never hard-code restaurant-specific behavior.

---

# 75. Restaurant Modes

The same application must support:

### Home Kitchen

Minimal dashboard:

```text
Orders
Menu
Customers
Payments
Analytics
Settings
```

### Restaurant

```text
Orders
POS
Kitchen
Menu
Customers
Reservations
Delivery
Analytics
```

### Enterprise Chain

```text
Corporate Dashboard
Branches
Regional Analytics
Staff
Central Menu
Orders
Payments
Inventory
AI Intelligence
```

Features should be enabled using configuration/permissions rather than separate applications.

---

# 76. MVP Definition

MVP must include:

```text
[ ] Multi-tenancy
[ ] Authentication
[ ] RBAC
[ ] Organizations
[ ] Branches
[ ] Menu
[ ] Customers
[ ] Cart
[ ] Orders
[ ] Order state machine
[ ] POS
[ ] Kitchen Display
[ ] WhatsApp integration
[ ] WhatsApp ordering
[ ] Payment abstraction
[ ] At least one payment provider
[ ] Payment webhook
[ ] Notifications
[ ] Real-time dashboard
[ ] Basic analytics
[ ] Audit logs
```

Do NOT block MVP on:

```text
[ ] Inventory
[ ] Reservations
[ ] Loyalty
[ ] Advanced AI
[ ] Delivery GPS
[ ] Marketing automation
```

---

# 77. Phase 2

Implement:

```text
[ ] Reservations
[ ] Table management
[ ] QR ordering
[ ] Delivery management
[ ] Customer tracking
[ ] Coupons
[ ] Customer segmentation
[ ] Inventory basics
```

---

# 78. Phase 3

Implement:

```text
[ ] AI WhatsApp ordering
[ ] AI recommendations
[ ] AI business assistant
[ ] AI analytics
[ ] Marketing automation
[ ] Loyalty
[ ] Profit intelligence
```

---

# 79. Phase 4

Implement:

```text
[ ] Advanced forecasting
[ ] Demand prediction
[ ] Advanced inventory
[ ] Multi-provider delivery
[ ] Offline POS
[ ] Enterprise reporting
[ ] Accounting integrations
[ ] Franchise management
```

---

# 80. Claude Code Development Rules

Claude Code MUST follow these rules.

## Rule 1

Do not implement the entire platform in one pass.

Implement phase-by-phase.

## Rule 2

Before writing code, inspect the existing repository.

Understand:

```text
package manager
framework
database
existing architecture
environment variables
existing routes
existing authentication
existing deployment
```

Do not overwrite working infrastructure unnecessarily.

## Rule 3

Do not introduce a new framework without justification.

## Rule 4

Do not create microservices prematurely.

## Rule 5

Do not duplicate business logic between:

```text
WhatsApp
POS
Website
QR
```

All must use shared domain services.

## Rule 6

Never allow AI to directly mutate transactional data.

## Rule 7

Every new database table must include appropriate tenant isolation.

## Rule 8

Every API must have validation and authorization.

## Rule 9

Every important state mutation must have tests.

## Rule 10

Do not mark a feature complete without tests.

---

# 81. Claude Code Workflow

For every phase:

```text
1. Inspect repository
2. Read engineering specification
3. Identify affected modules
4. Propose implementation plan
5. Implement
6. Write tests
7. Run tests
8. Fix failures
9. Run type checking
10. Run linting
11. Review tenant isolation
12. Review authorization
13. Review error handling
14. Update documentation
15. Summarize changes
```

Claude must not skip tests simply because implementation appears simple.

---

# 82. Definition of Done

A feature is complete only when:

```text
[ ] Implementation exists
[ ] Database migration exists
[ ] Types exist
[ ] Validation exists
[ ] Authorization exists
[ ] Tenant isolation verified
[ ] Error handling exists
[ ] Tests exist
[ ] Integration tests exist where applicable
[ ] API documentation updated
[ ] Environment variables documented
[ ] No TypeScript errors
[ ] No lint errors
[ ] Existing tests still pass
```

---

# 83. Initial Development Sequence

Claude Code should implement in this exact general order.

## Sprint 1 — Foundation

```text
Repository architecture
Database
ORM
Migrations
Environment configuration
Authentication
Organizations
Branches
Users
Roles
Permissions
Tenant scoping
```

## Sprint 2 — Menu

```text
Categories
Menu items
Modifiers
Availability
Menu APIs
Dashboard menu UI
```

## Sprint 3 — Orders

```text
Customers
Cart
Orders
Order items
Pricing
Order state machine
Order APIs
```

## Sprint 4 — POS

```text
POS UI
Order creation
Payment selection
Receipts
Order history
```

## Sprint 5 — Kitchen

```text
KDS
Real-time order events
Order acknowledgement
Timers
Kitchen workflow
```

## Sprint 6 — Notifications

```text
Event system
Outbox
Notification queue
WhatsApp notifications
Email/SMS abstraction
```

## Sprint 7 — WhatsApp

```text
Webhook
Message normalization
Conversation state
Menu browsing
Cart
Checkout
Order tracking
Human handoff
```

## Sprint 8 — Payments

```text
Payment abstraction
Provider integration
Webhooks
Idempotency
Payment status
Refund foundation
```

## Sprint 9 — Analytics

```text
Sales
Orders
AOV
Products
Branches
Sources
Operational metrics
```

## Sprint 10 — Reservations

```text
Tables
Availability
Reservations
WhatsApp reservation flow
Dashboard reservation management
```

## Sprint 11 — AI

```text
AI gateway
LLM provider
Tool calling
AI WhatsApp ordering
Recommendations
Business assistant
```

---

# 84. First Claude Code Task

Do NOT ask Claude to immediately build the POS.

The first instruction should be:

```text
Read ENGINEERING_SPEC.md completely.

Do not implement features yet.

First inspect the existing repository and report:

1. Current framework
2. Current package manager
3. Current database
4. Current authentication
5. Current API architecture
6. Current frontend architecture
7. Existing environment variables
8. Existing modules
9. Existing routes
10. Existing tests
11. Existing deployment setup
12. Architectural conflicts with ENGINEERING_SPEC.md

Then propose the minimum set of changes required to establish the foundation.

Do not modify code until I approve the architecture plan.
```

---

# 85. Second Claude Code Task

After reviewing its plan:

```text
Implement Sprint 1 from ENGINEERING_SPEC.md.

Requirements:

- Follow the existing repository conventions where reasonable.
- Do not introduce unnecessary dependencies.
- Implement PostgreSQL database structure.
- Implement migrations.
- Implement organizations.
- Implement branches.
- Implement users.
- Implement roles.
- Implement permissions.
- Implement authentication.
- Implement tenant-scoping middleware/utilities.
- Implement authorization utilities.
- Implement audit foundation.

Before implementation, create a short implementation plan.

Then implement.

After implementation:

1. Run type checking.
2. Run linting.
3. Run unit tests.
4. Run integration tests.
5. Verify migrations from an empty database.
6. Verify tenant isolation.
7. Verify unauthorized users cannot access another tenant.
8. Report every changed file.
9. Report every command executed.
10. Report remaining issues.

Do not implement later sprints.
```

---

# 86. Third Claude Code Task

After foundation:

```text
Implement Sprint 2 — Menu.

Follow ENGINEERING_SPEC.md exactly.

Implement:

- menu categories
- menu items
- variants
- modifiers
- modifier options
- availability
- menu APIs
- tenant isolation
- branch-aware availability where required
- dashboard menu management

Requirements:

- server-side validation
- RBAC
- tenant isolation
- audit logging for price and availability changes
- tests for all business rules

Do not implement orders, payments, WhatsApp, reservations or AI yet.
```

---

# 87. Critical Architectural Rule

Whenever Claude proposes something like:

```text
WhatsAppOrderService
POSOrderService
WebsiteOrderService
```

reject duplicated business logic.

Instead:

```text
WhatsApp Adapter
POS Adapter
Website Adapter
       ↓
Order Application Service
       ↓
Order Domain
       ↓
Database
```

---

# 88. Final System

The intended final architecture is:

```text
                           CUSTOMERS
                               |
                 +-------------+-------------+
                 |             |             |
              WhatsApp       Web           QR
                 |             |             |
                 +-------------+-------------+
                               |
                         CHANNEL LAYER
                               |
                     +---------+---------+
                     |                   |
                  AI/Flow             POS UI
                     |                   |
                     +---------+---------+
                               |
                       APPLICATION LAYER
                               |
       +-----------+-----------+-----------+-----------+
       |           |           |           |           |
     Orders      Menu      Customers   Payments   Reservations
       |           |           |           |           |
       +-----------+-----------+-----------+-----------+
                               |
                         DOMAIN EVENTS
                               |
          +--------------------+--------------------+
          |                    |                    |
      Notifications          Kitchen             Analytics
          |                    |                    |
      WhatsApp/SMS          KDS/POS              Reports
                               |
                              AI
                               |
                    Business Intelligence
```

The most important architectural principle remains:

> **One source of truth for orders, payments, menu, customers and reservations. Multiple interfaces on top of it.**

The platform should feel like one system regardless of whether an order originated from WhatsApp, a website, a QR code, a cashier or an administrator.