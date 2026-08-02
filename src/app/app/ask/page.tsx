import { Suspense } from "react";

import { AskWorkspace } from "@/components/app/ask-workspace";

export default function AskPage() {
	return (
		<Suspense
			fallback={
				<div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
					加载问答…
				</div>
			}
		>
			<AskWorkspace />
		</Suspense>
	);
}
