import { defineConfig } from "drizzle-kit";

const databaseUrl =
	process.env.DATABASE_URL ??
	"postgresql://meriknow:meriknow@localhost:5432/meriknow";

export default defineConfig({
	dialect: "postgresql",
	schema: "./src/db/schema.ts",
	out: "./drizzle",
	dbCredentials: {
		url: databaseUrl,
	},
	strict: true,
	verbose: true,
});
