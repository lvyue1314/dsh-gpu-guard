/**
 * dsh-gpu-guard — host half of a DSH plugin that stops the GPU from being eaten
 * by process trees nobody owns any more.
 *
 * Tools:
 *   gpu_status   GPU cards, the pids holding a compute context, and whether each
 *                holder's ancestor chain is still alive.
 *   gpu_reap     kill the orphaned trees (dry-run by default).
 *   gpu_guard    watchdog: watch / start / stop / configure auto-reaping.
 *
 * Why a plugin: the leak is a Windows process-tree fact, not a shell problem.
 * A stopped agent kills the shell it spawned, Windows does not cascade that to
 * grandchildren, and a retry loop in the surviving script re-occupies the GPU
 * minutes later. The watchdog notices "parent gone, still on the GPU" without
 * needing anything from the agent that started it.
 *
 * Verification route: GET /dsh-gpu-guard/state
 */
import {
  CONFIG_PATH,
  LOG_PATH,
  VERSION,
  formatGpu,
  formatHolders,
  formatReport,
  inspect,
  loadConfig,
  logLine,
  reap,
  saveConfig,
} from './core.js'

export const name = 'dsh-gpu-guard'
export const inject = ['tools']

const state = {
  timer: null,
  busy: false,
  /** pid -> first time this tree was seen orphaned */
  orphanSeen: new Map(),
  lastScan: null,
  lastReap: null,
  startedAt: new Date().toISOString(),
  ticks: 0,
  errors: 0,
  config: loadConfig(),
}

function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

const OBJECT_OUTPUT = { schema: { type: 'object' }, render: (_args, value) => text(value) }

/* -------------------------------------------------------------------- tools */

const gpuStatus = {
  name: 'gpu_status',
  description:
    '查看 GPU 占用：每张卡的显存/利用率/温度，以及当前持有 GPU 计算上下文的进程，并标出哪些进程的祖先链已经断了（孤儿——启动它的 agent/终端早就不在了）。',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  output: OBJECT_OUTPUT,
  async execute() {
    const analysis = await inspect(loadConfig())
    state.lastScan = analysis.at
    return {
      at: analysis.at,
      gpus: analysis.gpu.gpus,
      holders: analysis.holders.map((holder) => ({
        pid: holder.pid,
        name: holder.name,
        memoryMiB: holder.memoryMiB,
        orphan: holder.orphan,
        protectedBy: holder.protectedBy,
        rootPid: holder.rootPid,
        rootName: holder.rootName,
        chain: holder.chain?.map((item) => item.pid + '/' + item.name),
        cmd: holder.cmd,
      })),
      reapableRoots: analysis.roots.map((root) => ({ pid: root.pid, name: root.name, holds: root.holders })),
      warnings: analysis.warnings,
      report: formatReport(analysis),
    }
  },
}

const gpuReap = {
  name: 'gpu_reap',
  description:
    '结束占用 GPU 的孤儿进程树（父进程已死、没人能再拿到它输出的那些）。默认 dry-run 只报告；confirm=true 才真正 taskkill /T /F，并且杀的是整棵树最上面的那个孤儿根，避免脚本的重试循环又把子进程拉起来。',
  parameters: {
    type: 'object',
    properties: {
      confirm: { type: 'boolean', description: 'true 才真正结束进程；默认 false 只预览' },
      pids: { type: 'array', items: { type: 'integer' }, description: '只处理这些根 PID（默认处理全部可回收的孤儿根）' },
      includeProtected: { type: 'boolean', description: '连命中保护规则的树一起处理（默认不）' },
    },
    additionalProperties: false,
  },
  output: OBJECT_OUTPUT,
  async execute(args = {}) {
    const analysis = await inspect(loadConfig())
    let roots = analysis.roots
    if (args.pids?.length) roots = roots.filter((root) => args.pids.includes(root.pid))
    if (args.includeProtected) {
      const extra = analysis.holders.filter((holder) => holder.orphan && holder.protectedBy)
      for (const holder of extra) {
        if (!roots.some((root) => root.pid === holder.rootPid)) {
          roots.push({ pid: holder.rootPid, name: holder.rootName, cmd: holder.rootCmd, start: holder.rootStart, holders: [holder.pid] })
        }
      }
    }
    if (!roots.length) return { applied: false, report: '没有可回收的孤儿 GPU 进程树。', gpus: analysis.gpu.gpus }
    const outcome = await reap(roots, { apply: args.confirm === true })
    state.lastReap = outcome
    if (args.confirm) logLine('gpu_reap: ' + JSON.stringify(outcome.results))
    const lines = []
    for (const result of outcome.results) {
      lines.push((result.dryRun ? '[预览] ' : result.killed ? '[已结束] ' : '[失败] ') + result.pid + ' ' + (result.name || '') + (result.reason ? ' — ' + result.reason : ''))
    }
    if (!args.confirm) lines.push('', '以上是预览。确认无误后用 gpu_reap(confirm=true) 真正结束。')
    if (outcome.gpuAfter?.gpus?.length) lines.push('', ...outcome.gpuAfter.gpus.map((gpu) => '之后 GPU ' + gpu.index + ': ' + gpu.memoryUsedMiB + '/' + gpu.memoryTotalMiB + ' MiB, 利用率 ' + gpu.utilizationPercent + '%'))
    return { applied: outcome.applied, results: outcome.results, gpuAfter: outcome.gpuAfter?.gpus ?? null, report: lines.join('\n') }
  },
}

