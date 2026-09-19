import { pgSchema, timestamp } from "drizzle-orm/pg-core";

export const appSchema = pgSchema("app");

export const timestamps = {
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
};
