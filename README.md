# dsh-gpu-guard

A DeepSeek Harness plugin that stops the GPU from being eaten by process trees nobody owns any more.

Windows · Node >= 22 · DSH >= 0.2.1-rc.5 · MIT

---

## 中文说明

### 它解决什么问题

你按了停止，agent 也真的停了，但任务管理器里 `python.exe` 还在吃显存，过一会儿 GPU 又被点满。
看起来像"停了又自己跑起来"，实际是两件事叠在一起：

1. **Windows 不会级联杀进程**。停掉 subagent 只杀掉它直接 spawn 的那个 shell（`pwsh` / `bash`），
   shell 下面的 `bash -> conda run -> python -> python worker` 全部变成孤儿，继续持有 CUDA 上下文。
2. **训练脚本自带重试/循环**。外层 shell 脚本是个 `for` 循环，训练入口还有 `--retries N`，
   于是每跑完一轮就再起一轮；你看到的"时不时又被占满"是新的一轮，不是旧进程复活。

一条典型的泄漏链（进程名与层级都是实测形状，内容已脱敏）：

```text
<launcher shell>            <- agent 停止时被杀掉的就是这一层
 └ bash run_train.sh        <- 从这里开始全部成为孤儿
   └ conda run -n myenv python -m pkg.train --retries 2
     └ cmd.exe /d /c %TEMP%\tmpXXXXXXXX.bat
       └ python -m pkg.train --worker
         └ python train.py  <- 持有 CUDA 上下文，显存与利用率都被它占着
```

命令行层面能做的只有 `taskkill /T /F /PID <根>`，但**你得先知道根是谁**，而且得在它重新拉起下一轮之前动手。
所以这个插件做两件事：把"谁是孤儿根"算出来；可选地让一个看门狗一直盯着。

### 判定规则（为什么可以放心杀）

对每个持有 GPU 计算上下文的 PID，向上走祖先链：

- 走到 `0` / 自身（System、服务宿主）→ **正常**，不动；
- 链上某个父 PID 已经不在进程表里 → **孤儿**，根 = 链上最上面那个还活着的进程；
- 父进程存在但它的启动时间比子进程还晚 → PID 被复用，原父进程其实已死 → 同样判孤儿；
- 链上有环、或长得超出合理深度 → **归属不明，一律不杀**；
- 链上任意一环命中 `protect` 正则（默认 `jupyter`、`nohup`、`code.exe`、`explorer.exe`、`services.exe`、`svchost.exe`）→ **跳过**。

真正的信号是"**发起它的那个进程没了**"，不是"它跑了很久"。所以你自己 `nohup` / 计划任务拉起来的常驻任务不受影响，
除非你把 `nohup` 从保护列表里删掉。

杀的时候杀的是**整棵树最上面的孤儿根**（`taskkill /T /F /PID 根`），不是最深那个 worker：
这样脚本里的重试循环和 supervisor 会被一起端掉，不会出现"杀了 worker、父进程又起一个"。

### 三种用法

#### 1. 命令行（不装插件也能用）

```bash
node bin/gpu-guard.mjs status              # 谁在占 GPU、谁是孤儿
node bin/gpu-guard.mjs reap                # 预览：会杀哪些树
node bin/gpu-guard.mjs reap --apply        # 真杀
node bin/gpu-guard.mjs watch --apply       # 常驻看门狗（默认 60s 扫一次、孤儿满 60s 才动手）
node bin/gpu-guard.mjs status --json       # 给脚本用
```

`--json` 输出结构：`{ at, gpu: { gpus, holders }, holders, roots, warnings }`。

#### 2. 插件工具（在对话里直接问）

| 工具 | 作用 |
| --- | --- |
| `gpu_status` | 每张卡的显存/利用率/温度 + 持有 GPU 的进程 + 祖先链 + 哪些是孤儿 |
| `gpu_reap` | 结束孤儿树。**默认 dry-run**，`confirm: true` 才真杀；可只处理指定 `pids` |
| `gpu_guard` | 看门狗状态 / 开 / 关 / 改配置（间隔、宽限期、保护正则） |

#### 3. 看门狗（autoReap）

```bash
node bin/gpu-guard.mjs config --auto     # 写 ~/.dsh/gpu-guard.json: { "autoReap": true }
```

插件加载时就会启动定时器；`autoReap=false` 时它只把孤儿树打到日志和 stderr，不杀。
孤儿树要**连续存活超过 `graceSeconds`（默认 60s）**才会被处理——短暂出现的孤儿（比如一个命令刚好结束）
不会被误杀。