const gpuGuard = {
  name: 'gpu_guard',
  description:
    '后台看门狗：定时扫描 GPU 进程，孤儿树存活超过宽限期就自动结束（autoReap=true 时）。可查询状态、开关、改间隔/宽限期/保护正则。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'start', 'stop', 'configure'], description: '默认 status' },
      autoReap: { type: 'boolean', description: 'action=configure 时：是否自动结束孤儿树' },
      intervalSeconds: { type: 'integer', description: 'action=configure 时：扫描间隔秒' },
      graceSeconds: { type: 'integer', description: 'action=configure 时：孤儿存活多久才动手' },
      protect: { type: 'array', items: { type: 'string' }, description: 'action=configure 时：永不命中的保护正则列表' },
    },
    additionalProperties: false,
  },
  output: OBJECT_OUTPUT,
  async execute(args = {}) {
    const action = args.action || 'status'
    if (action === 'configure') {
      const patch = {}
      for (const key of ['autoReap', 'intervalSeconds', 'graceSeconds', 'protect']) {
        if (args[key] !== undefined) patch[key] = args[key]
      }
      state.config = saveConfig(patch)
      restartWatchdog()
    } else if (action === 'start') {
      state.config = saveConfig({ autoReap: true })
      restartWatchdog()
    } else if (action === 'stop') {
      state.config = saveConfig({ autoReap: false })
      restartWatchdog()
    }
    return {
      action,
      config: state.config,
      configPath: CONFIG_PATH,
      logPath: LOG_PATH,
      running: Boolean(state.timer),
      ticks: state.ticks,
      errors: state.errors,
      lastScan: state.lastScan,
      lastReap: state.lastReap,
      orphansPending: [...state.orphanSeen.keys()],
    }
  },
}

/* ------------------------------------------------------------------ watchdog */

async function tick() {
  if (state.busy) return
  state.busy = true
  try {
    state.ticks += 1
    const analysis = await inspect(state.config)
    state.lastScan = analysis.at
    if (!analysis.roots.length) {
      state.orphanSeen.clear()
      return
    }
    const now = Date.now()
    const due = []
    for (const root of analysis.roots) {
      const first = state.orphanSeen.get(root.pid) ?? now
      state.orphanSeen.set(root.pid, first)
      if (now - first >= Math.max(0, state.config.graceSeconds) * 1000) due.push(root)
    }
    for (const pid of [...state.orphanSeen.keys()]) {
      if (!analysis.roots.some((root) => root.pid === pid)) state.orphanSeen.delete(pid)
    }
    if (!due.length) return
    if (!state.config.autoReap) {
      for (const root of due) {
        const line = 'orphan gpu tree (report only): ' + root.pid + ' ' + root.name + ' holds ' + root.holders.join(',')
        console.log('[dsh-gpu-guard] ' + line)
      }
      return
    }
    const outcome = await reap(due, { apply: true })
    state.lastReap = outcome
    for (const result of outcome.results) {
      const line = 'auto-reap ' + (result.killed ? 'ok' : 'FAILED') + ': ' + result.pid + ' ' + (result.name || '') + (result.reason ? ' (' + result.reason + ')' : '')
      logLine(line)
      console.log('[dsh-gpu-guard] ' + line)
    }
  } catch (error) {
    state.errors += 1
    logLine('watchdog error: ' + String(error))
  } finally {
    state.busy = false
  }
}

function restartWatchdog() {
  if (state.timer) {
    clearInterval(state.timer)
    state.timer = null
  }
  const base = Math.max(5, Number(state.config.intervalSeconds) || 60)
  // A report-only watchdog does not need the fast cadence.
  const seconds = state.config.autoReap ? base : Math.max(60, base)
  state.timer = setInterval(() => { tick().catch(() => {}) }, seconds * 1000)
  if (typeof state.timer.unref === 'function') state.timer.unref()
}

/* --------------------------------------------------------------------- apply */

export function apply(ctx) {
  ctx.tools.register(gpuStatus)
  ctx.tools.register(gpuReap)
  ctx.tools.register(gpuGuard)

  state.config = loadConfig()
  restartWatchdog()
  logLine('plugin loaded pid ' + process.pid + ' autoReap=' + state.config.autoReap)

  const stop = () => {
    if (state.timer) clearInterval(state.timer)
    state.timer = null
  }
  try { ctx.on('dispose', stop) } catch {}
  try { process.on('exit', stop) } catch {}

  const webServer = ctx.get('webServer')
  if (webServer?.get) {
    webServer.get('/dsh-gpu-guard/state', async (req, res) => {
      const body = JSON.stringify({
        version: VERSION,
        startedAt: state.startedAt,
        config: state.config,
        configPath: CONFIG_PATH,
        logPath: LOG_PATH,
        running: Boolean(state.timer),
        ticks: state.ticks,
        errors: state.errors,
        lastScan: state.lastScan,
        lastReap: state.lastReap,
        orphansPending: [...state.orphanSeen.keys()],
      })
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(body)
    })
  }
}
