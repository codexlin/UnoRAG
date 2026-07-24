export function runOutboxMutation<TTransaction, TResult>(
	database: {
		transaction<T>(
			callback: (transaction: TTransaction) => Promise<T>,
		): Promise<T>;
	},
	mutate: (transaction: TTransaction) => Promise<TResult>,
	enqueue: (
		transaction: TTransaction,
		result: TResult,
	) => Promise<unknown>,
): Promise<TResult>;
