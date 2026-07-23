-- Stable, unique volume lineage identity. `generation` is only an epoch counter,
-- seeded to 1 in every fresh volume, so two genuinely different server volumes
-- are indistinguishable and a client can reuse cursors minted against another
-- volume. `lineage_id` answers "is this the SAME volume?" (vs generation's "has
-- THIS volume been reset?"): a random per-DO id the handshake surfaces so a client
-- that observes a different one re-bootstraps instead of diverging.
--
-- randomblob() runs per-DO, so each volume mints its own id. The backfill also
-- covers volumes migrated before this column existed (0004 already inserted the
-- id = 1 row, so this UPDATE stamps both fresh and pre-existing volumes).
ALTER TABLE fs_generation ADD COLUMN lineage_id TEXT;

UPDATE fs_generation SET lineage_id = lower(hex(randomblob(16))) WHERE id = 1 AND lineage_id IS NULL;
