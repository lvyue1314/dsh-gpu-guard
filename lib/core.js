/**
 * dsh-gpu-guard core — find orphaned process trees that still hold the GPU and
 * kill them.
 *
 * Why this exists: on Windows a stopped agent (or a killed shell) does not take
 * its descendants with it. "bash run_train.sh" -> conda -> python -> python
 * worker keeps the CUDA context, and when the script loops or the supervisor
 * retries, the GPU is re-occupied minutes later. Nothing in the task manager
 * tells you which tree nobody owns any more; "parent pid no longer exists" does.
 */
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const VERSION = '0.1.0'

export const CONFIG_PATH =
  process.env.DSH_GPU_GUARD_CONFIG || path.join(os.homedir(), '.dsh', 'gpu-guard.json')
export const LOG_PATH = process.env.DSH_GPU_GUARD_LOG || path.join(os.homedir(), '.dsh', 'gpu-guard.log')

export const DEFAULT_CONFIG = {
  /** Reap automatically from the watchdog. Off by default: this kills processes. */
  autoReap: false,
  /** Watchdog period. */
  intervalSeconds: 60,
  /** How long a tree must stay orphaned before the watchdog touches it. */
  graceSeconds: 60,
  /** Never reap a tree whose chain matches one of these case-insensitive regexes. */
  protect: ['jupyter', 'nohup', 'code\.exe', 'explorer\.exe', 'services\.exe', 'svchost\.exe'],
}

/* ------------------------------------------------------------------ process */

export function run(file, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          error: error ? String(error.message ?? error) : null,
          durationMs: Date.now() - started,
        })
      },
    )
  })
}

