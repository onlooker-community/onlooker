import type { PluginData } from './types';

export const bursar: PluginData = {
  slug: 'bursar',
  name: 'Bursar',
  version: '0.1.0',
  tagline: "What has this project cost me lately?",
  category: 'governance',

  hero: {
    headline: 'Per-project spend, rolled up across sessions.',
    subheadline:
      "Bursar rolls each session's spend into a per-project ledger when the session ends, then surfaces \"this project burned $X this week\" at the next session start. Where Governor regulates a single session, Bursar is the cross-session rollup — answering not \"is this session over budget?\" but \"what has this project cost me lately?\"",
  },

  problem:
    "Governor caps a single session's spend, but the question that matters at the start of the next session isn't \"is this run going to be expensive?\" — it's \"have I already spent more on this project this week than I realized?\" One $4 session is forgettable; thirteen of them across a week is a number worth knowing before turn one. Without a rollup, the per-session signal Governor emits is structurally unable to answer the weekly-cost question, and the only place that data lives — the event log — is not where a human is looking at SessionStart.",

  howItWorks: [
    'SessionStart — derives the project key from cwd, writes a breadcrumb at $ONLOOKER_DIR/bursar/sessions/<session-id>.json so SessionEnd can attribute spend, then sums the per-project ledger over the active window and surfaces the total as additionalContext',
    'SessionEnd — resolves the ending session\'s project key (breadcrumb → substrate session tracker → live cwd), reads the session\'s spend from the latest governor.session.complete on the event bus, and upserts one record into the per-project ledger',
    'Reading off the bus, not the wire — Governor re-emits session.complete cumulatively; Bursar takes the last one to capture the session\'s final totals (total_cost_usd, total_tokens, total_api_calls)',
    'Idempotent recording — records are keyed by session_id, so a SessionEnd that fires more than once replaces the line rather than appending',
    'Graceful degradation — when no governor.session.complete exists (Governor disabled or absent), the session is still recorded with governor_present: false and the surfaced message degrades to a session count',
    'Honors $ONLOOKER_DIR — never hardcodes ~/.onlooker, so isolated test environments and alternate substrates work transparently',
  ],

  tables: [
    {
      title: 'Bursar vs. Governor — the division of labor',
      headers: ['Question', 'Plugin'],
      rows: [
        ['Is this single session over budget?', 'Governor — per-session cap, enforced live'],
        ['What has this project cost me this week?', 'Bursar — per-project rollup, surfaced at SessionStart'],
        ['Was this turn unusually expensive?', 'Governor — per-turn deltas'],
        ['Should I notice that I started thirteen sessions on this repo since Monday?', 'Bursar — windowed session count + cost'],
      ],
    },
    {
      title: 'Window options',
      headers: ['Value', 'Behavior'],
      rows: [
        ['rolling_7d (default)', 'Sums the trailing 7×24h from the moment of SessionStart'],
        ['calendar_week', 'Sums from the most recent week start; honors week_start (monday or sunday)'],
      ],
    },
  ],

  capabilities: [
    'Reads Governor off the bus, never calls it — the two plugins do not import each other; Bursar consumes governor.session.complete events from the shared event log',
    'Attribution across the SessionStart/SessionEnd gap — SessionEnd\'s hook payload only reliably carries session_id, so SessionStart drops a breadcrumb keyed by session_id that SessionEnd reads back',
    'Idempotent ledger — re-recording a session replaces its line, so a duplicate SessionEnd never double-counts',
    'Suppressible surfacing — surface_at_session_start: false records silently; min_cost_to_surface_usd hides small totals to keep the SessionStart channel quiet',
    'Per-project scoping — each project gets its own sessions.jsonl ledger keyed by the SHA256 of git remote get-url origin (with a realpath fallback)',
    'Disabled by default — opt-in via bursar.enabled: true; when disabled, every hook skips silently',
  ],

  events: [
    {
      type: 'bursar.session.recorded',
      when: 'At SessionEnd, after a session\'s spend is upserted into the project ledger',
      keyFields: 'project_key, session_id, governor_present, cost_usd?, tokens?, api_calls?, model?',
    },
    {
      type: 'bursar.rollup.surfaced',
      when: 'At SessionStart, when a windowed total is shown',
      keyFields: 'project_key, window, window_start, total_cost_usd, session_count, total_tokens, sessions_with_cost',
    },
    {
      type: 'bursar.rollup.skipped',
      when: 'At SessionStart, when nothing is surfaced because the window is empty',
      keyFields: 'reason, project_key',
    },
  ],

  config: `{
  "bursar": {
    "enabled": false,
    "window": "rolling_7d",
    "week_start": "monday",
    "surface_at_session_start": true,
    "min_cost_to_surface_usd": 0
  }
}`,

  tags: [
    'governance',
    'cost',
    'budget',
    'rollup',
    'cross-session',
    'per-project',
    'session-start',
  ],

  idealFor:
    "Anyone running Governor who has wondered what their actual weekly spend looks like across a repo; teams that want budget visibility without manual log digging; projects where the cost signal that matters isn't \"is this turn expensive?\" but \"how much have I already poured into this codebase this week?\"",
};
