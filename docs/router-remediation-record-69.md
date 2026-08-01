# Router remediation record 69: duplicate provider model refresh

Date: 2026-07-29

## Risk addressed

Refreshing a provider model list could fail during configuration planning with
diagnostic code `provider_refresh_stale`. Repeated clicks or overlapping
renderer requests made the failure recur, and in the worst case no refreshed
model list was committed.

## Root cause

Provider refresh candidates intentionally carry a compare-and-swap fingerprint
so that an old network response cannot overwrite provider settings edited while
the request is in flight.

The desktop IPC path previously started a new candidate for every refresh call.
Two overlapping calls for the same provider therefore invalidated each other:
the later call replaced the current refresh token and the earlier otherwise
valid result was rejected as `provider_refresh_stale`. The transaction guard was
working correctly, but duplicate equivalent work was allowed to reach it.

## Repair

- Add a provider-keyed single-flight refresh coordinator in the desktop main
  process.
- Overlapping refreshes for the same provider now share one network request and
  one configuration transaction.
- Different providers can still refresh independently.
- Failed work is removed from the in-flight map so a later retry performs a new
  request.
- Keep the existing fingerprint validation unchanged so a genuine provider edit
  during refresh is still rejected safely.

## Explicitly unchanged

- Provider URL, API key, interface type, saved models, and Router routing rules
  are unchanged.
- The remote endpoint and response parsing logic are unchanged.
- A failed refresh still preserves the last successful model list.
- Provider edits are not silently overwritten by an older refresh response.

## Verification

- Added regression coverage proving two overlapping refreshes for one provider
  perform one fetch and one commit.
- Added regression coverage proving different providers remain independent and
  a failed refresh can be retried.
- Added transaction coverage for both a built-in provider and a custom
  intermediary provider.
- Added main-process wiring assertions proving the IPC handler uses the shared
  refresh coordinator while the actual commit still goes through the common
  configuration transaction.