const PROCESS_TABLE_PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$out = @()
foreach ($r in (Get-CimInstance -ClassName Win32_Process)) {
  $startMs = 0
  if ($r.CreationDate) { $startMs = [int64]([System.DateTimeOffset]([datetime]$r.CreationDate).ToUniversalTime()).ToUnixTimeMilliseconds() }
  $out += [pscustomobject]@{ pid = [int]$r.ProcessId; ppid = [int]$r.ParentProcessId; name = [string]$r.Name; cmd = [string]$r.CommandLine; start = $startMs }
}
ConvertTo-Json -InputObject $out -Compress -Depth 3
`

function encodedCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** pid -> { pid, ppid, name, cmd, start } for every process on the box. */
export async function scanProcesses() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const shell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = await run(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand(PROCESS_TABLE_PS)], {
    timeoutMs: 45000,
  })
  const text = result.stdout.trim()
  if (!text) throw new Error('process scan failed: ' + (result.error || result.stderr.slice(0, 400) || 'empty output'))
  let rows
  try {
    rows = JSON.parse(text)
  } catch (error) {
    throw new Error('process scan returned non-JSON: ' + String(error))
  }
  const table = new Map()
  for (const row of Array.isArray(rows) ? rows : [rows]) table.set(row.pid, row)
  return table
}

function nvidiaSmi() {
  if (process.env.DSH_NVIDIA_SMI && existsSync(process.env.DSH_NVIDIA_SMI)) return process.env.DSH_NVIDIA_SMI
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const candidate = path.join(systemRoot, 'System32', 'nvidia-smi.exe')
  return existsSync(candidate) ? candidate : 'nvidia-smi.exe'
}

/** GPU cards plus the pids that currently hold a compute context. */
export async function scanGpu() {
  const smi = nvidiaSmi()
  const cards = await run(smi, [
    '--query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu',
    '--format=csv,noheader,nounits',
  ])
  if (cards.code !== 0) {
    return { available: false, error: (cards.error || cards.stderr || 'nvidia-smi failed').slice(0, 400), gpus: [], holders: [] }
  }
  const gpus = cards.stdout
    .split(/\r?\n/)
    .map((line) => line.split(',').map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 6 && cells[0] !== '')
    .map((cells) => ({
      index: Number(cells[0]),
      name: cells[1],
      memoryUsedMiB: cells[2] === '[N/A]' ? null : Number(cells[2]),
      memoryTotalMiB: cells[3] === '[N/A]' ? null : Number(cells[3]),
      utilizationPercent: cells[4] === '[N/A]' ? null : Number(cells[4]),
      temperatureC: cells[5] === '[N/A]' ? null : Number(cells[5]),
    }))

  const apps = await run(smi, ['--query-compute-apps=pid,process_name,used_gpu_memory', '--format=csv,noheader,nounits'])
  const holders = apps.stdout
    .split(/\r?\n/)
    .map((line) => line.split(',').map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 2 && /^\d+$/.test(cells[0]))
    .map((cells) => ({
      pid: Number(cells[0]),
      name: path.basename(cells[1] || ''),
      path: cells[1] || '',
      memoryMiB: cells[2] && cells[2] !== '[N/A]' ? Number(cells[2]) : null,
    }))
  return { available: true, gpus, holders, error: null }
}

/* ----------------------------------------------------------------- analysis */

function matchesAny(proc, patterns) {
  const haystack = (proc.name || '') + ' ' + (proc.cmd || '')
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern, 'i').test(haystack)) return pattern
    } catch {}
  }
  return null
}

/**
 * Walk a pid up to the topmost ancestor that still exists.
 *
 * orphan is only true on positive evidence: a parent id that is gone, or a
 * parent that started after its child (PID reuse, so the original parent died).
 * A cycle or an over-long chain is ambiguous, and ambiguity is never reaped.
 * A chain that reaches a shell/service root (explorer, services, wininit, ...)
 * is system-owned: Windows reparents those, which is not abandonment.
 */
const SYSTEM_ROOT = /^(explorer|services|wininit|winlogon|svchost|smss|csrss|lsass|dwm|sihost|taskhostw|fontdrvhost|userinit)\.exe$/i

export function ancestry(pid, table, config = DEFAULT_CONFIG) {
  const chain = []
  const seen = new Set()
  let cur = table.get(pid)
  let orphan = false
  let ambiguous = false
  let root = null
  let protectedBy = null
  while (cur && !seen.has(cur.pid) && chain.length < 48) {
    seen.add(cur.pid)
    chain.push({ pid: cur.pid, ppid: cur.ppid, name: cur.name, cmd: cur.cmd, start: cur.start })
    if (!protectedBy) protectedBy = matchesAny(cur, config.protect ?? DEFAULT_CONFIG.protect)
    if (!cur.ppid || cur.ppid === cur.pid) { root = cur; break }
    const parent = table.get(cur.ppid)
    if (!parent) { orphan = true; root = cur; break }
    if (parent.start && cur.start && parent.start > cur.start + 2000) { orphan = true; root = cur; break }
    cur = parent
  }
  if (!root) {
    // Cycle or a chain longer than a sane tree: ownership is unknown, so this is
    // reported but never reaped.
    ambiguous = true
    root = chain.length ? chain[0] : null
  }
  if (root && SYSTEM_ROOT.test(root.name || '')) orphan = false
  return {
    pid,
    chain,
    orphan,
    ambiguous,
    protectedBy,
    rootPid: root ? root.pid : null,
    rootName: root ? root.name : null,
    rootCmd: root ? root.cmd : null,
    rootStart: root ? root.start : null,
    depth: chain.length,
  }
}

/** Full picture: cards, holders, and whether each holder's tree is orphaned. */
export async function inspect(config = loadConfig()) {
  const gpu = await scanGpu()
  // No compute context means nothing to reap; skip the ~1.5 s process table.
  const table = gpu.holders.length ? await scanProcesses() : new Map()
  const warnings = []
  const holders = gpu.holders.map((holder) => {
    const proc = table.get(holder.pid)
    if (!proc) {
      return { ...holder, orphan: false, rootPid: null, gone: true, chain: [], protectedBy: null }
    }
    const walk = ancestry(holder.pid, table, config)
    return {
      ...holder,
      name: proc.name || holder.name,
      cmd: proc.cmd,
      start: proc.start,
      orphan: walk.orphan,
      ambiguous: walk.ambiguous,
      protectedBy: walk.protectedBy,
      rootPid: walk.rootPid,
      rootName: walk.rootName,
      rootCmd: walk.rootCmd,
      rootStart: walk.rootStart,
      chain: walk.chain,
    }
  })
  const reapable = holders.filter((holder) => holder.orphan && !holder.ambiguous && !holder.protectedBy && holder.rootPid)
  const roots = []
  for (const holder of reapable) {
    if (!roots.some((root) => root.pid === holder.rootPid)) {
      roots.push({ pid: holder.rootPid, name: holder.rootName, cmd: holder.rootCmd, start: holder.rootStart, holders: [] })
    }
    roots.find((root) => root.pid === holder.rootPid).holders.push(holder.pid)
  }
  if (!gpu.available) warnings.push('nvidia-smi 不可用：' + gpu.error)
  else if (gpu.gpus.length === 0) warnings.push('未检测到 NVIDIA GPU')
  return { at: new Date().toISOString(), gpu, holders, reapable, roots, warnings }
}

/* -------------------------------------------------------------------- reaping */

/** Kill a whole tree by its topmost surviving pid, after re-checking identity. */
export async function killTree(pid, expectedStart) {
  const table = await scanProcesses()
  const proc = table.get(pid)
  if (!proc) return { pid, killed: false, reason: '进程已退出' }
  if (expectedStart && proc.start && Math.abs(proc.start - expectedStart) > 2000) {
    return { pid, killed: false, reason: 'PID 已被复用（启动时间不符），已跳过' }
  }
  const result = await run('taskkill.exe', ['/T', '/F', '/PID', String(pid)], { timeoutMs: 30000 })
  const output = (result.stdout + result.stderr).trim()
  const after = await scanProcesses()
  return { pid, name: proc.name, killed: !after.has(pid), taskkillExit: result.code, output: output.slice(0, 600) }
}

/** Reap every orphan GPU tree in roots; dry-run unless apply is true. */
export async function reap(roots, { apply = false } = {}) {
  const results = []
  for (const root of roots) {
    if (!apply) {
      results.push({ pid: root.pid, name: root.name, killed: false, dryRun: true })
      continue
    }
    try {
      results.push(await killTree(root.pid, root.start))
    } catch (error) {
      results.push({ pid: root.pid, name: root.name, killed: false, error: String(error) })
    }
  }
  const after = apply ? await scanGpu().catch(() => null) : null
  return { at: new Date().toISOString(), applied: apply, results, gpuAfter: after }
}

/* -------------------------------------------------------------------- config */

export function loadConfig() {
  const config = { ...DEFAULT_CONFIG }
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
      for (const key of Object.keys(DEFAULT_CONFIG)) {
        if (raw[key] !== undefined) config[key] = raw[key]
      }
    }
  } catch {}
  return config
}

export function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch }
  try {
    mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
    writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n')
  } catch {}
  return next
}

export function logLine(message) {
  const line = '[' + new Date().toISOString() + '] ' + message + '\n'
  try {
    mkdirSync(path.dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, line)
  } catch {}
  return line
}

/* ------------------------------------------------------------------ reporting */

export function shortCmd(cmd, limit = 110) {
  const text = String(cmd || '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? text.slice(0, limit) + '…' : text
}

export function formatHolders(analysis) {
  if (!analysis.holders.length) return ['（当前没有进程占用 GPU 计算上下文）']
  const lines = []
  lines.push('PID'.padEnd(7) + '进程'.padEnd(12) + '显存'.padEnd(10) + '状态')
  for (const holder of analysis.holders) {
    const state = holder.gone
      ? '已退出'
      : holder.orphan
        ? holder.protectedBy
          ? '孤儿，但命中保护规则 ' + holder.protectedBy + '（不动）'
          : '孤儿 ← 父进程已死（待杀根 ' + holder.rootPid + ' ' + holder.rootName + '）'
        : '正常（父进程存活）'
    const mem = holder.memoryMiB === null ? 'N/A' : holder.memoryMiB + ' MiB'
    const name = String(holder.name).length > 20 ? String(holder.name).slice(0, 19) + '…' : String(holder.name)
    lines.push(String(holder.pid).padEnd(7) + name.padEnd(21) + mem.padEnd(10) + state)
    if (holder.cmd) lines.push('        ' + shortCmd(holder.cmd))
    if (holder.orphan && !holder.protectedBy && holder.chain.length > 1) {
      lines.push('        祖先链: ' + holder.chain.map((item) => item.pid + '/' + item.name).join(' ← '))
    }
  }
  return lines
}

export function formatGpu(analysis) {
  if (!analysis.gpu.available) return ['GPU: nvidia-smi 不可用 — ' + analysis.gpu.error]
  return analysis.gpu.gpus.map((gpu) => {
    const mem = gpu.memoryUsedMiB === null ? '?' : gpu.memoryUsedMiB
    const total = gpu.memoryTotalMiB === null ? '?' : gpu.memoryTotalMiB
    return 'GPU ' + gpu.index + ' ' + gpu.name + ': ' + mem + '/' + total + ' MiB, 利用率 ' + (gpu.utilizationPercent ?? '?') + '%, ' + (gpu.temperatureC ?? '?') + '°C'
  })
}

export function formatReport(analysis) {
  const lines = ['== ' + analysis.at + ' ==', ...formatGpu(analysis), '']
  lines.push(...formatHolders(analysis))
  if (analysis.reapable.length) {
    lines.push('', '可回收的孤儿 GPU 进程树 ' + analysis.roots.length + ' 棵：')
    for (const root of analysis.roots) {
      lines.push('  ' + root.pid + ' ' + root.name + ' → 持有 GPU 的 ' + root.holders.join(', '))
      if (root.cmd) lines.push('      ' + shortCmd(root.cmd, 140))
    }
  } else {
    lines.push('', '没有需要回收的孤儿 GPU 进程树。')
  }
  for (const warning of analysis.warnings) lines.push('! ' + warning)
  return lines.join('\n')
}