### 安装

```bash
cd ~/.dsh/profiles/desktop
pnpm add link:/path/to/dsh-gpu-guard
```

然后二选一挂载：

**A. profile 的 `package.json`**

```json
{
  "dependencies": { "dsh-gpu-guard": "link:/path/to/dsh-gpu-guard" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-gpu-guard"] } }
}
```

**B. profile 的 `cordis.patch.yml`**

```yaml
- insert:
    - id: dsh-gpu-guard
      name: file:///path/to/dsh-gpu-guard/lib/entry.js
```

profile 若配置了 `patchReload: live`，下一次模型调用就能看到三个工具；否则重启 DSH。
命令行那份不依赖 DSH，`node bin/gpu-guard.mjs` 随时可用。

### 配置

`~/.dsh/gpu-guard.json`（环境变量 `DSH_GPU_GUARD_CONFIG` 可改路径）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `autoReap` | `false` | 看门狗是否自动结束孤儿树。默认关：这毕竟是杀进程 |
| `intervalSeconds` | `60` | 扫描间隔（一次完整扫描约 1.5s：nvidia-smi + WMI 进程表） |
| `graceSeconds` | `60` | 孤儿树要存活多久才动手 |
| `protect` | 见上 | 命中即跳过的正则，大小写不敏感，匹配进程名 + 完整命令行 |

日志追加到 `~/.dsh/gpu-guard.log`（环境变量 `DSH_GPU_GUARD_LOG`）。
插件状态也可以直接看：`GET http://127.0.0.1:<port>/dsh-gpu-guard/state`。

### 已知限制

- **WDDM 下每进程显存是 N/A**。`nvidia-smi` 在 WDDM 驱动上不给 per-process 显存，报告里显示 `N/A`；
  PID、卡片显存总量、利用率、温度都是准的。要精确数字需要 TCC 模式或 NVML 逐句柄查询，对"找出谁在偷 GPU"没有影响。
- **只看 GPU 计算上下文**。不碰 GPU 的孤儿进程不在处理范围（那是另一类问题）。
- **PID 复用**已经用启动时间校验挡掉；极端情况下（同一秒内 PID 被复用）仍有窗口，`killTree` 会在杀之前再读一次进程表确认。
- **不管"后台 job"**：如果进程是 DSH 的 background job（`run_in_background: true`），它本来就该活过 subagent——
  那是另一个语义，插件不替你判断，只按"祖先链断没断"这一条硬事实动手。

### 根治方案（给 core 的 issue）

插件是止血：它在**已经泄漏之后**把树收掉。根治要在 `dsh-subprocess-local` 那一层：
子进程以 suspended 创建、先 `AssignProcessToJobObject` 到带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job、再 resume
（`@deepseek-ai/dsh-win32-process` 里已经有 `spawnCurrentTokenJobProcess` 这套原语）。一旦每条 shell 命令都在自己的
Job 里，父进程死 = 整棵树被内核带走，根本不会有孤儿。

`dsh-pwsh-local` 的 `kill()` 走的是 `running.terminate()`，这条路径在 Windows + git-bash 环境下实测**没有**带走
git-bash 启动的后代（上面那条链就是证据），值得单独提 issue。

### 开发备注

`lib/core.js` 是纯函数层（扫描、祖先链、reap），插件和 CLI 共用同一份实现，没有第二套逻辑。
`lib/entry.js` 用带版本号的 specifier 重新导出，profile 热重载才会拿到新代码。
`examples/scheduled-task.ps1` 用计划任务代替常驻进程跑看门狗。

---

## English

A stopped agent does not take its descendants with it on Windows: the shell dies, the `bash -> conda -> python`
tree under it survives as an orphan and keeps the CUDA context. If the script loops or retries, the GPU is
re-occupied minutes later. This plugin finds those trees by walking each GPU holder up to the topmost ancestor
that still exists, and kills the whole tree from that root.

```bash
node bin/gpu-guard.mjs status          # what holds the GPU, and which trees are orphaned
node bin/gpu-guard.mjs reap --apply    # kill them (dry-run without --apply)
node bin/gpu-guard.mjs watch --apply   # keep watching
```

Tools exposed to the agent: `gpu_status`, `gpu_reap` (dry-run by default), `gpu_guard` (watchdog control).
Reaping requires positive evidence: a missing parent, or a parent that started after its child. Cycles,
over-long chains and anything matching the `protect` list are never touched.

## License

MIT
