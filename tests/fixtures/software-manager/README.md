# Software manager archive fixtures

The archive policy tests generate their tiny ZIP fixtures at runtime. This keeps
malicious path, link metadata, entry-count, and declared-size cases readable in
the test source and avoids committing opaque archive binaries.

7z behavior is exercised through the injected process adapter. Its listings are
literal `7z l -slt -ba` records, while extraction is represented by the Task 5
no-follow filesystem capability contract. No test starts a real 7z process or
touches an installed application.
