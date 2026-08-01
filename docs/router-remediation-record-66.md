# Router remediation record 66: verified Double Quota extension deployment

Date: 2026-07-25

## Risks addressed

1. The Double Quota “install/update extension” action could report progress without proving that the embedded extension files reached the stable user-data directory.
2. Disk installation, Chrome unpacked-extension registration, and the Bridge runtime heartbeat were collapsed into one ambiguous state, so a copied directory could be mistaken for a working extension.
3. Chrome preference paths discovered from other profiles could be overwritten during an update.
4. Extension management repeatedly polled diagnostics, causing a long spinner when the Bridge service or extension was offline.
5. Opening `chrome://extensions/` in a new-window command could land on an empty page or the wrong Chrome profile.

## Root causes

- Deployment success was inferred mostly from file presence and process memory instead of a persisted, hash-verified receipt.
- Chrome Preferences discovery was used both as registration evidence and as a write target.
- Runtime connectivity and local installation were represented by the same action state.
- The update action waited for Chrome to reload an unpacked extension even though Chrome requires an explicit first load and may require a user reload after files change.
- The Chrome launcher did not reuse the detected profile and unnecessarily forced a new window.

## Repairs

- Copy the audited embedded extension only to the stable CodexBridge user-data directory.
- Verify required files and their hashes after deployment, then persist `extension-deployment.json` under the Bridge data directory.
- Treat Chrome Preferences and Secure Preferences as read-only registration evidence.
- Report three independent layers:
  - disk files installed and verified;
  - Chrome registered the stable directory;
  - runtime protocol connected and current.
- Make the action state derive from those three layers: install, load, update, repair, or current.
- Remove diagnostic polling and the redundant pre-deployment probe. One click now deploys and verifies first, then performs one bounded state read.
- Copy the stable directory to the clipboard and open the detected Chrome profile's extension manager without `--new-window`.
- Keep first-time Chrome trust explicit: the user loads the verified stable directory once through “Load unpacked”; later updates overwrite the same directory and can be reloaded in place.

## Explicitly unchanged

- The model Router on port 15722 is unchanged.
- Router start, stop, model selection, provider configuration, image generation, history, and resources are unchanged.
- Existing Chrome profiles, registered extension directories, and legacy extension copies are not modified.
- No Chrome process or extension is force-installed, force-removed, or killed.

## Verification

- Double Quota service and renderer regression tests: 82/82 passed.
- Full desktop regression suite: 862/862 passed.
- Desktop smoke and packaged resource smoke: passed.
- JavaScript syntax checks for the changed service, main process, and renderer: passed.
- `git diff --check`: clean.
