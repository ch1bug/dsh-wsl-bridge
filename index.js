// dsh-wsl-bridge — Windows access tools for WSL agents.
// Installed as a DSH bundle (`dsh plugin --profile <name> add .`).
// Registers win_ls / win_read / win_write / win_run / win_open / win_path /
// win_drives as model tools via the official defineTool + ctx.tools.register.
//
// No secrets, no machine-specific paths: everything runs through the host
// `shell` service with the calling session's sandbox policy.
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-wsl-bridge'
export const inject = ['tools', 'shell', 'sandboxPolicy']

export function apply(ctx) {
  // UTF-8-safe base64: Node's b64() rejects non-Latin-1 (Chinese file content
  // would throw "Invalid character"). Encode via TextEncoder + bytes first.
  function b64(s) {
    const bytes = new TextEncoder().encode(String(s))
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return btoa(bin)
  }
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
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const policy = sandboxPolicy === undefined ? undefined : sandboxPolicy.resolve(
      exec !== undefined && exec.agent !== undefined ? { session: exec.agent.session } : {}
    )
    const shell = ctx.get('shell')
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

  const tools = [
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
            const nm = line.trim()
            if (nm && nm !== 'total') entries.push({ name: nm })
          }
        }
        return {
          path: p, winPath: toWinPath(p), exitCode: r.exitCode, entries,
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
        const enc = b64(String(args.content ?? ''))
        const slash = p.lastIndexOf('/')
        const dir = slash > 0 ? p.slice(0, slash) : '/'
        const op = args.append === true ? '>>' : '>'
        const cmd = `mkdir -p ${shq(dir)} && printf '%s' ${enc} | base64 -d ${op} ${shq(p)}`
        const r = await run(cmd, exec, { timeoutMs: 20000 })
        return {
          path: p, winPath: toWinPath(p), exitCode: r.exitCode,
          bytes: new TextEncoder().encode(String(args.content ?? '')).length,
          error: r.exitCode !== 0 ? (r.stderr.text.trim() || 'write failed') : null
        }
      }
    },
    {
      name: 'win_run',
      description: 'Run a Windows program or command line and capture its output. shell="cmd" wraps with cmd.exe /c (UTF-8 codepage first); shell="powershell" writes a temp .ps1 (UTF-8 BOM, console output forced to UTF-8) and runs via powershell.exe -File; shell="direct" executes the string as-is in WSL bash (WSL interop for .exe). Windows paths for cwd converted automatically; cmd/powershell default to C:\\ when no cwd given.',
      parameters: {
        command: { type: 'string', required: true, description: 'Command line to run, e.g. "dir C:\\Users" (cmd), "Get-Process explorer" (powershell), or "/mnt/c/Windows/System32/ipconfig.exe /all" (direct)' },
        shell: { type: 'string', enum: ['cmd', 'powershell', 'direct'], description: 'How to execute: cmd (default) | powershell | direct' },
        cwd: { type: 'string', description: 'Working directory on the Windows side (Windows or WSL path)' },
        timeoutMs: { type: 'integer', description: 'Timeout in milliseconds (default 120000)' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args, exec) {
        const timeoutMs = args.timeoutMs !== undefined ? args.timeoutMs : 120000
        const workdir = args.cwd !== undefined ? toWslPath(args.cwd) : '/mnt/c'
        const rand = Math.random().toString(36).slice(2, 10)
        const command = String(args.command)
        if (args.shell === 'powershell') {
          const ps1 = `/mnt/c/Windows/Temp/dsh_${rand}.ps1`
          const script = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + command
          const enc = b64('\ufeff' + script)
          await run(`printf '%s' ${enc} | base64 -d > ${shq(ps1)}`, exec, { timeoutMs: 10000 })
          const r = await run(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${shq(toWinPath(ps1))}`, exec, { timeoutMs, workdir })
          await run(`rm -f ${shq(ps1)}`, exec, { timeoutMs: 5000 }).catch(() => {})
          return { shell: 'powershell', exitCode: r.exitCode, timedOut: r.timedOut, aborted: r.aborted, stdout: r.stdout.text, stderr: r.stderr.text }
        }
        if (args.shell === 'direct') {
          const r = await run(command, exec, { timeoutMs, workdir })
          return { shell: 'direct', exitCode: r.exitCode, timedOut: r.timedOut, aborted: r.aborted, stdout: r.stdout.text, stderr: r.stderr.text }
        }
        const bat = `/mnt/c/Windows/Temp/dsh_${rand}.bat`
        const enc = b64('@echo off\r\nchcp 65001 >nul\r\n' + command + '\r\n')
        await run(`printf '%s' ${enc} | base64 -d > ${shq(bat)}`, exec, { timeoutMs: 10000 })
        const r = await run(`cmd.exe /c ${shq(toWinPath(bat))}`, exec, { timeoutMs, workdir })
        await run(`rm -f ${shq(bat)}`, exec, { timeoutMs: 5000 }).catch(() => {})
        return { shell: 'cmd', exitCode: r.exitCode, timedOut: r.timedOut, aborted: r.aborted, stdout: r.stdout.text, stderr: r.stderr.text }
      }
    },
    {
      name: 'win_open',
      description: 'Open a Windows-side file or folder with its default Windows handler (explorer.exe). Explorer returns immediately with exit code 1 even on success.',
      parameters: {
        path: { type: 'string', required: true, description: 'File or folder to open' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args, exec) {
        const win = toWinPath(args.path)
        const r = await run(`explorer.exe ${shq(win)}`, exec, { timeoutMs: 15000 })
        return { winPath: win, wslPath: toWslPath(args.path), exitCode: r.exitCode, stdout: r.stdout.text, stderr: r.stderr.text, note: 'explorer.exe exits with code 1 on success; ignore nonzero exit if the app opened.' }
      }
    },
    {
      name: 'win_path',
      description: 'Convert a path between Windows (C:\\...) and WSL (/mnt/c/...) forms using wslpath. Pass either form; returns both.',
      parameters: {
        path: { type: 'string', required: true, description: 'Path to convert' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args, exec) {
        const p = String(args.path)
        const isWsl = p.startsWith('/')
        const flag = isWsl ? '-w' : '-u'
        const r = await run(`wslpath ${flag} ${shq(p)}`, exec, { timeoutMs: 10000 })
        const converted = r.exitCode === 0 ? r.stdout.text.trim() : null
        return { input: p, wslPath: isWsl ? p : converted, winPath: isWsl ? converted : p, error: r.exitCode !== 0 ? (r.stderr.text.trim() || 'wslpath failed') : null }
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
    ctx.tools.register(defineTool(tool))
  }
}
