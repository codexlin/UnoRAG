import "server-only";

import { createClient, type RedisClientType } from "redis";

import { logger } from "@/lib/observability";

let clientPromise: Promise<RedisClientType> | undefined;

export async function getSecurityRedisClient(): Promise<RedisClientType> {
	if (!clientPromise) {
		const connecting = (async () => {
			const url = process.env.REDIS_URL?.trim();
			if (!url) throw new Error("REDIS_URL is required for security state");
			const client = createClient({
				url,
				disableOfflineQueue: true,
				socket: { connectTimeout: 2_000 },
			});
			client.on("error", (error) => {
				logger.warn({
					event: "security.redis.error",
					component: "redis",
					error,
				});
			});
			try {
				await client.connect();
			} catch (error) {
				client.destroy();
				throw error;
			}
			return client as RedisClientType;
		})();
		clientPromise = connecting;
		void connecting.catch(() => {
			if (clientPromise === connecting) clientPromise = undefined;
		});
	}
	return clientPromise;
}

export async function closeSecurityRedisForTests(): Promise<void> {
	const pending = clientPromise;
	clientPromise = undefined;
	if (!pending) return;
	const client = await pending.catch(() => undefined);
	if (client?.isOpen) await client.close();
}
