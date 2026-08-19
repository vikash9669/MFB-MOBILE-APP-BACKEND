# Admin panel: PHP → React migration

The CodeIgniter `administration` app is being replaced by
[MFB-ADMIN-PANEL](../MFB-ADMIN-PANEL) (React + TypeScript + Vite). This document
records what moved, what didn't, and the decisions behind both.

## Which panel was migrated, and why only one

`MFB_PHP_ADMIN_PANEL/admin/` contains **three** CodeIgniter applications:

| App | What it is | Migrated |
| --- | --- | --- |
| `administration/` | The working admin panel — orders, vendors, riders, catalogue | **yes** |
| `admin/` | An RBAC panel for a *different* product | no — see below |
| `store/` | The customer storefront, not an admin tool | no — out of scope |

`admin/` was excluded deliberately. Its queries reference columns this database
does not have — `order_created_at`, `distributor_id`, `route_id`, `company_id`,
`user_business_name` — and its domain is distributors, routes and crates. It
targets a grocery-distribution schema, not this food-delivery one, and would
fail on its first query here. Migrating it would mean inventing a schema to
match, not porting behaviour.

## Architecture

The PHP panel rendered HTML server-side with a direct MySQL connection. A React
SPA cannot do that, so every screen became a JSON endpoint under `/admin/*` in
this backend — which already owns the database connection the mobile apps use.

One database, three clients:

```
MFB-ADMIN-PANEL ─┐
customer app     ├─► MFB-MOBILE-APP-BACKEND ─► MySQL
delivery app     ─┘
```

## Auth

`middlewares/verifyAdmin.js` + `controllers/admin/auth.js`.

Credentials are unchanged so no one is locked out: sign in with `user_email` or
`user_phone` against `store_users.user_password`, and only roles 0/1/2 may
enter — the same rule `Index::loginUser` applied. The CodeIgniter session and
`logged_in` cookie are replaced by a JWT with `scope: "admin_panel"`, signed
with the existing `JWT_SECRET_KEY`.

> ⚠️ **Passwords are stored in plaintext.** `User_Model::_Login` compared them
> with a direct `WHERE user_password = '...'`, and the migration preserves that
> comparison rather than locking every existing admin out. This should move to
> bcrypt: hash on next successful login, then drop the plaintext path. It was
> not changed here because doing so is a data migration, not a port.

## Endpoint map

| PHP action | Endpoint |
| --- | --- |
| `Index::loginUser` | `POST /admin/auth/login` |
| (session restore) | `GET /admin/auth/me` |
| `Profile::Logout` | `POST /admin/auth/logout` |
| `Profile::Password` | `PUT /admin/auth/password` |
| `Admin::Index` | `GET /admin/dashboard` |
| `Orders::Index` | `GET /admin/orders` |
| `Orders::OrderDetails` + `OrderAddress` | `GET /admin/orders/:id` |
| `Orders::OrderUpdate` | `PUT /admin/orders/:id/status` |
| `Orders::paymentUpdate` | `PUT /admin/orders/:id/payment` |
| `Orders::Reports` | `GET /admin/orders/reports` |
| `Products::Index` | `GET /admin/products`, `PUT /admin/products/:id` |
| `Categories::Index` | `GET/POST /admin/categories`, `PUT /admin/categories/:id` |
| `Users::Customers` / `Vendor::Index` / `Rider::Index` | `GET /admin/people/:group` |
| (user detail) | `GET /admin/people/detail/:id` |
| `Ajax::Status` | `PUT /admin/people/:id/status` |
| `Vendor::storeClose` | `PUT /admin/vendors/:id/store` |

## Also added here

- `models/category.js` (`store_categories`) and `models/user_bank.js`
  (`store_users_bank`) — both tables existed but had no Sequelize model.
- CORS in `app.js`, allow-listing the panel's origin via `ADMIN_PANEL_ORIGINS`
  (defaults to the Vite dev server). The mobile apps are native and unaffected.

## Now migrated

| PHP action | Endpoint / page |
| --- | --- |
| `Index::Register` | `POST /admin/auth/register` → `pages/Recover.tsx` |
| `Index::VerifyOTP` / `validOTP` | `POST /admin/auth/verify-otp` |
| `Index::ForgotPassword` | `POST /admin/auth/forgot-password` |
| `Index::ResetPassword` | `POST /admin/auth/reset-password` |
| `Profile::Index` (basic/business/bank/areas) | `GET /admin/profile`, `PUT /admin/profile/{basic,business,areas}` → `pages/Profile.tsx` |
| `Profile::Password` | `PUT /admin/auth/password` (Password tab) |
| `Profile::AdminLogin` | `POST /admin/profile/impersonate/:id` |
| `Notifications::orderReceived` | `POST /admin/notifications/order-received/:orderId` |
| `Ajax::uploadFiles` / `removeImage` | `POST/DELETE /admin/uploads`, `PUT /admin/uploads/attach` |
| `Vendor::*` / `Rider::*` | `/admin/portal/*` → `pages/portal/PortalPages.tsx` |
| `Users::Index?action=create` | `POST /admin/users` → `pages/Users.tsx` |
| `Orders::OrderUpdate` (rider branch) | `PUT /admin/orders/:id/status` with `rider_id` → rider picker in `pages/OrderDetail.tsx` |
| `Orders::OrderUpdate` (qty branch) | `PUT /admin/orders/:id/items/:detailId` |
| `Orders::InvoiceProductAdd` | `POST /admin/orders/:id/items` + `GET /admin/orders/:id/catalogue` |
| `Orders::OrderAddress` | `PUT /admin/orders/:id/address` |
| `Ajax::Status` (cashback settlement) | folded into `PUT /admin/orders/:id/status` |
| `Categories::Index` (store_menu) | `/admin/menus/*` → `pages/Cuisines.tsx` |
| `Settings::Index` (banners) | `/admin/banners` → `pages/Banners.tsx` |
| `Products::Index` (full form) | `POST/GET/PUT/DELETE /admin/products` → `pages/Products.tsx` |
| `Vendor::Products` / `Settings::Products` | `GET /admin/products/search` + `POST /admin/products/copy` |
| `Profile::Index/:id` (edit another user) | `pages/PersonDetail.tsx`, reusing `Profile.tsx` with a `userId` |
| `Users::Customers?action=create` | role 12 added to `POST /admin/users` |

