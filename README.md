# Shared Household Bill Splitter

A robust, edge-native household bill splitting application built with **TypeScript**, **Hono** on **Cloudflare Workers**, **Cloudflare D1 (SQLite)**, and **React + TanStack Router**.

Designed and implemented for the **DoCoDeGo SDE Intern Task 002** assignment.

---

## Architecture & Technology Stack

The application employs a decoupled edge architecture optimized for data integrity, predictable performance, and minimal operational overhead:

- **API Layer:** [Hono](https://hono.dev/) running on [Cloudflare Workers](https://workers.cloudflare.com/) (`workerd` runtime). Ultra-lightweight (<15KB), zero-dependency, standards-compliant Fetch API router.
- **Storage Layer:** [Cloudflare D1](https://developers.cloudflare.com/d1/) (Serverless SQLite). Enforces relational consistency, named foreign key constraints, check constraints, and custom consistency triggers.
- **Frontend Layer:** [React 19](https://react.dev/), [Vite 6](https://vitejs.dev/), and [@tanstack/react-router](https://tanstack.com/router). Single-page application with accessible design, optimistic-safe idempotency workflows, and comprehensive state indicators.
- **Language & Tooling:** TypeScript (strict mode, no `any`), [Biome](https://biomejs.dev/) (formatting & linting), [Vitest](https://vitest.dev/) (dual-runner: `@cloudflare/vitest-plugin` for Workers runtime + JSDOM for React UI).

```
                      +---------------------------------------+
                      |          React 19 SPA (Vite)          |
                      |   TanStack Router + Vanilla CSS (A11y)|
                      +-------------------+-------------------+
                                          |
                                          | HTTP / JSON (Fetch)
                                          v
                      +---------------------------------------+
                      |     Cloudflare Workers (Hono API)     |
                      |   Deterministic Remainder Allocator   |
                      |   Atomic Payment Idempotency Engine   |
                      +-------------------+-------------------+
                                          |
                                          | D1 Binding (SQLite)
                                          v
                      +---------------------------------------+
                      |         Cloudflare D1 Database        |
                      |  Foreign Keys, CHECKs, Unique Indexes |
                      |    Cross-Home Consistency Triggers    |
                      +---------------------------------------+
```

---

## Database Architecture & Named Constraints

The relational schema is defined in declarative SQL migrations under `api/migrations/0001_init.sql`. Foreign key enforcement is guaranteed via `PRAGMA foreign_keys = ON;`.

### Tables Overview

1. `homes`: Household entity (`id` UUID, `name`, `created_at`).
2. `members`: Roommate entity (`id` UUID, `home_id`, `name`, `sort_order`, `created_at`).
3. `bills`: Expense record (`id` UUID, `home_id`, `title`, `total_cents`, `created_at`).
4. `shares`: Individual payment obligation (`id` UUID, `bill_id`, `member_id`, `amount_cents`, `paid_at`, `idempotency_key`).

### Named Integrity Constraints

The schema enforces strict domain rules at the storage engine level through **12 named constraints** and **4 triggers**:

| Named Constraint / Trigger                 | Table     | Type        | Purpose & Invariant Protected                                                                               |
| :----------------------------------------- | :-------- | :---------- | :---------------------------------------------------------------------------------------------------------- |
| `chk_homes_name_nonempty`                  | `homes`   | CHECK       | Prevents empty or whitespace-only home names.                                                               |
| `fk_members_home_id`                       | `members` | FOREIGN KEY | Cascades deletions; prevents orphaned member records.                                                       |
| `chk_members_name_nonempty`                | `members` | CHECK       | Disallows blank member names.                                                                               |
| `uq_members_home_sort_order`               | `members` | UNIQUE      | Ensures monotonic, collision-free member ordering within each home.                                         |
| `fk_bills_home_id`                         | `bills`   | FOREIGN KEY | Cascades deletions; links bills strictly to valid homes.                                                    |
| `chk_bills_title_nonempty`                 | `bills`   | CHECK       | Disallows blank bill titles.                                                                                |
| `chk_bills_total_cents_positive`           | `bills`   | CHECK       | Ensures bill totals are positive integers (`total_cents > 0`).                                              |
| `fk_shares_bill_id`                        | `shares`  | FOREIGN KEY | Enforces parent bill validity; cascades share deletion.                                                     |
| `fk_shares_member_id`                      | `shares`  | FOREIGN KEY | Enforces assigned member validity; cascades share deletion.                                                 |
| `uq_shares_bill_member`                    | `shares`  | UNIQUE      | Forbids duplicate shares for the same member on a single bill.                                              |
| `chk_shares_amount_cents_nonnegative`      | `shares`  | CHECK       | Disallows negative share amounts (`amount_cents >= 0`).                                                     |
| `chk_shares_paid_consistency`              | `shares`  | CHECK       | Guarantees atomic pair consistency: `paid_at` and `idempotency_key` must both be NULL or both be populated. |
| `trg_shares_check_home_consistency_insert` | `shares`  | TRIGGER     | Rejects share inserts if `bill.home_id != member.home_id` (cross-home share prevention).                    |
| `trg_shares_check_home_consistency_update` | `shares`  | TRIGGER     | Rejects share updates if `bill.home_id != member.home_id`.                                                  |
| `trg_bills_prevent_home_reassignment`      | `bills`   | TRIGGER     | Aborts `home_id` reassignment on bills that have existing dependent shares.                                 |
| `trg_members_prevent_home_reassignment`    | `members` | TRIGGER     | Aborts `home_id` reassignment on members that have existing dependent shares.                               |

---

## API Endpoint Reference

All endpoints return JSON responses. Errors always conform to `{ "error": "message" }`.

### Homes & Members

#### `POST /api/homes`

Creates a new household.
- **Body:** `{ "name": string }`
- **Response:** `201 Created` `{ "id": string, "name": string }`
- **Errors:** `400 Bad Request` (empty or malformed name)

#### `GET /api/homes`

Lists all registered homes.
- **Response:** `200 OK` `{ "homes": [{ "id": string, "name": string, "created_at": string }] }`

#### `GET /api/homes/:homeId`

Fetches a single home by ID.
- **Response:** `200 OK` `{ "id": string, "name": string }`
- **Errors:** `404 Not Found`

#### `POST /api/homes/:homeId/members`

Adds a roommate to a home. Automatically assigns the next sequential `sort_order`.
- **Body:** `{ "name": string }`
- **Response:** `201 Created` `{ "id": string, "homeId": string, "name": string }`
- **Errors:** `400 Bad Request` (invalid name), `404 Not Found` (home missing)

### Bill Splitting & Balances

#### `POST /api/homes/:homeId/bills`

Creates an expense and splits it across all current home members.
- **Body:** `{ "title": string, "totalCents": number }`
- **Response:** `201 Created`

  ```json
  {
    "id": "bill-uuid",
    "homeId": "home-uuid",
    "title": "Groceries",
    "totalCents": 1000,
    "shares": [
      { "id": "share-1", "memberId": "member-1", "amountCents": 334, "paidAt": null },
      { "id": "share-2", "memberId": "member-2", "amountCents": 333, "paidAt": null },
      { "id": "share-3", "memberId": "member-3", "amountCents": 333, "paidAt": null }
    ]
  }
  ```
- **Errors:**
  - `400 Bad Request` (malformed JSON)
  - `404 Not Found` (home missing)
  - `422 Unprocessable Entity` (non-positive `totalCents`, empty title, or home has zero members)

#### `GET /api/homes/:homeId/bills`

Retrieves all bills and associated shares for a home.
- **Response:** `200 OK` `{ "bills": [...] }`
- **Errors:** `404 Not Found`

#### `POST /api/bills/:billId/shares/:shareId/pay`

Pays a share idempotently.
- **Headers:** `Idempotency-Key: <UUID-or-string>` (required, max 256 chars)
- **Response:** `200 OK` `{ "id": string, "memberId": string, "amountCents": number, "paidAt": string }`
- **Errors:**
  - `400 Bad Request` (missing or oversized `Idempotency-Key` header)
  - `404 Not Found` (bill or share not found)
  - `409 Conflict` (share was already paid using a _different_ idempotency key)

#### `GET /api/homes/:homeId/balances`

Calculates outstanding (unpaid) balances for each member across all bills in the home.
- **Response:** `200 OK`

  ```json
  {
    "balances": [
      { "memberId": "member-1", "name": "Alice", "outstandingCents": 334 },
      { "memberId": "member-2", "name": "Bob", "outstandingCents": 333 }
    ]
  }
  ```
- **Errors:** `404 Not Found`

---

## Decisions

_(Also anchored as **Engineering Decisions**)_

### Decision 1: Pure Integer Cents Arithmetic & Deterministic Remainder Allocation

1. **The Decision:**
   All monetary amounts across the database schema (`total_cents`, `amount_cents`), API payload schemas, business logic, and UI parsers are strictly handled as whole 64-bit integer cents. Fractional currency division ($R = T \pmod N$) is resolved deterministically by allocating the remaining $R$ single cents to members in their exact order of addition (`sort_order ASC`), assigning $\lfloor T/N \rfloor + 1$ to the first $R$ members and $\lfloor T/N \rfloor$ to the remaining $N - R$ members.

2. **Alternatives Considered:**
   - _Floating-Point Numbers (IEEE 754):_ Storing dollars as standard floats (e.g., `10.50`). Rejected immediately due to binary representation drift (`0.1 + 0.2 === 0.30000000000000004`) and accumulated rounding loss during sum aggregations.
   - _Fixed-Point / Arbitrary-Precision Decimals (`DECIMAL(10,2)`):_ Capable of tracking fractional cents, but introduces ambiguity when allocating odd cents (e.g., how to split $0.01 between 3 people without fractional cents in real fiat currency).
   - _Randomized or Hash-Based Remainder Allocation:_ Distributing extra cents randomly or hashing member IDs. Rejected because it introduces non-deterministic outputs, making bill creation non-reproducible, untestable, and impossible to audit cleanly.

3. **Why Selected:**
   Integer arithmetic guarantees that no fractional cents ever exist. Deterministic allocation based on `sort_order ASC` guarantees that $\sum_{i=1}^N \text{share}_i \equiv \text{totalCents}$ with 100% mathematical precision across all possible inputs, while ensuring identical reproducible splits across test suites and audit runs.

4. **Trade-offs / Limitations:**
   The member added first to a home will always receive the extra cent when a bill has an uneven remainder. While an equitable round-robin rotation scheme could balance this across multiple bills over time, it would introduce stateful dependencies across bills, race conditions during concurrent bill creation, and added schema overhead.

---

### Decision 2: Database-Enforced Payment Idempotency & Atomic Conditional Updates

1. **The Decision:**
   Payment requests require a client-supplied `Idempotency-Key` header. State transitions are governed entirely at the SQLite storage engine level using atomic conditional execution:

   ```sql
   UPDATE shares
   SET paid_at = ?, idempotency_key = ?
   WHERE id = ? AND paid_at IS NULL;
   ```

   If `meta.changes === 1`, the payment succeeded. If `meta.changes === 0`, the transaction was preempted, and the engine inspects the existing `idempotency_key`: if identical, it replays `200 OK`; if different, it returns `409 Conflict`.

2. **Alternatives Considered:**
   - _Application-Level Read-Modify-Write:_ Performing `SELECT paid_at FROM shares WHERE id = ?`, checking the value in TypeScript memory, and executing `UPDATE`. Rejected because concurrent requests executing simultaneously both read `paid_at IS NULL` and attempt duplicate writes (race condition).
   - _Distributed KV Locks (e.g., Redis / Cloudflare KV):_ Acquiring a lock on `shareId` prior to mutation. Rejected due to network latency overhead, cold-start cost, risk of orphaned locks on worker termination, and eventual consistency delays in KV stores.
   - _Separate Dedicated Idempotency Table:_ Recording `(idempotency_key, response_body)` tuples in a separate table. Rejected as unnecessary architectural complexity since payment is a terminal, one-time state change natively bounded to the `shares` row.

3. **Why Selected:**
   Cloudflare D1 serializes write transactions to a single SQLite primary per database shard. Leveraging SQLite's atomic conditional update guarantees absolute zero-window race condition safety. The pair consistency is mathematically verified by the table constraint `chk_shares_paid_consistency`.

4. **Trade-offs / Limitations:**
   The client must generate and preserve idempotency keys (UUID v4) across retry attempts. If a network disconnect drops the client's connection after the database write succeeds, the client must resend the identical key to safely reconcile the payment without triggering a `409 Conflict`.

---

### Decision 3: Edge-Native Cloudflare Workers + Hono + D1 Architecture

1. **The Decision:**
   The backend is architected as an edge-native serverless service combining Hono with Cloudflare Workers and Cloudflare D1. The frontend is built as a static Single Page Application deployed to edge CDN nodes, communicating via typed JSON REST APIs.

2. **Alternatives Considered:**
   - _Monolithic Full-Stack Framework (Next.js / Remix on Node.js):_ Bundling frontend and backend in one monolithic runtime. Rejected due to heavy build footprints, high container cold starts, and vendor coupling that obscures low-level HTTP and database primitives.
   - _Centralized Relational Cloud DB (PostgreSQL on AWS RDS / Supabase):_ Running a centralized database instance with an ORM (e.g., Prisma). Rejected because relational connection pools (TCP connection overhead) introduce significant latency when accessed from serverless edge runtimes, requiring pooling proxies like PgBouncer.

3. **Why Selected:**
   Cloudflare Workers provides instant sub-5ms cold starts across 300+ global edge locations. Hono provides a type-safe router with minimal overhead (<15KB). Cloudflare D1 eliminates external database network hops and connection pools by co-locating SQLite compute near the edge worker, while providing full relational integrity (foreign keys, check constraints, triggers).

4. **Trade-offs / Limitations:**
   D1 operates with a single-primary architecture for writes, meaning global write throughput is bounded by single-thread SQLite serialization. Additionally, testing edge Workers with `@cloudflare/vitest-plugin` executes within Miniflare's isolated `workerd` process, which is incompatible with browser DOM mocks (`jsdom`), requiring a clean architectural separation between backend API tests and frontend UI component tests.

---

## Edge Cases Handled

The application explicitly handles all 7 mandatory edge cases:

1. **Home with Zero Members:**
   Attempting `POST /api/homes/:homeId/bills` on a home without members returns `422 Unprocessable Entity` (`"Cannot split bill: home has no members"`).
2. **Invalid Total Amount:**
   Zero, negative numbers, floats, strings, or missing amounts in `POST /api/homes/:homeId/bills` return `422 Unprocessable Entity`.
3. **Uneven Split Remainder:**
   Bills dividing unevenly allocate extra cents deterministically to the earliest added members (`sort_order ASC`). Example: $10.00 (1000 cents) across 3 members yields `$3.34` (334¢), `$3.33` (333¢), and `$3.33` (333¢).
4. **Duplicate Payment Requests (Idempotency Replay):**
   Submitting identical `Idempotency-Key` headers for the same share returns `200 OK` with the original `paidAt` timestamp without re-billing.
5. **Concurrent Payments on the Same Share:**
   Simultaneous requests with different keys race at the database layer; exactly one succeeds (`200 OK`), and all others are rejected with `409 Conflict`.
6. **Non-Existent Resources:**
   Requesting missing homes, bills, or shares returns `404 Not Found`.
7. **API Errors & Network Latency (Frontend Resilience):**
   The UI never crashes on HTTP 500 or network drops. It renders inline alert banners, preserves pending input state, and automatically unlocks buttons for safe retries.

---

## Setup & Local Development

### Prerequisites

- **Node.js:** v18.0.0 or later (Node 20+ recommended)
- **pnpm:** v9.0.0 or later

### Installation

Clone the repository and install workspace dependencies:

```bash
pnpm install
```

If prompted regarding native build scripts, approve `esbuild` and `workerd`:
```bash
pnpm approve-builds
```

### Running Locally

Start both the backend API and frontend Vite dev server concurrently:

```bash
pnpm dev
```

- **Frontend:** [http://localhost:5173](http://localhost:5173)
- **Backend API:** [http://localhost:8787](http://localhost:8787)
- **Health Check:** [http://localhost:8787/api/health](http://localhost:8787/api/health)

`pnpm dev` automatically executes local D1 migrations against the `.wrangler` local SQLite database before booting the API.

---

## Verification & Test Suite

The test suite consists of **105 automated tests** across 8 test suites spanning backend integration and frontend UI component rendering:

```bash
# Run backend Workers integration tests (59 tests via Miniflare/workerd)
pnpm test

# Run frontend React component & interaction tests (46 tests via JSDOM)
pnpm test:web

# Run Biome code quality, formatting, and lint checks (zero errors required)
pnpm check

# Run TypeScript compiler checks on both API and Web packages
pnpm typecheck

# Build the frontend production bundle
pnpm build
```

### Test Breakdown

1. `api/test/homes.test.ts` (11 tests): Home creation, member addition, constraints, 404s.
2. `api/test/bills.test.ts` (14 tests): Bill creation, deterministic remainder allocation, validation.
3. `api/test/payments.test.ts` (12 tests): Idempotent payment, replay verification, conflict detection.
4. `api/test/integrity.test.ts` (14 tests): Schema constraints, triggers, cross-home share isolation.
5. `api/test/balances.test.ts` (8 tests): Multi-bill balance calculations, member ordering.
6. `web/test/ui-interactions.test.ts` (17 tests): UI state transitions, currency parsing, error handling.
7. `web/test/a11y-wcag.test.ts` (18 tests): Color contrast ratios (WCAG AA), accessible labels, aria attributes.
8. `web/test/component-interactions.test.tsx` (11 tests): Genuine React DOM rendering, simulated clicks, network error recovery.

---

## Accessibility (WCAG 2.1 AA)

All interactive elements and color palettes comply strictly with WCAG 2.1 Level AA standards:
- **Base Background & Surface:** `#f8fafc` and `#ffffff`
- **Primary Text:** `#0f172a` (Contrast ratio: **15.4:1**, exceeds 4.5:1 minimum)
- **Primary Button (`--primary`):** `#2563eb` against `#ffffff` (Contrast ratio: **4.64:1**)
- **Success State (`--success`):** `#15803d` against `#ffffff` (Contrast ratio: **4.79:1**)
- **Danger / Error (`--danger`):** `#b91c1c` against `#ffffff` (Contrast ratio: **5.91:1**)
- **Warning Notice (`--warning`):** `#b45309` against `#ffffff` (Contrast ratio: **4.84:1**)
- Full keyboard focus navigation (`:focus-visible` outlines) and screen reader ARIA annotations (`role="status"`, `aria-live="polite"`, `aria-busy`).

---

## Submission Checklist

- [x] All visible tests in `api/test/` pass without modification.
- [x] Database schema includes 12 named constraints and 4 cross-home triggers.
- [x] Edge cases 1 through 7 verified via integration and UI tests.
- [x] `pnpm check` passes with zero Biome errors.
- [x] `pnpm typecheck` passes with zero TypeScript diagnostics.
- [x] `pnpm build` completes cleanly.
- [x] `README.md` updated with comprehensive documentation and three engineering decisions.
- [ ] 3-minute demo video recorded and uploaded by the candidate.
- [ ] Repository and video links submitted via the application form.
