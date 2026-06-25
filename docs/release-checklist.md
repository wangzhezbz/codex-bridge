# Release Checklist

Before tagging a CodexBridge release:

1. Run `npm run check`.
2. Run `npm run desktop:smoke`.
3. Run `npm run package:win`.
4. Run `npm run package:win:smoke`.
5. Confirm `docs/model-regression-matrix.md` still reflects the route behavior being released.
6. Confirm all built-in adapter profile tests pass.
7. Confirm all local provider-category smoke tests pass.
8. Confirm `git status --short --branch` is clean before tagging.
9. Push `main`.
10. Create and push the version tag.
11. Wait for GitHub Actions release build success.
12. Confirm `/releases/latest` points to the new version.

Do not tag a release when any built-in provider category has a known compatibility failure.