### Things the PHP wrote but never showed

**`store_orders_log`.** `Orders::OrderUpdate` appended a row on every status
change and no screen ever read it back. `GET /admin/orders/:id` now returns it
as `timeline`, and the order page draws it — same data, finally visible.

**Cashback.** `Ajax::Status` settled `store_users_cashback` into
`store_users.user_cashback` when an order reached status 3. That is back in
`orders.updateStatus` — but read the caveat, because it does **not** mean
cashback starts paying out again:

- The settlement only credits rows at `cashback_status` 0 (pending).
  `Ajax::Status` re-credited *every* row for the order, so already-settled
  referral bonuses were paid again on each trip through status 3. That was a
  double-credit bug; this version is idempotent.
- Nothing currently creates a pending row. The only insert still running is the
  referral bonus in `store/User_Model.php`, which writes at `cashback_status` 1
  and credits the wallet immediately. The order-time insert in
  `store/Store_Model.php` is **commented out**. So order cashback has not worked
  in the PHP either for as long as that comment has been there.

The settlement is wired up so re-enabling that insert is all it takes. Deciding
whether order cashback should come back is a product call, not a migration one.

### Bugs in the PHP found while porting — deliberately NOT reproduced

**`Profile::Password` locked accounts out.** It wrote `md5($password)` while
`User_Model::_Login` compared `user_password` in plaintext, so any staff member
who changed their password through the panel could never sign in again. All
password writes here stay plaintext, consistent with how login reads them.

**`Ajax::uploadFiles` never ran.** Its second statement was
`echo "<pre>"; print_r($_POST); exit;`, and it wrote to `vehicles` /
`vehicles_files` — tables copy-pasted from another project that do not exist in
this schema. The replacement writes to the storage actually in use:
`MFB_PHP_ADMIN_PANEL/admin/assets/uploads/<kind>/{webp,jpg}/`, the same
directories `Products_Model`, `Settings::Products` and the mobile apps' asset
URLs already read from. Configurable via `UPLOADS_ROOT`.

**OTPs could not be self-generated.** The PHP created a 6-digit code, stored it
in `store_users.user_otp` and texted it. This backend's providers (Twilio Verify,
MSG91) generate and hold the code themselves, so registration and reset verify
against `util/otp.js` instead — the same path the mobile apps use, which honours
`OTP_DEV_MODE` and `OTP_DEV_NUMBERS`. Note: OTPless keys verification off a
`requestId`; `user_otp` is `varchar(6)` and cannot hold one, so switching
`MSGPROVIDER` to otpless would need a column for it.

**A vendor has three switches, not one.** `store_users` carries three
independent flags and the PHP vendors list drew a toggle for each. An earlier
version of this migration collapsed them into one and wrote the wrong column:

| Column | Means | Read by |
| --- | --- | --- |
| `user_status` | the account; 2 is disabled | the panel |
| `user_active` | whether the vendor is listed **at all** | `controllers/products.js` drops the vendor from the app listing when falsy |
| `user_login` | whether the store is **open right now** | the customer app's `helpers/utils.js` `isShopOpen` |

`business_status` is **not** a switch. The PHP panel only ever read it, adding
it to `bank_status` to draw an onboarding battery icon (empty / half / full).
Writing it both destroys that signal and delists the vendor, because
`products.js` filters the whole listing on `business_status: true` — so the old
"Close store" button made a restaurant vanish from the app instead of showing it
as closed, and "Open store" could not undo it. Store open/close now writes
`user_login`, `user_active` has its own control, and the onboarding score is
surfaced read-only.

**`store_categories` is not `store_menu`.** The panel's original Categories page
read `store_categories` — a flat `cat_id` / `cat_name` table. `Categories::Index`
worked on `store_menu`, which is hierarchical, per-vendor, carries SEO fields and
is what the storefront actually navigates. That was a like-named substitution,
not a migration. `pages/Cuisines.tsx` now covers the real thing (cuisines at
`menu_type` 0, vendor categories at `menu_type` 1, nested through
`menu_parent_id`), and products link to it through `store_products_menu`. The
`store_categories` page is left in place because nothing has confirmed which
table the storefront reads today — deleting it is a separate decision.

## Not migrated

| Feature | Why |
| --- | --- |
| `Settings::ImageBackup` / `DBBackup` | A web request that zips 311 MB of uploads or dumps the whole database is a denial-of-service and an exfiltration path; `scripts/clone-db-to-dev.sh` covers the database case properly |
| `Admin::Expenses` | No expenses table exists in this schema, and the PHP loaded a view file that does not exist — the action was already broken |

Everything else `administration/` could do is reachable from the React panel.
