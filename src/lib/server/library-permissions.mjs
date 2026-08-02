export function canManageLibraries(identity) {
	return identity.role === "owner" || identity.role === "admin";
}

export function canWriteLibraries(identity) {
	return canManageLibraries(identity) || identity.role === "editor";
}
