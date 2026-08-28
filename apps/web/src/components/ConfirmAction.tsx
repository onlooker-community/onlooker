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
 * unless something moves focus deliberately; cancelling destroys it again.
 */
export function ConfirmAction({
	trigger,
	question,
	confirmLabel,
	onConfirm,
	pending = false,
	variant = "danger",
	pendingLabel = "Working...",
}: {
	trigger: string;
	question: string;
	confirmLabel: string;
	onConfirm: () => void;
	pending?: boolean;
	variant?: "primary" | "danger";
	pendingLabel?: string;
}) {
	const [armed, setArmed] = useState(false);
	const questionId = useId();
	const triggerRef = useRef<HTMLDivElement>(null);
	const confirmRef = useRef<HTMLDivElement>(null);
	// Distinguishes "armed on this render" from "re-rendered while armed", so
	// focus moves once rather than stealing it back on every keystroke elsewhere.
	const justArmed = useRef(false);
	const justCancelled = useRef(false);

	useEffect(() => {
		if (justArmed.current) {
			justArmed.current = false;
			confirmRef.current?.querySelector("button")?.focus();
		}
		if (justCancelled.current) {
			justCancelled.current = false;
			triggerRef.current?.querySelector("button")?.focus();
		}
	});

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
					justCancelled.current = true;
					setArmed(false);
				}}
			>
				Cancel
			</Button>
		</div>
	);
}
