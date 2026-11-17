CREATE TABLE "user_integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"username" text,
	"access_token_encrypted" text NOT NULL,
	"scopes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_integrations_user_provider_unique" ON "user_integrations" USING btree ("user_id","provider");