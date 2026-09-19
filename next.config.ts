import type { NextConfig } from "next";

const production = process.env.NODE_ENV === "production";
const contentSecurityPolicy = [
	"default-src 'self'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
	"object-src 'none'",
	`script-src 'self' 'unsafe-inline'${production ? "" : " 'unsafe-eval'"}`,
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"font-src 'self' data:",
	`connect-src 'self'${production ? "" : " ws: wss:"}`,
	"worker-src 'self' blob:",
	...(production ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
	{ key: "Content-Security-Policy", value: contentSecurityPolicy },
	{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
	{ key: "X-Content-Type-Options", value: "nosniff" },
	{ key: "X-Frame-Options", value: "DENY" },
	{
		key: "Permissions-Policy",
		value: "camera=(), microphone=(), geolocation=()",
	},
	...(production
		? [
				{
					key: "Strict-Transport-Security",
					value: "max-age=31536000; includeSubDomains",
				},
			]
		: []),
];

const nextConfig: NextConfig = {
	// Required for deploy/docker/web.Dockerfile (Next standalone output).
	output: "standalone",
	poweredByHeader: false,
	async headers() {
		return [
			{
				source: "/api/auth/:path*",
				headers: [{ key: "Cache-Control", value: "no-store" }],
			},
			{ source: "/:path*", headers: securityHeaders },
		];
	},
};

export default nextConfig;
