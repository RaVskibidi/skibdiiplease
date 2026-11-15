-- T77 append-only audit trail.
--
-- Audit history is immutable by contract. The repository layer never exposes
-- update or delete operations, and PostgreSQL enforces the same rule so a bug,
-- ad-hoc query, or future service cannot silently rewrite history.

CREATE OR REPLACE FUNCTION t77_audit_entries_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_entries is append-only (attempted %)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS t77_audit_entries_no_update_delete ON "audit_entries";
CREATE TRIGGER t77_audit_entries_no_update_delete
BEFORE UPDATE OR DELETE ON "audit_entries"
FOR EACH ROW
EXECUTE FUNCTION t77_audit_entries_append_only();

DROP TRIGGER IF EXISTS t77_audit_entries_no_truncate ON "audit_entries";
CREATE TRIGGER t77_audit_entries_no_truncate
BEFORE TRUNCATE ON "audit_entries"
FOR EACH STATEMENT
EXECUTE FUNCTION t77_audit_entries_append_only();
