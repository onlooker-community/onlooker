/**
 * Declared so the release reads as `string | undefined` rather than `any`.
 *
 * Vite's own ImportMetaEnv carries an `[key: string]: any` index signature, so
 * this is about the type of the value, not about catching a misspelled name -
 * nothing can catch that here. apps/web/src/vite-env.d.ts:12 is the same
 * declaration for the same variable on the other half of the app.
 */
interface ImportMetaEnv {
	readonly PUBLIC_MONITORING_RELEASE?: string;
}
