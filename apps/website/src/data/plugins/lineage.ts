import type { PluginData } from './types';

export const lineage: PluginData = {
  slug: 'lineage',
  name: 'Lineage',
  version: '0.1.0',
  tagline: 'Why does this line exist?',
  category: 'analysis',

  hero: {
    headline: 'Connect every changed line back to the prompt that produced it.',
    subheadline:
      "Git records what changed and Scribe records a session's intent — but nothing connects a specific piece of code to the prompt, agent, and session behind it. Lineage records provenance for every Edit / Write / MultiEdit at PostToolUse, then answers /lineage <file>:<line> by joining its change records to the transcripts Historian preserves.",
  },

  problem:
    "A reviewer opens a file and asks: why is this conditional here? Git blame surfaces the commit, but the commit message is one line and the diff has fifty more. The prompt that motivated the change — the user's actual question, the constraint they were responding to — lived in a session whose transcript is gone. Scribe captures a session's intent in aggregate; Historian preserves transcripts; but neither links a specific line of code back to the turn that generated it. The why behind any given line evaporates the moment the session closes.",

  howItWorks: [
    'PostToolUse on Edit / Write / MultiEdit — derives the project key from cwd; reads the current turn from the session tracker',
    'Content extraction — pulls the added content from each edit, redacts secret-shaped substrings (AWS / GitHub / Anthropic / OpenAI keys, bearer tokens, KEY=value secrets), caps at max_snippet_chars (default: 4000)',
    'Appends one record to ~/.onlooker/lineage/<project-key>/changes.jsonl with session_id, turn, file_path, lines_added/removed, content_sha256, and the redacted added_snippets',
    'Emits a lean lineage.change.recorded carrying metadata + the SHA digest — never the content itself; the snippet lives only in the local ledger',
    'Content-anchored provenance — at query time, /lineage reads the current line\'s text and finds the most recent change whose added content contains it. Honest about what it is: what change introduced this content, not a git-blame-exact line mapping',
    'Lazy prompt resolution — the hot path stores only session_id + turn (+ a transcript_path pointer); /lineage resolves the prompt at query time from Historian first, the live transcript second, "unavailable" third',
  ],

  tables: [
    {
      title: 'The /lineage query surface',
      headers: ['Invocation', 'Answers'],
      rows: [
        ['/lineage <file>', 'Full change history for the file, newest first, each with its resolved prompt context'],
        ['/lineage <file>:<line>', 'Which change introduced the content currently on line N — with the prompt / agent / session behind it'],
        ['/lineage <file> --grep <text>', 'Which change introduced content matching <text>'],
        ['/lineage --status', 'Ledger stats for the project (changes recorded, files touched)'],
      ],
    },
    {
      title: 'Prompt resolution strategy',
      headers: ['Source', 'Behavior'],
      rows: [
        ['historian_then_transcript (default)', 'Prefer Historian (durable JSONL chunks); fall back to the live transcript; then to "prompt unavailable"'],
        ['historian_only', 'Only resolve via Historian; never read the live transcript'],
        ['transcript_only', 'Only resolve via the live transcript; ignore Historian'],
      ],
    },
  ],

  capabilities: [
    'Provenance for code, not commits — links a piece of content to the session and turn that produced it, before the commit message smooths everything to one line',
    "The Historian join — Lineage records only session_id + turn on the hot path; the prompt is resolved lazily at query time from Historian's durable chunks, so the live transcript can disappear without losing the why",
    'Honest content matching — the match is the most recent change whose added content contains the current line; later edits that move or rewrite lines are accounted for rather than glossed over',
    'Pre-redacted snippets — secret patterns are scrubbed before the snippet ever hits disk; the bus event carries only metadata and a content_sha256 digest',
    'Glob-based ignores — node_modules, .git, dist, *.lock skipped by default; tunable via ignore_globs',
    'Per-project scoping — each project gets its own append-only changes.jsonl under ~/.onlooker/lineage/<project-key>/',
    'Disabled by default — opt-in via lineage.enabled: true; while disabled, the hook skips silently and no ledger is written',
  ],

  events: [
    {
      type: 'lineage.change.recorded',
      when: 'At PostToolUse, after a change is appended to the ledger',
      keyFields: 'project_key, session_id, file_path, tool, operation, change_id, lines_added, lines_removed, bytes, edit_count, content_sha256',
    },
    {
      type: 'lineage.query.answered',
      when: 'When /lineage answers',
      keyFields: 'project_key, file_path, matches, line, resolved_via',
    },
  ],

  config: `{
  "lineage": {
    "enabled": false,
    "max_snippet_chars": 4000,
    "redact_secrets": true,
    "ignore_globs": [
      "**/.git/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/*.lock"
    ],
    "prompt_source": "historian_then_transcript"
  }
}`,

  tags: [
    'analysis',
    'provenance',
    'blame',
    'post-tool-use',
    'historian-join',
    'audit',
    'why',
  ],

  skillCommands: `/lineage <file>             # full change history for the file
/lineage <file>:<line>      # the change behind a specific line
/lineage <file> --grep TXT  # the change that introduced matching text
/lineage --status           # ledger stats for the project`,

  idealFor:
    "Reviewers who want to know why a line exists, not just when it changed; long-running projects where commit messages smooth over the actual rationale; teams running Historian who want a query surface that turns durable transcripts into per-line provenance instead of session-shaped recall.",
};
