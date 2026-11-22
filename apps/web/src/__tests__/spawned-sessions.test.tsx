import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AllSpawned, SpawnedTail } from "../components/SpawnedSessions";

// ONL-306. Both callers return early before n can be 0, so neither page can
// show this today. The guard lives here so the next caller can't either:
// "0 sessions, all started by another session" is a claim about nothing.
describe("AllSpawned", () => {
	it.each([
		true,
		false,
	])("renders nothing for no sessions (complete %s)", (complete) => {
		const { container } = render(<AllSpawned n={0} complete={complete} />);
		expect(container.textContent).toBe("");
	});

	it("says every session was spawned when there are some", () => {
		const { container } = render(<AllSpawned n={2} complete={true} />);
		expect(container.textContent).toBe(
			"Your machines reported 2 sessions, all started by another session or a script, so none are counted.",
		);
	});
});

describe("SpawnedTail", () => {
	it("renders nothing for no sessions", () => {
		const { container } = render(<SpawnedTail n={0} />);
		expect(container.textContent).toBe("");
	});
});
