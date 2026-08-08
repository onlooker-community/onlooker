import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ZCounterObservation, ZLesson } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../schema");
mkdirSync(outDir, { recursive: true });

const artifacts = [
	["lesson", ZLesson],
	["counter-observation", ZCounterObservation],
];

for (const [name, schema] of artifacts) {
	const json = z.toJSONSchema(schema);
	writeFileSync(
		resolve(outDir, `${name}.schema.json`),
		`${JSON.stringify(json, null, 2)}\n`,
	);
	console.log(`wrote schema/${name}.schema.json`);
}
