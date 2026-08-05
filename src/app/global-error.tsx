"use client";

import { useEffect } from "react";

export default function GlobalError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		console.error("root_layout_error", error);
	}, [error]);

	return (
		<html lang="zh-CN">
			<body
				style={{
					margin: 0,
					minHeight: "100vh",
					display: "grid",
					placeItems: "center",
					padding: "24px",
					boxSizing: "border-box",
					fontFamily: "system-ui, sans-serif",
					background: "#f7f8f8",
					color: "#172025",
				}}
			>
				<main style={{ width: "100%", maxWidth: "420px" }}>
					<p
						style={{
							margin: 0,
							fontFamily: "monospace",
							fontSize: "12px",
							color: "#b42318",
						}}
					>
						UNORAG · ROOT ERROR
					</p>
					<h1 style={{ margin: "12px 0 0", fontSize: "22px" }}>
						应用未能正常启动
					</h1>
					<p style={{ margin: "10px 0 0", lineHeight: 1.6, color: "#526067" }}>
						请重试。若问题持续出现，请检查 Web 服务日志与数据库连接状态。
					</p>
					<button
						type="button"
						onClick={reset}
						style={{
							marginTop: "20px",
							border: "1px solid #aeb9bd",
							borderRadius: "6px",
							background: "white",
							color: "#172025",
							padding: "9px 14px",
							fontWeight: 600,
							cursor: "pointer",
						}}
					>
						重试
					</button>
				</main>
			</body>
		</html>
	);
}
