-- 0001_init.sql
-- Database schema for Shared Household Bill Splitter

PRAGMA foreign_keys = ON;

-- Homes table
CREATE TABLE homes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT chk_homes_name_nonempty CHECK (length(trim(name)) > 0)
);

-- Members table
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT fk_members_home_id FOREIGN KEY (home_id) REFERENCES homes(id) ON DELETE CASCADE,
  CONSTRAINT chk_members_name_nonempty CHECK (length(trim(name)) > 0),
  CONSTRAINT uq_members_home_sort_order UNIQUE (home_id, sort_order)
);

-- Bills table
CREATE TABLE bills (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  title TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT fk_bills_home_id FOREIGN KEY (home_id) REFERENCES homes(id) ON DELETE CASCADE,
  CONSTRAINT chk_bills_title_nonempty CHECK (length(trim(title)) > 0),
  CONSTRAINT chk_bills_total_cents_positive CHECK (total_cents > 0 AND total_cents = CAST(total_cents AS INTEGER))
);

-- Shares table
CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  paid_at TEXT,
  idempotency_key TEXT,
  CONSTRAINT fk_shares_bill_id FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
  CONSTRAINT fk_shares_member_id FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  CONSTRAINT uq_shares_bill_member UNIQUE (bill_id, member_id),
  CONSTRAINT chk_shares_amount_cents_nonnegative CHECK (amount_cents >= 0 AND amount_cents = CAST(amount_cents AS INTEGER)),
  CONSTRAINT chk_shares_paid_consistency CHECK (
    (paid_at IS NULL AND idempotency_key IS NULL) OR
    (paid_at IS NOT NULL AND idempotency_key IS NOT NULL)
  )
);

-- Triggers for cross-home share integrity
CREATE TRIGGER trg_shares_check_home_consistency_insert
BEFORE INSERT ON shares
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'Cross-home share rejected: bill and member belong to different homes')
  WHERE (SELECT home_id FROM bills WHERE id = NEW.bill_id) !=
        (SELECT home_id FROM members WHERE id = NEW.member_id);
END;

CREATE TRIGGER trg_shares_check_home_consistency_update
BEFORE UPDATE OF bill_id, member_id ON shares
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'Cross-home share rejected: bill and member belong to different homes')
  WHERE (SELECT home_id FROM bills WHERE id = NEW.bill_id) !=
        (SELECT home_id FROM members WHERE id = NEW.member_id);
END;

-- Triggers to prevent parent reassignment when dependent shares exist
CREATE TRIGGER trg_bills_prevent_home_reassignment
BEFORE UPDATE OF home_id ON bills
FOR EACH ROW
WHEN OLD.home_id != NEW.home_id AND EXISTS (SELECT 1 FROM shares WHERE bill_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'Cannot reassign bill home_id when shares exist');
END;

CREATE TRIGGER trg_members_prevent_home_reassignment
BEFORE UPDATE OF home_id ON members
FOR EACH ROW
WHEN OLD.home_id != NEW.home_id AND EXISTS (SELECT 1 FROM shares WHERE member_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'Cannot reassign member home_id when shares exist');
END;

-- Indexes for performance
CREATE INDEX idx_members_home_sort ON members(home_id, sort_order);
CREATE INDEX idx_bills_home_id ON bills(home_id);
CREATE INDEX idx_shares_bill_id ON shares(bill_id);
CREATE INDEX idx_shares_member_id ON shares(member_id);
CREATE INDEX idx_shares_idempotency_key ON shares(idempotency_key);
