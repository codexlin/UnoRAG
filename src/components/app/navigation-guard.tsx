"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
	type ComponentProps,
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import type { SettingsPanelState } from "@/components/app/settings/use-settings-panel-state";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const CLEAR: SettingsPanelState = {
	dirty: false,
	busy: false,
	sensitive: false,
};
const NavigationGuardContext = createContext({
	setGuard: (_state: SettingsPanelState) => {},
	allowNavigation: (_afterConfirm: () => void): boolean => true,
});

export function NavigationGuardProvider({ children }: { children: ReactNode }) {
	const pathname = usePathname();
	const previousPathname = useRef(pathname);
	const state = useRef(CLEAR);
	const [guard, setGuardState] = useState(CLEAR);
	const [pending, setPending] = useState<(() => void) | null>(null);
	const setGuard = useCallback((next: SettingsPanelState) => {
		state.current = next;
		if (!next.dirty && !next.busy && !next.sensitive) setPending(null);
		setGuardState((previous) =>
			previous.dirty === next.dirty &&
			previous.busy === next.busy &&
			Boolean(previous.sensitive) === Boolean(next.sensitive)
				? previous
				: next,
		);
	}, []);
	const allowNavigation = useCallback((afterConfirm: () => void) => {
		if (state.current.busy) {
			toast.info("操作进行中，请稍候");
			return false;
		}
		if (state.current.dirty || state.current.sensitive) {
			setPending(() => afterConfirm);
			return false;
		}
		return true;
	}, []);
	const context = useMemo(
		() => ({ setGuard, allowNavigation }),
		[setGuard, allowNavigation],
	);
	useEffect(() => {
		if (previousPathname.current === pathname) return;
		previousPathname.current = pathname;
		state.current = CLEAR;
		setGuardState(CLEAR);
		setPending(null);
	}, [pathname]);

	useEffect(() => {
		if (!guard.dirty && !guard.busy && !guard.sensitive) return;
		function beforeUnload(event: BeforeUnloadEvent) {
			if (state.current.dirty || state.current.busy || state.current.sensitive)
				event.preventDefault();
		}
		window.addEventListener("beforeunload", beforeUnload);
		return () => window.removeEventListener("beforeunload", beforeUnload);
	}, [guard]);

	return (
		<NavigationGuardContext.Provider value={context}>
			{children}
			<AlertDialog
				open={pending !== null}
				onOpenChange={(open) => !open && setPending(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>离开当前设置？</AlertDialogTitle>
						<AlertDialogDescription>
							{guard.sensitive
								? "一次性密钥或邀请链接将关闭，请先复制保存。"
								: "未保存的更改将丢失。"}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>留在此页</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								const navigate = pending;
								setPending(null);
								navigate?.();
							}}
						>
							{guard.sensitive ? "已保存，离开" : "放弃更改并离开"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</NavigationGuardContext.Provider>
	);
}

export function useNavigationGuard() {
	return useContext(NavigationGuardContext);
}

export function GuardedLink({
	href,
	...props
}: Omit<ComponentProps<typeof Link>, "onNavigate" | "href"> & {
	href: string;
}) {
	const router = useRouter();
	const { allowNavigation } = useNavigationGuard();
	return (
		<Link
			href={href}
			onNavigate={(event) => {
				if (!allowNavigation(() => router.push(href))) event.preventDefault();
			}}
			{...props}
		/>
	);
}
