# Task 5B implementation report

## Outcome

Implemented the Windows native file-safety boundary consumed by the existing Task 2, Task 4, and Task 5 contracts. No Router behavior or existing software-manager consumer contract was changed.

Created:

- `desktop/software-manager/win32-file-api.mjs`
- `desktop/software-manager/windows-file-capabilities.mjs`
- `tests/software-manager-windows-file-capabilities.test.js`

Dependency change:

- Added runtime dependency `koffi` pinned exactly to `3.1.2` in `package.json` and `package-lock.json`.
- Koffi is required only inside `createWin32FileApi` after the `platform === "win32"` guard. Importing the module on another platform does not load native code.

## Native boundary

`createWin32FileApi` binds a fixed Kernel32 surface:

- `CreateFileW`
- `CloseHandle`
- `GetLastError`
- `GetFileInformationByHandle`
- `GetFileInformationByHandleEx`
- `GetFinalPathNameByHandleW`
- `ReadFile`
- `WriteFile`
- `FlushFileBuffers`
- `CreateDirectoryW`
- `SetFileInformationByHandle`

Existing objects are opened with `FILE_FLAG_OPEN_REPARSE_POINT`; directory opens also use `FILE_FLAG_BACKUP_SEMANTICS`. Identity is volume serial plus the 128-bit `FileIdInfo` value. Reparse evidence comes from `FileAttributeTagInfo`; link count and size come from handle information.

Delete uses `SetFileInformationByHandle(FileDispositionInfo)` on the pinned handle. Rename uses `SetFileInformationByHandle(FileRenameInfo)` with `ReplaceIfExists=false`; collisions remain an atomic native error and are never implemented as check-then-rename.

### RootDirectory finding

A real Windows probe showed that user-mode `SetFileInformationByHandle(FileRenameInfo)` returned `ERROR_INVALID_PARAMETER (87)` for a non-null `FILE_RENAME_INFO.RootDirectory`. The same result occurred with `FileRenameInfoEx` and an oversized buffer. A null `RootDirectory` with a complete absolute target succeeded.

The implementation therefore resolves the final path from the already-pinned destination directory handle, builds one direct-child absolute target, and submits that in the atomic handle rename. Every destination ancestor and the destination directory remain open without delete sharing for the capability lifetime, so the absolute namespace cannot be swapped and this does not degrade into path-only checking. Unsupported native calls still fail closed.

## Capabilities

`createWindowsFileCapabilities` exposes:

- `openStateDirectoryNoFollow`
- `openDirectoryNoFollow`
- `pinArchiveFileNoFollow`
- `openArchiveDestinationNoFollow`
- `createShortcutFileApi`

The implementation enforces:

- canonical local drive-absolute paths only; UNC, device namespaces, ADS, roots, traversal, invalid names, and reserved names including COM/LPT superscript digits are rejected;
- pinned no-delete-share ancestor chains and handle final-path verification;
- frozen descriptors backed by private identity maps, bound to one parent and single-use for mutation;
- handle-bound state reads, exclusive `wx` creation, flush, delete, and no-replace rename;
- bounded safe-delete enumeration and descriptor-only file/directory deletion;
- immutable archive pin identity, initially empty staging destinations, exclusive output creation, pinned writable streams, cancellation-aware bounded verification, and rejection of reparse points or hard links;
- shortcut temp identity revalidation after Electron writes, atomic no-replace commit, distinct occupied status, exact identity inspection/removal, and absence distinct from access or parse failures;
- reverse-order handle cleanup on all tested success/failure paths while retaining primary and close errors together.

## TDD evidence

The first test run failed with `ERR_MODULE_NOT_FOUND` for the new production modules. Subsequent RED cases covered missing methods and then individual behavior failures, including the real `ERROR_INVALID_PARAMETER (87)` rename probe before the absolute-target correction.

Focused fake-native suite:

- `node --test tests/software-manager-windows-file-capabilities.test.js`
- Result: 17 passed, 0 failed.

All software-manager tests:

- `node --test tests/software-manager-*.test.js`
- Result: 256 passed, 0 failed.

## Real Windows smoke evidence

Two task-owned sandboxes under this worktree were used and removed with exact, non-recursive cleanup:

1. State smoke: native exclusive create, write, flush, handle rename, handle read, and handle delete returned `{"value":"native-safe","renameByHandle":true,"deleteByHandle":true}`.
2. Shortcut/archive smoke: native candidate collision returned `occupied`, the second candidate returned `committed`, exact removal returned `absent`, and the verified archive tree reported one directory plus one 4-byte regular file with `link:false`, `reparse:false`, `hardLink:false`, and `nlink:1`.

No installed software, registry, PATH, Desktop, `.codex`, or server was touched.

## Verification

- `npm audit --omit=dev` — 0 vulnerabilities.
- `node scripts/package-content-policy.mjs` — exit 0.
- Syntax checks for both new production modules and the new test — exit 0.
- `npm run check` — exit 0.
- `git diff --check` — exit 0.
