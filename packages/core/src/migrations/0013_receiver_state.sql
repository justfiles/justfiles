-- Reserved for receiver-state rollout. The store tables are backend-owned and are
-- created after host migrations, so sqliteLeasedStore upgrades that private schema
-- when it opens the store.
SELECT 1;
