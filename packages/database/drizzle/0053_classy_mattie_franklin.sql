CREATE TABLE "memory_consolidation_evidence" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"action" text NOT NULL,
	"memory_id" integer,
	"source_message_ids" integer[] NOT NULL,
	"participant_ids" bigint[] NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_consolidation_state" (
	"bot_id" uuid PRIMARY KEY NOT NULL,
	"cursor_message_id" integer DEFAULT 0 NOT NULL,
	"lease_owner" uuid,
	"lease_until" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_consolidation_evidence" ADD CONSTRAINT "memory_consolidation_evidence_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_consolidation_evidence" ADD CONSTRAINT "memory_consolidation_evidence_memory_id_bot_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."bot_memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_consolidation_state" ADD CONSTRAINT "memory_consolidation_state_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_consolidation_evidence_bot_chat_idx" ON "memory_consolidation_evidence" USING btree ("bot_id","chat_id");--> statement-breakpoint
CREATE INDEX "memory_consolidation_evidence_memory_idx" ON "memory_consolidation_evidence" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX "memory_consolidation_evidence_source_gin_idx" ON "memory_consolidation_evidence" USING gin ("source_message_ids");--> statement-breakpoint
CREATE INDEX "memory_consolidation_evidence_participant_gin_idx" ON "memory_consolidation_evidence" USING gin ("participant_ids");--> statement-breakpoint
-- Raw history has a shorter retention period than long-term memory. Keep the
-- source IDs and participants as durable provenance for surviving memories.
-- An ignored batch has no memory to preserve, so its evidence can expire with
-- any deleted source message.
CREATE FUNCTION purge_consolidation_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM memory_consolidation_evidence
    WHERE bot_id = OLD.bot_id AND action = 'ignore' AND memory_id IS NULL
      AND source_message_ids @> ARRAY[OLD.id];
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER purge_consolidation_source_after_delete
  AFTER DELETE ON conversation_messages FOR EACH ROW EXECUTE FUNCTION purge_consolidation_source();
--> statement-breakpoint
-- A direct personal-memory deletion (including /privacy forget) also removes
-- its evidence. This runs before the nullable FK can SET NULL.
CREATE FUNCTION purge_consolidation_memory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM memory_consolidation_evidence WHERE memory_id = OLD.id;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER purge_consolidation_memory_before_delete
  BEFORE DELETE ON bot_memories FOR EACH ROW EXECUTE FUNCTION purge_consolidation_memory();
--> statement-breakpoint
CREATE FUNCTION purge_consolidation_privacy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.mode = 'off' OR NEW.mode = 'isolated' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.bot_id::text || ':' || NEW.user_id::text, 0));
    -- Shared group episodes may include other people. Stop recalling them,
    -- but do not silently hard-delete their shared record or provenance.
    UPDATE bot_memories SET is_active = false, updated_at = now()
    WHERE is_active = true AND id IN (
      SELECT memory_id FROM memory_consolidation_evidence
      WHERE bot_id = NEW.bot_id AND participant_ids @> ARRAY[NEW.user_id]
        AND chat_id <> NEW.user_id AND memory_id IS NOT NULL
    );
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER purge_consolidation_privacy_after_change
  AFTER INSERT OR UPDATE OF mode ON user_privacy_settings
  FOR EACH ROW EXECUTE FUNCTION purge_consolidation_privacy();
--> statement-breakpoint
CREATE FUNCTION guard_consolidation_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  participant bigint;
BEGIN
  IF cardinality(NEW.source_message_ids) = 0 OR cardinality(NEW.participant_ids) = 0 THEN
    RAISE EXCEPTION 'consolidation evidence requires sources and participants';
  END IF;
  FOR participant IN SELECT DISTINCT unnest(NEW.participant_ids) ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.bot_id::text || ':' || participant::text, 0));
    IF EXISTS (
      SELECT 1 FROM user_privacy_settings
      WHERE bot_id = NEW.bot_id AND user_id = participant
        AND (mode = 'off' OR (mode = 'isolated' AND NEW.chat_id <> participant))
    ) THEN
      RAISE EXCEPTION 'consolidation privacy denied';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guard_consolidation_evidence_before_insert
  BEFORE INSERT ON memory_consolidation_evidence
  FOR EACH ROW EXECUTE FUNCTION guard_consolidation_evidence();
