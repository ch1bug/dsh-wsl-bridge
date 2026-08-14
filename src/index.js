/*
 * wsl-bridge — DSH (DeepSeek Harness) Cordis plugin
 *
 * Registers model tools that access and invoke Windows-side files and
 * programs from inside WSL (Windows Subsystem for Linux).
 *
 * Tools:
 *   win_ls        — list a Windows directory (C:\... or /mnt/c/...)
 *   win_read      — read a Windows text file (utf8/gbk, offset/limit)
 *   win_write     — write UTF-8 text to a Windows file (creates parent dirs)
 *   win_run       — run a Windows program (cmd / powershell / direct interop)
 *   win_open      — open a file/folder with the default Windows handler
 *   win_path      — convert between C:\... and /mnt/c/... forms (wslpath)
 *   win_drives    — list mounted Windows drives
 *
 * The codebase-memory tools (codebase_search / codebase_arch) are provided
 * as an optional extra when the `codebase-memory-mcp` binary is available —
 * they are guarded by the CBM_BIN env var and are not part of the core set.
 *
 * No API keys, no machine-specific paths: every external dependency
 * (codebase-memory binary) is resolved through an environment variable with
 * a sane default, and all temporary files go under /tmp.
 *
 * Usage: this is a Cordis Host plugin. In DSH, define it via the cordis
 * toolset, or mount it in an agent preset composition.
 */
