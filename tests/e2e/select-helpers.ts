import { expect, type Locator } from "@playwright/test";

export async function chooseSelect(trigger: Locator, label: string) {
	await expect(trigger).toBeEnabled();
	await trigger.click();
	await trigger
		.page()
		.getByRole("option", { name: label, exact: true })
		.click();
}
