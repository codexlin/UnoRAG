export async function runOutboxMutation(database, mutate, enqueue) {
	return database.transaction(async (transaction) => {
		const result = await mutate(transaction);
		await enqueue(transaction, result);
		return result;
	});
}
