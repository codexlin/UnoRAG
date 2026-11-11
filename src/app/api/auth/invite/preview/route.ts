import { NextResponse } from "next/server";
import { z } from "zod";

import {
	inviteTokenSchema,
	limitInviteRequest,
	previewInvite,
	readInviteJson,
} from "@/lib/server/invites";

const schema = z.strictObject({ token: inviteTokenSchema });
const privateHeaders = {
	"Cache-Control": "private, no-store",
	"Referrer-Policy": "no-referrer",
};

export async function POST(request: Request) {
	const body = await readInviteJson(request);
	if (body instanceof Response) return body;
	const parsed = schema.safeParse(body);
	if (!parsed.success)
		return NextResponse.json(
			{ detail: "invalid invite parameters" },
			{ status: 400, headers: privateHeaders },
		);
	const limited = await limitInviteRequest(request, "preview");
	if (limited) return limited;
	try {
		const preview = await previewInvite(parsed.data.token);
		return preview
			? NextResponse.json(preview, { headers: privateHeaders })
			: NextResponse.json(
					{ detail: "invite not found" },
					{ status: 404, headers: privateHeaders },
				);
	} catch {
		return NextResponse.json(
			{ detail: "service temporarily unavailable" },
			{ status: 503, headers: privateHeaders },
		);
	}
}
