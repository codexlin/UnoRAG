import { Elysia, t } from "elysia";
import {
	characterizeDocumentIR,
	InvalidDocumentIRError,
} from "../../core/document-ir";

export function createCharacterizationApp() {
	return new Elysia({ prefix: "/api/internal/ts-core" })
		.get("/contracts", () => ({
			runtime: "typescript-core",
			documentIr: "document-ir-v1",
			traffic: "characterization-only",
		}))
		.post(
			"/document-ir/validate",
			({ body, set }) => {
				try {
					return {
						ok: true as const,
						result: characterizeDocumentIR(body),
					};
				} catch (error) {
					if (!(error instanceof InvalidDocumentIRError)) throw error;
					set.status = 422;
					return {
						ok: false as const,
						error: "invalid_document_ir",
						issues: error.issues,
					};
				}
			},
			{ body: t.Unknown() },
		);
}
