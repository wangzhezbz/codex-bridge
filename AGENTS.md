# Agent Instructions / Agent 操作规则

Do not batch-delete files or directories.

禁止批量删除文件或目录。

Never use:

不要使用：

- `del /s`
- `rd /s`
- `rmdir /s`
- `Remove-Item -Recurse`
- `rm -rf`

When deleting a file is necessary, delete only one explicit file path at a time.

需要删除文件时，只能一次删除一个明确路径的文件。

Correct example:

正确示例：

```powershell
Remove-Item "C:\path\to\file.txt"
```

If batch deletion seems necessary, stop and ask the user to delete the files manually.

如果需要批量删除文件，应停止操作，并请求用户手动删除，除非用户明确要求。
