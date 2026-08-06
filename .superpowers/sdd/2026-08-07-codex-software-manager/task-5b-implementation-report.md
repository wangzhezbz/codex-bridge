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

## Fix round 1

The first review round closed all nine follow-up findings across the Task 4 archive service, Task 5 Windows host, and Task 5B native boundary.

### Archive extraction boundary

- 7z inspection now uses only `l -slt -ba -t7z -sns- -- <archive>`.
- 7z extraction no longer gives 7z a destination directory. Each preflight regular file is extracted through one injected streaming process using only `x -so -y -t7z -sns- -- <archive> <raw-entry-path>` and piped into the capability-owned writer.
- The raw 7z entry path is retained only as the already-preflighted source selector. Destination paths are always derived from normalized validated segments.
- Each stream requires bounded stderr, a successful process completion result, cancellation propagation, and an exact byte count enforced by the destination writer.
- ZIP and 7z both enumerate and validate the complete output tree against the preflight tree before success.

### Retained output capabilities

- Created archive files and directories retain their original handles, identities, final paths, expected sizes, and read-only sharing until verification and close.
- A writer flush no longer closes its native handle. Verification rechecks every retained handle for identity, final path, type, size, link count, reparse evidence, and alternate streams.
- Directory traversal now uses bounded native handle enumeration. It rejects invalid names and reparse evidence before any child open, detects untracked extras, and never uses `fs.readdir`.
- Safe-delete enumeration shares one 4,096-entry budget across the complete owner/tree and claims every mutation descriptor synchronously before its first await.
- A verified staging path is valid only while these capabilities remain held. Any later promotion must be part of the same controlled transaction; reopening a path after capability close is not equivalent validation.

### Shortcut and native boundary

- Shortcut creation now seals the Electron-written temp file by reacquiring the original identity with READ+DELETE and share-read only. The sealed descriptor stays held while Electron reads it and is the same descriptor used for no-replace commit or cleanup.
- Exact shortcut inspection now returns a held opaque descriptor. The host reads while it is held and passes that same descriptor to removal; mismatch and read-error paths release it without inspect-close-reopen.
- State, safe-delete, temp, and inspection descriptors use synchronous `open -> busy -> consumed` claims. Only an explicit occupied rename restores `open` for retry.
- `removeTemp` closes the complete capability owner in `finally` and aggregates a primary mutation error with any close errors.
- Every Kernel32 function is bound with explicit `__stdcall`.
- All internal native paths use the `\\?\` extended form for open, directory creation, and handle rename; Win32 error 206 maps to `windows_path_too_long` while public final paths remain ordinary DOS paths.
- Native `FileStreamInfo` rejects any stream other than `::$DATA`, and native `FileIdBothDirectoryRestartInfo` / `FileIdBothDirectoryInfo` provides bounded streaming directory enumeration by pinned handle.

### Fix-round TDD and Windows smoke evidence

The added RED cases initially exposed 10 file-capability failures, 7 archive failures, and 4 Windows-host failures. The final focused suites pass:

- Archive, native capability, and Windows host: 139 passed, 0 failed.
- All software-manager suites: 266 passed, 0 failed.

Real task-owned Win32 sandboxes under this worktree passed and were removed one exact path at a time:

- state handle create/write/flush/rename/read/delete: pass;
- shortcut Electron-write simulation, seal, held read, commit, held inspection, and exact removal: pass;
- native archive create/enumerate/verify with a 294-character file path: 9 verified entries;
- a real NTFS alternate data stream was rejected by `FileStreamInfo`.

The first long-path smoke exposed that directory enumeration additionally needs list-directory read access (`ERROR_ACCESS_DENIED`). After adding that access to enumerated directory handles, the complete long-path/ADS smoke passed. No installed software, registry, PATH, Desktop, `.codex`, or server was touched.

## Fix round 2

The second review round corrected the held-shortcut sharing contract without reopening a writable path window.

### Two-phase shortcut handle contract

- `sealTemp` and `inspectExact` now hold a read/attributes seal handle without DELETE desired access.
- The seal shares read and delete, but never write. This permits Electron's read-only shortcut open and the later mutation handle while denying any same-identity in-place writer for the complete target-read interval.
- After the host finishes `readShortcutLink`, `commitNoReplace` or `removeExact` synchronously claims the descriptor before its first await, keeps the read seal alive, and opens a second READ+DELETE mutation handle.
- The mutation handle is revalidated for identity, final path, link count, reparse state, and alternate streams before handle-based rename or deletion. The read seal is never closed before the mutation handle opens, so there is no writable gap between target validation and mutation.
- Occupied no-replace rename remains the sole retryable state and retains both handles. Completion, cleanup, or release closes the complete owner and preserves aggregated close errors.

### Fix-round evidence

The fake native adapter now enforces Windows bidirectional share compatibility. Its RED failures reproduced both old conflicts: a seal handle could not satisfy the read/attributes contract, and a read-only open alongside `inspectExact` failed with `sharing_violation`. The GREEN contract proves:

- a read-only client can open while the seal is held;
- an in-place writer is rejected while the seal is held;
- after an occupied rename, both the read seal and mutation handle remain live for the retry;
- the seal is not closed before the mutation handle opens.

A real Electron `39.8.10` probe ran only in a task-owned worktree sandbox. `shell.writeShortcutLink` succeeded, `shell.readShortcutLink` succeeded while the new seal was held, commit returned `committed`, a second held inspection read succeeded, and exact removal completed. The probe script, shortcut, and empty sandbox directory were each removed by explicit non-recursive paths; the real Desktop was never used.

Final round-2 regression counts are 141/141 for the archive/native-capability/Windows-host focused set and 268/268 across all software-manager suites. Dedicated failure cases also prove that a non-occupied commit failure removes the temp and closes both handles, while an exact-remove failure closes both handles and aggregates the primary and close failures.
