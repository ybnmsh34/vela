-- Full-text search over conversation content.
--
-- Offline-first means search is local too: no index is uploaded, nothing is
-- queried remotely. FTS5 is compiled into the bundled SQLite, so this works on
-- a machine with no system SQLite at all.
--
-- The index is kept in step by triggers rather than by application code, so a
-- write path that forgets to reindex cannot exist. `kind` is stored so a caller
-- can tell a hit in the model's answer from a hit in its reasoning — searching
-- your own transcript should not silently rank the model's private thinking as
-- if it were an answer.
CREATE VIRTUAL TABLE message_search USING fts5 (
    body,
    part_id         UNINDEXED,
    message_id      UNINDEXED,
    conversation_id UNINDEXED,
    kind            UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER message_parts_search_insert
AFTER INSERT ON message_parts
WHEN new.kind IN ('text', 'reasoning') AND new.text IS NOT NULL
BEGIN
    INSERT INTO message_search (rowid, body, part_id, message_id, conversation_id, kind)
    VALUES (
        new.id,
        new.text,
        new.id,
        new.message_id,
        (SELECT conversation_id FROM messages WHERE id = new.message_id),
        new.kind
    );
END;

CREATE TRIGGER message_parts_search_delete
AFTER DELETE ON message_parts
BEGIN
    DELETE FROM message_search WHERE rowid = old.id;
END;

CREATE TRIGGER message_parts_search_update
AFTER UPDATE ON message_parts
BEGIN
    DELETE FROM message_search WHERE rowid = old.id;
    INSERT INTO message_search (rowid, body, part_id, message_id, conversation_id, kind)
    SELECT
        new.id,
        new.text,
        new.id,
        new.message_id,
        (SELECT conversation_id FROM messages WHERE id = new.message_id),
        new.kind
    WHERE new.kind IN ('text', 'reasoning') AND new.text IS NOT NULL;
END;

-- Backfill anything written under 0001 before this migration existed. A fresh
-- database selects zero rows here; an upgraded one gets a complete index.
INSERT INTO message_search (rowid, body, part_id, message_id, conversation_id, kind)
SELECT p.id, p.text, p.id, p.message_id, m.conversation_id, p.kind
FROM message_parts p
JOIN messages m ON m.id = p.message_id
WHERE p.kind IN ('text', 'reasoning') AND p.text IS NOT NULL;
