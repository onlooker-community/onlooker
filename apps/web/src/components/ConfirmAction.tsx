import { useEffect, useId, useRef, useState } from "react";
import { Button } from "./ui";

/**
 * Arm, then confirm. Both destructive acts in the app work this way and both
 * had their own copy of it - retract in LessonDetail, revoke in MachinesPage.
 *
 * Inline rather than window.confirm, because these are the most consequential
 * acts in the product and neither should be handed to a native dialog that
 * looks like nothing else in the app. A retraction reaches every mirror on its
 * next delta pull.
 *
 * The focus handling is the reason this is a component rather than a snippet.
 * Arming replaces the trigger with this row, which destroys the focused element
 * unless something moves focus deliberately; canceling destroys it again.
 */
export function ConfirmAction({
	trigger,
	question,
	confirmLabel,
	onConfirm,
	pending = false,
	variant = "danger",
	pendingLabel = "Working...",
	resetToken,
}: {
	trigger: string;
	question: string;
	confirmLabel: string;
	onConfirm: () => void;
	pending?: boolean;
	variant?: "primary" | "danger";
	pendingLabel?: string;
	/**
	 * Change this to disarm. A prop rather than a `key` because remounting
	 * destroys the focused element - which is the whole defect this component
	 * exists to prevent - while this keeps the instance alive and lands focus
	 * back on the trigger, exactly as canceling does.
	 */
	resetToken?: string | number;
}) {
	const [armed, setArmed] = useState(false);
	const questionId = useId();
	const triggerRef = useRef<HTMLDivElement>(null);
	const confirmRef = useRef<HTMLDivElement>(null);
	// Distinguishes "armed on this render" from "re-rendered while armed", so
	// focus moves once rather than stealing it back on every keystroke elsewhere.
	const justArmed = useRef(false);
	const justCanceled = useRef(false);

	useEffect(() => {
		if (justArmed.current) {
			justArmed.current = false;
			confirmRef.current?.querySelector("button")?.focus();
		}
		if (justCanceled.current) {
			justCanceled.current = false;
			triggerRef.current?.querySelector("button")?.focus();
		}
	});

	// External disarm, e.g. a caller resetting after a lesson change or a
	// settled round trip. resetToken is deliberately the only dependency:
	// armed changing on its own (arming, canceling) must not re-run this.
	// Guarded on `armed` so the initial `resetToken` a caller mounts with
	// never fires this before anything is armed to disarm, and routed
	// through the same `justCanceled` focus handoff as the Cancel button so
	// a keyboard user lands back on the trigger instead of losing focus to
	// the DOM swap.
	useEffect(() => {
		if (!armed) return;
		justCanceled.current = true;
		setArmed(false);
	}, [resetToken]);

	if (!armed) {
		return (
			<div ref={triggerRef} style={{ display: "inline-block" }}>
				<Button
					variant={variant}
					disabled={pending}
					onClick={() => {
						justArmed.current = true;
						setArmed(true);
					}}
				>
					{trigger}
				</Button>
			</div>
		);
	}

	return (
		<div
			ref={confirmRef}
			style={{
				display: "flex",
				gap: "var(--space-2)",
				alignItems: "center",
				flexWrap: "wrap",
			}}
		>
			<span id={questionId}>{question}</span>
			<Button
				variant={variant}
				loading={pending}
				loadingLabel={pendingLabel}
				describedBy={questionId}
				onClick={onConfirm}
			>
				{confirmLabel}
			</Button>
			<Button
				disabled={pending}
				onClick={() => {
					justCanceled.current = true;
					setArmed(false);
				}}
			>
				Cancel
			</Button>
		</div>
	);
}
