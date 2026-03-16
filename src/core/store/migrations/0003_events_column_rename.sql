ALTER TABLE events RENAME COLUMN event_type TO type;
ALTER TABLE events RENAME COLUMN actor_type TO actor;
ALTER TABLE events DROP COLUMN actor_name;
