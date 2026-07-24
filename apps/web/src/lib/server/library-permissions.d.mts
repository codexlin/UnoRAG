import type { AuthIdentity } from "./auth/provider";

export function canManageLibraries(identity: AuthIdentity): boolean;
export function canWriteLibraries(identity: AuthIdentity): boolean;
