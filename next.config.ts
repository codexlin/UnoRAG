import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	// Required for deploy/docker/web.Dockerfile (Next standalone output).
	output: "standalone",
};

export default nextConfig;
