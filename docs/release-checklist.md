# Release Checklist

Before tagging a CodexBridge release:

1. Run `npm run check`.
2. Run `npm run desktop:smoke`.
3. Run `npm run package:win`.
4. Run `npm run package:win:smoke`.
5. Confirm all built-in adapter profile tests pass.
6. Confirm all local provider-category smoke tests pass.
7. Confirm `git status --short --branch` is clean before tagging.
8. Push `main`.
9. Create and push the version tag.
10. Wait for GitHub Actions release build success.
11. Confirm `/releases/latest` points to the new version.

Do not tag a release when any built-in provider category has a known compatibility failure.
