"use client";

import { useEffect } from "react";

export type SettingsPanelState = {
	dirty: boolean;
	busy: boolean;
	sensitive?: boolean;
};

export type SettingsPanelStateChange = (state: SettingsPanelState) => void;

export function useSettingsPanelState(
	onChange: SettingsPanelStateChange | undefined,
	{ dirty, busy, sensitive = false }: SettingsPanelState,
) {
	useEffect(() => {
		onChange?.({ dirty, busy, sensitive });
	}, [onChange, dirty, busy, sensitive]);

	useEffect(
		() => () => onChange?.({ dirty: false, busy: false, sensitive: false }),
		[onChange],
	);
}
