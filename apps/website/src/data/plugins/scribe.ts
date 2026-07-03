import type { PluginData } from './types';

export const scribe: PluginData = {
  slug: 'scribe',
  name: 'Scribe',
  version: '0.1.0',
  tagline: 'The why your git log will never show.',
  category: 'analysis',

  hero: {
    headline: 'Your git log shows what changed. Scribe captures why.',
    subheadline:
      'At every session end, Scribe reads your conversation and extracts a structured intent document — problem, decisions, tradeoffs, constraints — automatically.',
  },

  problem:
    "When a session ends, the reasoning evaporates. You can git-blame the change, but not the decision. Why this approach over that one? What alternatives were ruled out? What constraints shaped the work? That context lives in the conversation — and the conversation window closes.",

  howItWorks: [
    'On SessionStart — captures the initial user prompt as the session\'s opening context',
    'On each UserPromptSubmit — counts turns to determine if the session is substantial enough to document (configurable minimum, default 3)',
    'On Stop — reads the full session transcript and runs a Haiku extraction pass to identify the problem, decisions (with reasons and alternatives considered), tradeoffs, constraints, and what was explicitly left out',
    'Formats findings as a structured Markdown document named <date>-<session>.md',
    'Writes to ${ONLOOKER_DIR}/scribe/<project-key>/, with an optional mirror to <repo-root>/docs/decisions/',
  ],

  capabilities: [
    'Extracts six artifact types: problem statement, decisions (with reasons and rejected alternatives), tradeoffs, constraints, out-of-scope items, and a 2-3 sentence executive summary',
    'Turn gate — skips sessions with fewer than min_turns (default: 3) user turns; trivial sessions produce no output',
    'Runs at Stop — no interruption to your session; distillation happens after the agent stops',
    'Project-scoped storage — documents land in ${ONLOOKER_DIR}/scribe/<project-key>/ and survive the session',
    'Optional project mirror — set mirror_to_project: true to copy documents into docs/decisions/ alongside your code',
    'Haiku model — fast, cheap extraction at temperature 0.3; the session transcript is never retained beyond the extraction pass',
  ],

  events: [
    {
      type: 'scribe.distill.complete',
      when: 'Intent document written successfully at session end',
      keyFields: 'session_id, captures_processed, artifacts_produced',
    },
  ],

  config: `{
  "scribe": {
    "enabled": true,
    "capture": { "min_turns": 3 },
    "output": {
      "mirror_to_project": false,
      "project_dir": "docs/decisions"
    }
  }
}`,

  tags: ['documentation', 'intent', 'decisions', 'why', 'session', 'reasoning', 'history'],

  idealFor:
    'Projects where agent sessions make consequential decisions that reviewers or future maintainers need to understand; any work where "why was this done?" will eventually be asked; teams doing significant refactors or architecture changes where decision context is as important as the code.',
};
