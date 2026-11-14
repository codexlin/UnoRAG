"use client";

import { useSyncExternalStore } from "react";
import {
	APPEARANCE_STORAGE_KEY,
	type Appearance,
	DEFAULT_APPEARANCE,
	parseAppearance,
} from "@/lib/appearance";

let snapshot: Appearance | undefined;
const listeners = new Set<() => void>();

function applyAppearance(value: Appearance) {
	document.documentElement.dataset.colorTheme = value.color;
	document.documentElement.dataset.radius = String(value.radius);
	document.documentElement.style.setProperty("--radius", `${value.radius}px`);
}

function readAppearance() {
	try {
		return parseAppearance(window.localStorage.getItem(APPEARANCE_STORAGE_KEY));
	} catch {
		return snapshot ?? DEFAULT_APPEARANCE;
	}
}

function publish(value: Appearance) {
	applyAppearance(value);
	if (snapshot?.color === value.color && snapshot.radius === value.radius)
		return;
	snapshot = value;
	for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
	if (
		(event.key === APPEARANCE_STORAGE_KEY || event.key === null) &&
		event.storageArea === window.localStorage
	) {
		publish(parseAppearance(event.newValue));
	}
}

function subscribe(listener: () => void) {
	if (listeners.size === 0) {
		// Reconcile changes made while the appearance controls were unmounted.
		publish(readAppearance());
		window.addEventListener("storage", onStorage);
	}
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) window.removeEventListener("storage", onStorage);
	};
}

function getSnapshot() {
	snapshot ??= readAppearance();
	return snapshot;
}

function getServerSnapshot() {
	return DEFAULT_APPEARANCE;
}

export function setAppearance(patch: Partial<Appearance>) {
	const value = parseAppearance(JSON.stringify({ ...getSnapshot(), ...patch }));
	try {
		window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(value));
	} catch {
		// Keep in-memory controls usable when browser storage is disabled or full.
	}
	publish(value);
}

export function useAppearance() {
	return {
		appearance: useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot),
		setAppearance,
	};
}
