# wsl-bridge

DSH (DeepSeek Harness) Cordis plugin that lets an agent running inside **WSL**
(Windows Subsystem for Linux) access and invoke **Windows-side files and
programs**.

Built for agents that live in WSL but need the Windows host: read/write files
on `C:\`, run `.exe` programs, open things in Explorer, list drives, convert
paths.

## Tools

| Tool | Purpose |
|---|---|
| `win_ls` | List a Windows directory (accepts `C:\...` or `/mnt/c/...`) |
| `win_read` | Read a Windows text file (utf8/gbk, line offset/limit) |
| `win_write` | Write UTF-8 text to a Windows file (creates parent dirs) |
| `win_run` | Run a Windows program (`cmd` / `powershell` / `direct` interop) |
| `win_open` | Open a file/folder with the default Windows handler |
| `win_path` | Convert between `C:\...` and `/mnt/c/...` (wslpath) |
| `win_drives` | List mounted Windows drives |

Optional (when `codebase-memory-mcp` is installed):
`codebase_search`, `codebase_arch` — knowledge-graph code search.

## How it works

Everything runs through the host `shell` service (the same seam the built-in
`bash` tool uses) with the calling session's sandbox policy applied per call.
Path normalization handles both `C:\Users\me` and `/mnt/c/Users/me` forms.
`win_run` writes temp `.bat`/`.ps1` files to `C:\Windows\Temp` and cleans up
after itself; PowerShell output is forced to UTF-8 console encoding.

## Install (DSH)

This is a Cordis Host plugin. In a DSH session:

1. Define the plugin with the Cordis toolset (or mount it in an agent preset
   composition), passing `src/index.js` as the host half.
2. The plugin reads optional env vars at apply time:
   - `CODEBASE_MEMORY_BIN` — path to the `codebase-memory-mcp` binary
     (default `/usr/local/bin/codebase-memory-mcp`); the codebase tools simply
     error if the binary is absent.

## Requirements

- WSL with Windows interop enabled (`cmd.exe`, `powershell.exe`, `wslpath`,
  `explorer.exe` reachable — standard on WSL1/WSL2)
- DSH host with the `shell` and `sandboxPolicy` services

## License

MIT
