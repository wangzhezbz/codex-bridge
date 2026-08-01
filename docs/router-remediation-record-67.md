# Router remediation record 67: current ChatGPT desktop Start-app identity

Date: 2026-07-28

## Risk addressed

CodexBridge could report that ChatGPT / Codex Desktop was missing even though
the current ChatGPT app was installed and visible in the Windows Start menu.

## Root cause

The current desktop build can register this Start-app identity:

```text
Name: ChatGPT
AppID: com.openai.codex
```

CodexBridge already queried `Get-StartApps`, but its launch-target validation
only trusted the older Microsoft Store package-family form such as
`OpenAI.ChatGPT_<publisher>!App`. It therefore discarded the valid current
identity after discovering it.

## Repair

- Accept the exact official Win32 Start-app IDs `com.openai.codex` and
  `com.openai.chatgpt`.
- Keep the existing publisher validation for Microsoft Store package-family
  targets.
- Keep rejecting lookalikes, ChatGPT Classic, CodexBridge, and untrusted
  package families.
- Treat the Win32 Start-app ID as a desktop launch target, not as an AppX
  package family requiring an installation-path lookup.

## Explicitly unchanged

- Router start, stop, configuration, routing, models, and provider behavior are
  unchanged.
- Existing executable, shortcut, and Microsoft Store discovery remains in its
  original priority order.
- No application is installed, removed, killed, or modified.

## Verification

- The regression test failed before the compatibility change and passed after
  it.
- The live Windows Start-app registration resolves to
  `shell:AppsFolder\com.openai.codex` and is accepted as trusted.
- Desktop locator and desktop main-process regression tests pass.
