CREATE TYPE "public"."server_kind" AS ENUM('compose', 'raw-docker');--> statement-breakpoint
CREATE TYPE "public"."server_status" AS ENUM('pending', 'connected', 'unreachable');--> statement-breakpoint
CREATE TABLE "servers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"ssh_user" text DEFAULT 'root' NOT NULL,
	"ssh_port" text DEFAULT '22' NOT NULL,
	"kind" "server_kind" DEFAULT 'compose' NOT NULL,
	"status" "server_status" DEFAULT 'pending' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_error" text,
	"owner_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