return {
  name: 'wsl-bridge',
  inject: ['shell', 'sandboxPolicy'],
  apply(ctx) {
    const shell = ctx.get('shell')
    const sandboxPolicy = ctx.get('sandboxPolicy')

    // ── configuration (env-parameterized) ────────────────────────────────
    const env = typeof process !== 'undefined' && process.env ? process.env : {}
    const CBM_BIN = env.CODEBASE_MEMORY_BIN || '/usr/local/bin/codebase-memory-mcp'

    // ── helpers ──────────────────────────────────────────────────────────
    function shq(s) {
      return "'" + String(s).replace(/'/g, "'\\''") + "'"
    }
    function toWslPath(p) {
      const m = /^([A-Za-z]):[\\/](.*)$/.exec(String(p))
      if (!m) return String(p).replace(/\\/g, '/')
      const rest = m[2].replace(/\\/g, '/')
      return '/mnt/' + m[1].toLowerCase() + (rest ? '/' + rest : '')
    }
    function toWinPath(p) {
      const m = /^\/mnt\/([A-Za-z])\/(.*)$/.exec(String(p))
      if (!m) return String(p).replace(/\//g, '\\')
      return m[1].toUpperCase() + ':\\' + m[2].replace(/\//g, '\\')
    }
    async function run(command, exec, opts = {}) {
      const policy = sandboxPolicy === undefined ? undefined : sandboxPolicy.resolve(
        exec !== undefined && exec.agent !== undefined ? { session: exec.agent.session } : {}
      )
      const request = {
        command,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.workdir !== undefined ? { workdir: opts.workdir } : {}),
        ...(policy !== undefined ? { sandboxPolicy: policy } : {}),
        ...(exec !== undefined && exec.signal !== undefined ? { signal: exec.signal } : {})
      }
      return shell.run(shell.resolve(request))
    }

    const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    const DEFAULT_WIN_CWD = '/mnt/c'
    const WIN_TEMP = '/mnt/c/Windows/Temp'

    function sandboxInfo(r) {
      return r.sandbox ? { mode: r.sandbox.mode, denied: r.sandbox.denied } : null
    }

    // Run codebase-memory-mcp cli <tool> with JSON args piped on stdin (optional extra).
    async function cbm(tool, args, exec, timeoutMs = 120000) {
      const json = JSON.stringify(args)
      const cmd = `printf '%s' ${shq(json)} | ${shq(CBM_BIN)} cli ${tool} 2>/dev/null`
      const r = await run(cmd, exec, { timeoutMs })
      let data = null
      let parseError = null
      const out = r.stdout.text.trim()
      if (out) {
        try { data = JSON.parse(out) } catch { parseError = out.slice(0, 500) }
      }
      return {
        exitCode: r.exitCode,
        data,
        parseError,
        raw: out.slice(0, 3000),
        stderr: r.stderr.text.trim() ? r.stderr.text.trim().slice(0, 500) : null,
        timedOut: r.timedOut
      }
    }

    const tools = [
      // ── optional: codebase memory (only if binary present) ────────────
      {
        name: 'codebase_search',
        description: 'Search a codebase knowledge graph built by codebase-memory-mcp (when installed). Natural-language or keyword query with BM25 ranking; functions/methods/routes are boosted. Returns matching symbols with file locations.',
        parameters: {
          project: { type: 'string', description: 'Project name (default: the current workspace project)' },
          query: { type: 'string', required: true, description: 'Natural-language or keyword search, e.g. "JobRunner spawn scheduler"' },
          limit: { type: 'integer', description: 'Max results (default 20)' },
          label: { type: 'string', description: 'Optional node label filter: Function, Method, Struct, Trait, Route, Enum, Module, File, ...' },
          file_pattern: { type: 'string', description: 'Optional file path pattern filter' }
        },
        output: { schema: { type: 'json' }, render: renderJson },
        async execute(args, exec) {
          const cbmArgs = {
            project: args.project,
            query: args.query,
            ...(args.limit !== undefined ? { limit: args.limit } : { limit: 20 }),
            ...(args.label !== undefined ? { label: args.label } : {}),
            ...(args.file_pattern !== undefined ? { 'file-pattern': args.file_pattern } : {})
          }
          const r = await cbm('search_graph', cbmArgs, exec)
          return { ...r }
        }
      },
      {
        name: 'codebase_arch',
        description: 'Get the architecture of a codebase from the codebase-memory-mcp knowledge graph (when installed): node counts by label, edge types, hotspots, clusters, file tree.',
        parameters: {
          project: { type: 'string', description: 'Project name' },
          path: { type: 'string', description: 'Optional directory prefix to scope' },
          aspects: { type: 'string', description: "Aspects to include; 'all' or 'overview' (compact). Omit = all" }
        },
        output: { schema: { type: 'json' }, render: renderJson },
        async execute(args, exec) {
          const cbmArgs = {
            project: args.project,
            ...(args.path !== undefined ? { path: args.path } : {}),
            ...(args.aspects !== undefined ? { aspects: args.aspects } : { aspects: 'overview' })
          }
          const r = await cbm('get_architecture', cbmArgs, exec, 180000)
          return { ...r }
        }
      },
      // ── Windows access core tools ─────────────────────────────────────
      {
        name: 'win_ls',
        description: 'List a Windows-side directory from inside WSL. Accepts either a Windows path (C:\\Users\\me) or a WSL mount path (/mnt/c/Users/me); both are normalized automatically. Returns parsed entries plus the raw `ls -la` listing.',
        parameters: {
          path: { type: 'string', required: true, description: 'Directory to list, e.g. C:\\Users\\me or /mnt/c/Users/me' },
          long: { type: 'boolean', description: 'Detailed listing with sizes/timestamps (default true)' }
        },
        output: { schema: { type: 'json' }, render: renderJson },
        async execute(args, exec) {
          const p = toWslPath(args.path)
          const long = args.long !== false
          const cmd = (long ? 'ls -la --time-style=long-iso ' : 'ls -1 ') + shq(p)
          const r = await run(cmd, exec, { timeoutMs: 20000 })
          const entries = []
          if (long) {
            for (const line of r.stdout.text.split('\n')) {
              const m = /^([dlbcps-][rwxstST-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/.exec(line)
              if (m) entries.push({ perms: m[1], size: Number(m[2]), mtime: m[3] + ' ' + m[4], name: m[5], isDir: m[1][0] === 'd' })
            }
          } else {
            for (const line of r.stdout.text.split('\n')) {
              const name = line.trim()
              if (name && name !== 'total') entries.push({ name })
            }
          }
          return {
            path: p,
            winPath: toWinPath(p),
            exitCode: r.exitCode,
            entries,
            raw: r.stdout.text,
            error: r.stderr.text.trim() ? r.stderr.text.trim() : null
          }
        }
      },
      {
        name: 'win_read',
        description: 'Read a Windows-side text file from inside WSL. Accepts Windows or WSL paths. Optional 1-based line offset/limit, and GBK encoding conversion for files saved with the legacy Chinese codepage.',
        parameters: {
          path: { type: 'string', required: true, description: 'File to read, e.g. C:\\Users\\me\\notes.txt or /mnt/c/Users/me/notes.txt' },
          offset: { type: 'integer', description: '1-based first line to return (default 1)' },
          limit: { type: 'integer', description: 'Maximum number of lines to return' },
          encoding: { type: 'string', enum: ['utf8', 'gbk'], description: 'utf8 (default) or gbk (converts from GBK via iconv)' }
        },
        output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: typeof v.content === 'string' ? v.content : JSON.stringify(v, null, 2) }] },
        async execute(args, exec) {
          const p = toWslPath(args.path)
          const start = args.offset || 1
          const range = args.limit !== undefined ? `${start},${start + args.limit - 1}p` : `${start},$p`
          const base = `sed -n ${shq(range)} ${shq(p)}`
          const cmd = args.encoding === 'gbk'
            ? `${base} | iconv -f GBK -t UTF-8 2>/dev/null || ${base}`
            : base
          const r = await run(cmd, exec, { timeoutMs: 30000 })
          if (r.exitCode !== 0) {
            return { path: p, winPath: toWinPath(p), exitCode: r.exitCode, content: '', error: r.stderr.text.trim() || 'read failed' }
          }
          return { path: p, winPath: toWinPath(p), exitCode: r.exitCode, content: r.stdout.text, error: null }
        }
      },
      {
        name: 'win_write',
        description: 'Write UTF-8 text to a Windows-side file from inside WSL (creates missing parent directories). Accepts Windows or WSL paths. Overwrites by default; set append=true to append.',
        parameters: {
          path: { type: 'string', required: true, description: 'File to write, e.g. C:\\Users\\me\\out.txt or /mnt/c/Users/me/out.txt' },
          content: { type: 'string', required: true, description: 'Full text content to write' },
          append: { type: 'boolean', description: 'Append instead of overwrite' }
        },
        output: { schema: { type: 'json' }, render: renderJson },
        async execute(args, exec) {
          const p = toWslPath(args.path)
          const b64 = btoa(String(args.content ?? ''))
          const slash = p.lastIndexOf('/')
          const dir = slash > 0 ? p.slice(0, slash) : '/'
          const op = args.append === true ? '>>' : '>'
          const cmd = `mkdir -p ${shq(dir)} && printf '%s' ${b64} | base64 -d ${op} ${shq(p)}`
          const r = await run(cmd, exec, { timeoutMs: 20000 })
          return {
            path: p,
            winPath: toWinPath(p),
            exitCode: r.exitCode,
            bytes: new TextEncoder().encode(String(args.content ?? '')).length,
            error: r.exitCode !== 0 ? (r.stderr.text.trim() || 'write failed') : null
          }
        }
      },
      {
        name: 'win_run',
        description: 'Run a Windows program or command line and capture its output. shell="cmd" wraps the command with cmd.exe /c (UTF-8 codepage set first); shell="powershell" writes a temp .ps1 (UTF-8 BOM, console output forced to UTF-8) and runs it via powershell.exe -File; shell="direct" executes the string as-is in WSL bash, which is how you invoke a Windows .exe through WSL interop. Windows paths for cwd are converted automatically; cmd/powershell default to C:\\ when no cwd is given.',
        parameters: {
          command: { type: 'string', required: true, description: 'Command line to run, e.g. "dir C:\\Users" (cmd), "Get-Process explorer" (powershell), or "/mnt/c/Windows/System32/ipconfig.exe /all" (direct)' },
          shell: { type: 'string', enum: ['cmd', 'powershell', 'direct'], description: 'How to execute: cmd (default) | powershell | direct' },
          cwd: { type: 'string', description: 'Working directory on the Windows side (Windows or WSL path)' },
          timeoutMs: { type: 'integer', description: 'Timeout in milliseconds (default 120000)' }
        },
        output: { schema: { type: 'json' }, render: renderJson },
        async execute(args, exec) {
          const timeoutMs = args.timeoutMs !== undefined ? args.timeoutMs : 120000
          const workdir = args.cwd !== undefined ? toWslPath(args.cwd) : DEFAULT_WIN_CWD
          const rand = Math.random().toString(36).slice(2, 10)
          const command = String(args.command)
          if (args.shell === 'powershell') {
            const ps1 = `${WIN_TEMP}/dsh_${rand}.ps1`
            const script = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + command
            const b64 = btoa('\ufeff' + script)
            await run(`printf '%s' ${b64} | base64 -d > ${shq(ps1)}`, exec, { timeoutMs: 10000 })
            const r = await run(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${shq(toWinPath(ps1))}`, exec, { timeoutMs, workdir })
            await run(`rm -f ${shq(ps1)}`, exec, { timeoutMs: 5000 }).catch(() => {})
            return {
              shell: 'powershell',
              exitCode: r.exitCode, timedOut: r.timedOut, aborted: r.aborted,
              stdout: r.stdout.text, stderr: r.stderr.text,
              sandbox: sandboxInfo(r)
            }
          }
          if (args.shell === 'direct') {
            const r = await run(command, exec, { timeoutMs, workdir })
            return {
              shell: 'direct',
              exitCode: r.exitCode, timedOut: r.timedOut, aborted: r.aborted,
              stdout: r.stdout.text, stderr: r.stderr.text,
              sandbox: sandboxInfo(r)
            }
          }
          const bat = `${WIN_TEMP}/dsh_${rand}.bat`
          const b64 = btoa('@echo off\r\nchcp 65001 >nul\r\n' + command + '\r\n')
          await run(`printf '%s' ${b64} | base64 -d > ${shq(bat)}`, exec, { timeoutMs: 10000 })
          const r = await run(`cmd.exe /c ${shq(toWinPath(bat))}`, exec, { timeoutMs, workdir })
          await run(`rm -f ${shq(bat)}`, exec, { timeoutMs: 5000 }).catch(() => {})
          return {
            shell: 'cmd',
            exitCode: r.exitCode, timedOut: r.timedOut, aborted: r.aborted,
            stdout: r.stdout.text, stderr: r.stderr.text,
            sandbox: sandboxInfo(r)
          }
        }
      },
      {
        name: 'win_open',
        description: 'Open a Windows-side file or folder with its default Windows handler (explorer.exe). Explorer returns immediately with exit code 1 even on success, so a nonzero exit is expected and not an error.',
        parameters: {
          path: { type: 'string', required: true, description: 'File or folder to open, e.g. C:\\Users\\me\\notes.txt or /mnt/c/Users/me' }
        },
        output: { schema: { type: 'json' }, render: renderJson },
        async execute(args, exec) {
          const win = toWinPath(args.path)
          const r = await run(`explorer.exe ${shq(win)}`, exec, { timeoutMs: 15000 })
          return {
            winPath: win,
            wslPath: toWslPath(args.path),
            exitCode: r.exitCode,
            stdout: r.stdout.text, stderr: r.stderr.text,
            note: 'explorer.exe exits with code 1 on success; ignore nonzero exit if the app opened.'
          }
        }
      },
      {
        name: 'win_path',
        description: 'Convert a path between Windows (C:\\...) and WSL (/mnt/c/...) forms using wslpath. Pass either form; returns both.',
        parameters: {
          path: { type: 'string', required: true, description: 'Path to convert, e.g. C:\\Users\\me or /mnt/c/Users/me' }
        },
        output: { schema: { type: 'json' }, render: renderJson },
        async execute(args, exec) {
          const p = String(args.path)
          const isWsl = p.startsWith('/')
          const flag = isWsl ? '-w' : '-u'
          const r = await run(`wslpath ${flag} ${shq(p)}`, exec, { timeoutMs: 10000 })
          const converted = r.exitCode === 0 ? r.stdout.text.trim() : null
          return {
            input: p,
            wslPath: isWsl ? p : converted,
            winPath: isWsl ? converted : p,
            error: r.exitCode !== 0 ? (r.stderr.text.trim() || 'wslpath failed') : null
          }
        }
      },
      {
        name: 'win_drives',
        description: 'List the Windows drives currently mounted in WSL (e.g. c -> /mnt/c). Useful before accessing Windows paths.',
        parameters: {},
        output: { schema: { type: 'json' }, render: renderJson },
        async execute(_args, exec) {
          const r = await run(`ls -1 /mnt 2>/dev/null | grep -E '^[a-z]$'`, exec, { timeoutMs: 10000 })
          const drives = r.stdout.text.split('\n').map((s) => s.trim()).filter(Boolean)
            .map((d) => ({ drive: d.toUpperCase(), wslPath: '/mnt/' + d, winPath: d.toUpperCase() + ':\\' }))
          return { drives, raw: r.stdout.text }
        }
      }
    ]

    for (const tool of tools) {
      ctx.effect(() => harness.registerTool(ctx, harness.defineTool(tool)))
    }
  }
}
