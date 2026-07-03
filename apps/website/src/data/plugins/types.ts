export interface PluginTable {
	title: string;
	headers: [string, string];
	rows: [string, string][];
}

export interface PluginEvent {
	type: string;
	when: string;
	keyFields?: string;
}

export type PluginCategory =
	| "memory"
	| "analysis"
	| "safety"
	| "testing"
	| "governance"
	| "quality";

export interface PluginData {
	slug: string;
	name: string;
	version: string;
	tagline: string;
	category: PluginCategory;

	hero: {
		headline: string;
		subheadline: string;
	};

	problem: string;
	howItWorks: string[];

	tables?: PluginTable[];
	capabilities: string[];
	events?: PluginEvent[];

	config?: string;

	tags: string[];

	// Plugin-specific optional sections
	idealFor?: string;
	skillCommands?: string;
	interventionExample?: string;
}
