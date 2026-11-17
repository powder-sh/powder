CREATE TABLE "app_traffic_stats" (
	"server_id" text NOT NULL,
	"container_name" text NOT NULL,
	"hour_bucket" timestamp with time zone NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"bytes_out" bigint DEFAULT 0 NOT NULL,
	"status_2xx" integer DEFAULT 0 NOT NULL,
	"status_3xx" integer DEFAULT 0 NOT NULL,
	"status_4xx" integer DEFAULT 0 NOT NULL,
	"status_5xx" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "app_traffic_stats_server_id_container_name_hour_bucket_pk" PRIMARY KEY("server_id","container_name","hour_bucket")
);
--> statement-breakpoint
CREATE TABLE "traffic_cursors" (
	"server_id" text PRIMARY KEY NOT NULL,
	"last_processed_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "app_traffic_stats_container_hour_idx" ON "app_traffic_stats" USING btree ("server_id","container_name","hour_bucket");