# Claude Usage Changelog

## [Initial Release] - {PR_MERGE_DATE}

- Menu bar display of your Claude subscription usage (5-hour session and weekly windows)
- Detailed dashboard with reset timers, burn rate, and projections
- Opus / Sonnet weekly sub-limits and extra-usage credits when your plan exposes them
- Reads the Claude Code login locally from the macOS Keychain — no API key or cookie to paste
- Resilient to API rate limits: after a 429 the extension backs off for a shared cooldown (honoring `Retry-After`) instead of hammering the endpoint, keeps the last-known values on screen instead of showing an error, and recovers automatically — manual refresh still reports hard failures via HUD/toast instead of crashing
