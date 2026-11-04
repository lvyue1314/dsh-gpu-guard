#!/usr/bin/env node
/**
 * gpu-guard CLI — see which processes hold the GPU, spot the ones whose owner is
 * already dead, and kill those trees.
 *
 *   gpu-guard status                 human report
 *   gpu-guard status --json          machine report
 *   gpu-guard reap                   dry run: list what would be killed
 *   gpu-guard reap --apply           kill the orphan trees
 *   gpu-guard watch [--apply]        loop; default interval 20s, grace 60s
 *   gpu-guard config [--auto]        print / update ~/.dsh/gpu-guard.json
 */
import { readFileSync } from 'node:fs'
import {
  CONFIG_PATH,
  inspect,
  loadConfig,
  logLine,
  reap,
  saveConfig,
  formatReport,
} from '../lib/core.js'

const argv = process.argv.slice(2)
const command = argv[0] || 'status'
const flags = new Set(argv.slice(1).filter((item) => item.startsWith('--')))

function usage() {
  console.log('用法: gpu-guard <status|reap|watch|config> [--json] [--apply] [--interval N] [--grace N]')
  process.exit(command === 'help' ? 0 : 2)
}

async function status() {
  const analysis = await inspect(loadConfig())
  if (flags.has('--json')) console.log(JSON.stringify(analysis, null, 2))
  else console.log(formatReport(analysis))
  return analysis
}

if (command === 'status') {
  await status()
} else if (command === 'reap') {
  const analysis = await status()
  if (!analysis.roots.length) process.exit(0)
  const applied = flags.has('--apply')
  const outcome = await reap(analysis.roots, { apply: applied })
  if (flags.has('--json')) console.log(JSON.stringify(outcome, null, 2))
  else {
    for (const result of outcome.results) {
      console.log((result.dryRun ? '[dry-run] ' : result.killed ? '[killed] ' : '[failed] ') + result.pid + ' ' + (result.name || '') + (result.reason ? ' — ' + result.reason : ''))
    }
    if (!applied) console.log('\n以上为预览。加 --apply 真正结束这些进程树。')
    if (outcome.gpuAfter?.gpus?.length) {
      for (const gpu of outcome.gpuAfter.gpus) console.log('之后: GPU ' + gpu.index + ' ' + gpu.memoryUsedMiB + '/' + gpu.memoryTotalMiB + ' MiB, 利用率 ' + gpu.utilizationPercent + '%')
    }
  }
  if (applied) logLine('reap applied: ' + JSON.stringify(outcome.results))
} else if (command === 'watch') {
  const apply = flags.has('--apply')
  const base = loadConfig()
  const intervalFlag = argv.find((item) => item.startsWith('--interval'))
  const graceFlag = argv.find((item) => item.startsWith('--grace'))
  const intervalSeconds = intervalFlag ? Number(intervalFlag.split('=')[1] ?? argv[argv.indexOf(intervalFlag) + 1]) : base.intervalSeconds
  const graceSeconds = graceFlag ? Number(graceFlag.split('=')[1] ?? argv[argv.indexOf(graceFlag) + 1]) : base.graceSeconds
  const orphanSeenAt = new Map()
  console.log('watch 启动：每 ' + intervalSeconds + 's 扫描，孤儿树存活超过 ' + graceSeconds + 's 后' + (apply ? '结束' : '只报告（加 --apply 才会结束）') + '。Ctrl+C 退出。')
  for (;;) {
    try {
      const analysis = await inspect(loadConfig())
      const now = Date.now()
      const due = []
      for (const root of analysis.roots) {
        const first = orphanSeenAt.get(root.pid) ?? now
        orphanSeenAt.set(root.pid, first)
        if (now - first >= graceSeconds * 1000) due.push(root)
      }
      if (analysis.roots.length === 0) orphanSeenAt.clear()
      if (due.length) {
        console.log('[' + new Date().toLocaleTimeString() + '] 孤儿树: ' + due.map((root) => root.pid + ' ' + root.name).join(', '))
        if (apply) {
          const outcome = await reap(due, { apply: true })
          for (const result of outcome.results) {
            const line = '[killed] ' + result.pid + ' ' + (result.name || '')
            console.log(line)
            logLine(line)
          }
        }
      }
    } catch (error) {
      console.error('扫描失败: ' + String(error))
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(5, intervalSeconds) * 1000))
  }
} else if (command === 'config') {
  if (flags.has('--auto')) {
    const next = saveConfig({ autoReap: true })
    console.log('已开启自动回收：' + CONFIG_PATH)
    console.log(JSON.stringify(next, null, 2))
  } else if (flags.has('--off')) {
    const next = saveConfig({ autoReap: false })
    console.log('已关闭自动回收：' + CONFIG_PATH)
    console.log(JSON.stringify(next, null, 2))
  } else {
    console.log(CONFIG_PATH)
    try { console.log(readFileSync(CONFIG_PATH, 'utf8')) } catch { console.log(JSON.stringify(loadConfig(), null, 2)) }
  }
} else {
  usage()
}
