CREATE TABLE "generation_asset_uses" (
	"generation_id" uuid NOT NULL,
	"asset_id" integer NOT NULL,
	"bot_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "generation_asset_uses_generation_id_asset_id_pk" PRIMARY KEY("generation_id","asset_id")
);
--> statement-breakpoint
ALTER TABLE "generation_asset_uses" ADD CONSTRAINT "generation_asset_uses_generation_id_image_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."image_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_asset_uses" ADD CONSTRAINT "generation_asset_uses_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;