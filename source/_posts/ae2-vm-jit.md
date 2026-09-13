---
title: AE2 合成计算的 VM 化与 JIT 化
date: 2026-09-13 16:30:00
tech: true
categories:
  - 编程
tags:
  - 虚拟机
  - JIT
  - Mixin
  - 形式化
  - AE2
  - Minecraft
description: 从 AE2-VM 的 Mixin 入口与闪电库（Thunderbolt Core）的版本化兼容讲起，再用形式化方法说明递归合成树的指数下界，以及栈式 VM / JIT 的等价构造。
---

本文对应 [AE2-VM](https://github.com/TaoLe-si/AE2-VM) 的源码。模组把 AE2 原版的递归合成树遍历换成栈式虚拟机执行编译后的字节码。下面分两块写：先指出 Mixin 挂在哪、**和 ECO 的兼容实际交给闪电库处理**（1.20.1 / 1.21.1 有版本要求，26.1 目前没有措施），再用形式化语言把算法骨架讲清楚。

<!-- more -->

## 1. Mixin 接管点与冲突面

整个模组只有三个 Mixin，全部写在 `src/main/resources/ae2vm.mixins.json` 里，并且 `remap = false`——目标是 AE2 自己的类名，不是 Minecraft 的混淆名。

```json
{
  "required": true,
  "minVersion": "0.8",
  "package": "com.ae2vm.addon.mixin",
  "compatibilityLevel": "JAVA_21",
  "mixins": [
    "CraftingServiceMixin",
    "PatternProviderLogicMixin",
    "CraftingSimulationStateAccessor"
  ],
  "injectors": { "defaultRequire": 1 }
}
```

`defaultRequire: 1` 的实际作用：注入点对不上（AE2 改了方法签名、换了版本）时，**游戏直接启动失败**，而不是静默跳过。这是版本锁。

冲突面分两层：Mixin 只负责挂上 AE2 自己的入口；和 ECO 等附属的共存，在 1.20.1 / 1.21.1 上已经交给闪电库（Thunderbolt Core）做引擎路由，不再靠 Mixin `order` 互抢。26.1 这条线目前没有对应措施。没走闪电库、自己再打同一入口的模组，仍然可能把兼容打坏。

### 1.1 `CraftingServiceMixin`：AE2 的计算入口

目标方法：

`appeng.me.service.CraftingService#beginCraftingCalculation`

这是 AE2 **自身**合成计算的入口。终端点合成、接口请求最终会进这里。AE2-VM 在方法最开头（`HEAD`）注入，并且可以取消原方法：

```java
/**
 * 顶层 mixin。1.21.1 NeoForge 的 Mixin 支持 order；
 * Forge 47（1.20.1）捆绑 Mixin 0.8.5，@Inject 没有 order 属性，
 * 不能写 order=100（编译期报错，运行期也会被忽略）。
 * 1.20.1 若要卡注入先后，只能走 mixin 配置的 priority。
 */
@Inject(method = "beginCraftingCalculation", at = @At("HEAD"), cancellable = true)
private void vmBeginCraftingCalculation(...) { ... }
// 1.21.1 可再加 order = 100；1.20.1 Forge 的 Mixin 0.8.5 没有这个属性。
```

`cancellable = true` + `HEAD` 的实际作用：原方法一行都没跑之前，就可以把返回值换成 VM 的 `Future`。这是加速来源，也是**未走闪电库的第三方**一旦同样注入这个方法，仍可能互相覆盖的原因。

源码用四道闸决定「这条请求要不要由 VM 算」：

```java
if (!AE2VMConfig.isProxyEnabled()) {
    return; // 配置关掉：当没装 VM
}
if (VM_FALLBACK.get()) {
    return; // 正在回退原生，禁止重入
}
if (cir.isCancelled()) {
    return; // 已有更早的 HEAD mixin 接管，让路
}
if (isUnregisteredThirdPartyRequester(simRequester)) {
    // 未 opt-in 的第三方 requester → 不接管
    VM_FALLBACK.set(Boolean.TRUE);
    try {
        cir.setReturnValue(((CraftingService) (Object) this)
            .beginCraftingCalculation(level, simRequester, what, amount, strategy));
        cir.cancel();
    } finally {
        VM_FALLBACK.remove();
    }
    return;
}
```

| 闸门 | 实际作用 |
|------|----------|
| `proxy.enabled=false` | Mixin 还在，但不 `cancel` |
| `VM_FALLBACK` | 回退原版时必须穿过本 Mixin，否则死递归 |
| `cir.isCancelled()` | 别人已经接管，VM 不再覆盖 |
| 未注册第三方 | 类名不是 `appeng.*`、又没 `AE2VMCraftingRegistry.register()` → 把入口还回去 |

通过闸门后：

```java
var vmFuture = AE2VMCrafting.calculate(grid, simRequester, what, amount, strategy)
    .handle((plan, ex) -> { /* VM 编不了则原生回退 */ ... });
cir.cancel();
cir.setReturnValue(vmFuture);
```

`calculate()` 在后台线程跑，不堵服务器主线程。这只覆盖 **AE2 自己发起的请求**。ECO 不再靠「谁的 Mixin order 更小」来抢这一行。

### 1.2 闪电库：1.20.1 / 1.21.1 的共用引擎路由

和 ECO（NeoECOAE）的共存，现在走 [Thunderbolt Core](https://www.mcmod.cn/class/29226.html)（闪电库）的合成规划引擎 API，而不是两边都 `HEAD` 注入 `beginCraftingCalculation`。

闪电库提供 `com.moakiee.thunderbolt.api.crafting` 这一套共用表面（`CraftingPlanningEngine`、`CraftingPlanningEngines`、`PlanningRequest` 等）。AE2-VM 作为其中一个引擎挂上去，ECO 等附属走同一张注册表。玩家用 `/thunderbolt engine ae2vm` 选中后，请求由闪电库路由过来，而不是 Mixin 互 `cancel`。

`1.20.1-forge` 上的注册（弱依赖，Thunderbolt 没装时整段不会碰到它的类）：

```java
public static void registerIfPresent() {
    if (!isThunderboltLoaded() || registered) return;
    // priority 900：低于闪电库 V2 默认的 1000，高于原版
    CraftingPlanningEngines.register(
        AE2VMBatchCraftingPlanner.INSTANCE,
        900,
        false);
}
```

引擎本体实现 `CraftingPlanningEngine`。选中 `ae2vm` 后，闪电库调 `createSession` → `attempt`，里面再调公开 API；VM 处理不了就 `DECLINE`，闪电库试下一个引擎，最后回落到原版 AE2：

```java
public final class AE2VMBatchCraftingPlanner implements CraftingPlanningEngine {
    public static final String ENGINE_ID = "ae2vm";

    // attempt() 里：
    var future = AE2VMCrafting.calculate(
        grid, request.requester(), request.output(), amount, request.strategy());
    ICraftingPlan plan = future.get(5, TimeUnit.MINUTES);
    return plan instanceof CraftingPlan cp
        ? PlanningAttempt.handled(cp)
        : PlanningAttempt.DECLINE;
}
```

没装闪电库时，行为回到 Mixin 直接接管所有 `appeng.*` 请求——这是默认路径，不是和 ECO 打架。

**版本要求**（两套 MC 共用同一份 planning-engine API，但运行时 jar 必须对得上）：

| 游戏版本 | 加载器 | 闪电库 | AE2-VM 侧 |
|----------|--------|--------|-----------|
| 1.20.1 | Forge 47 | Thunderbolt-Core **2.0.0-beta.1** 线（`1.20.1` 分支，带七字段 `api.crafting`） | `1.20.1-forge`：`registerIfPresent()` 有效 |
| 1.21.1 | NeoForge 21.1 | 同样需要带 `CraftingPlanningEngine` 的 **2.0** 线（`compileOnly` 曾用 `thunderbolt-2.0-alpha.jar`） | `1.21.1-neoforge`：API 对得上才能注册 |
| 26.1 | NeoForge 26.1 | **未移植**，没有这套引擎 API | `26.1.2-neoforge`：**目前无兼容措施** |

版本对不上的后果写在 1.21.1 的 stub 里：运行时 classpath 上没有 `CraftingPlanningEngine` 时，类初始化会 `NoClassDefFoundError`，游戏直接崩。所以缺 jar、或闪电库还是不含引擎 API 的旧包时，不能硬链接，只能整包 stub 掉。

```java
// 1.21.1 v1.13.16+ / 26.1：包是空的
// Thunderbolt 2.0.0-beta.1 absent from the runtime classpath
// → NoClassDefFoundError: CraftingPlanningEngine → crash
// To re-enable: restore sources, restore compileOnly on the matching jar,
// uncomment ThunderboltCompat.registerIfPresent();
```

**26.1** 的注释更直接：1.21.1 那套 `ThunderboltCompat` / `AE2VMBatchCraftingPlanner` **没有移植过来**。这条线上闪电库不负责 ECO 路由，Mixin 也没有另一套替代协议——和 ECO 等附属同时装，属于未覆盖的兼容空白。

即便 1.20.1 / 1.21.1 上闪电库版本正确，**没注册进引擎表、自己再 Mixin `beginCraftingCalculation` 的模组**仍然可以 `cancel` 掉 VM 的返回值，或在 VM `cancel` 之后覆盖 `Future`。闪电库只仲裁走了它的那些引擎，管不到旁路注入。

### 1.3 `PatternProviderLogicMixin`：样板列表的 TAIL 竞争

目标方法：`appeng.helpers.patternprovider.PatternProviderLogic#updatePatterns`，注入点是 **`TAIL`（方法即将返回时）**。

```java
@Shadow
private List patterns;

@Inject(method = "updatePatterns", at = @At("TAIL"))
private void onUpdatePatterns(CallbackInfo ci) {
    if (!AE2VMConfig.isProxyEnabled()) return;
    if (this.patterns == null || this.patterns.isEmpty()) return;

    for (IPatternDetails pattern : this.patterns) {
        if (PatternCompiler.getCompiled(pattern) == null) {
            PatternCompiler.compileIfAbsent(pattern);
        }
    }
}
```

实际作用：样板写进供应器的那一刻，就把配方编译成字节码，缓存起来。请求到来时不再现场走树。`DUP → RECORD_PATTERN → CALL_BY_KEY → EXTRACT → INSERT_OUTPUT → RETURN` 这条指令序列是在这里预先生成的。

冲突面比入口 Mixin 窄，但仍存在：

- ExtendedAE、多世界样板、覆盖 `PatternProviderLogic` 的模组，经常也在 `updatePatterns` 的 `TAIL` 上动手。
- Mixin 默认 `order = 1000`。谁晚谁看到的 `patterns` 才是最终列表。
- 若别人在更晚的 `TAIL` 才把样板塞进去，VM 会**漏编译**，第一次请求再懒编译，逻辑仍正确，只是丢失「编码时预热」。
- 若别人在更早的 `TAIL` 清空或替换列表，VM 可能编译到一份马上被扔掉的快照。

`@Shadow private List patterns` 读的是 AE2 的私有字段。字段改名或改类型时，这条 Mixin 会在启动期直接失败（同样吃 `defaultRequire: 1`）。

### 1.4 `CraftingSimulationStateAccessor`：读私有 `bytes`

```java
@Mixin(value = CraftingSimulationState.class, remap = false)
public interface CraftingSimulationStateAccessor {
    @Accessor
    double getBytes();
}
```

实际作用：AE2 把计划占用字节数放在包私有字段 `bytes` 里。VM 生成 `CraftingPlan` 时必须填同一个数，否则 CPU 调度、频道占用显示会和原版对不上。Accessor 是只读的，不改控制流。

可能的冲突：另一个模组也对同一个字段做 `@Accessor` / `@Mutable @Accessor`。只读 Accessor 一般会被 Mixin 合并；一旦有人改写成可写并在计算中途改 `bytes`，两边的计划会漂。字段被删或改类型则启动崩溃。

---

## 2. 符号与定义

令 $\mathcal{I}$ 为物品集合，$\mathcal{P}$ 为配方集合。

### 定义 2.1（配方 Pattern）

配方 $P \in \mathcal{P}$ 是五元组 $P = (I_P, O_P, \sigma_P, \rho_P, \delta_P)$：

- $I_P$：有限多重输入集
- $O_P$：有限多重输出集
- $\sigma_P$：替换映射（空表示无替换槽）
- $\rho_P$：槽位类型，$\{\mathrm{exact}, \mathrm{sub}\}$
- $\delta_P$：有限次使用参数（耐久工具），可取 $\infty$

对应编译器里的两处现实约束：处理配方默认模糊；只有 `getPossibleInputs().length > 1` 的槽才发 `FUZZY_SLOT`。精确槽拿替换物顶上，计划能算完、CPU 却卡在进度 0——这是 2026-08-09 那次假可行。

### 定义 2.2（合成请求）

$R = (I^*, N, S)$，其中 $I^*$ 是目标物品，$N$ 是数量，$S$ 是网络库存。

### 定义 2.3（合成树）

$T = (V, E, \lambda)$ 是有根带标号 DAG。内部节点标 $(P_v, m_v)$（配方与执行次数），叶节点标 $(i_v, c_v)$（物品与数量）。边表示产出被上游消耗。

### 定义 2.4（递归算法 $\mathcal{A}_{\mathrm{rec}}$）

给定 $R = (I^*, N, S)$：

1. 若 $S(I^*) \geq N$，返回使用库存。
2. 否则取主输出为 $I^*$ 的配方 $P$，记 $d$ 为该输出重数。
3. $k = \lceil N / d \rceil$。
4. 对每个输入 $(i, c)$ 递归 $\mathcal{A}_{\mathrm{rec}}(i, c \cdot k, S')$。
5. 返回本次合成与子结果的并。

这就是 AE2 原版在 `beginCraftingCalculation` 方法体里做的事。Mixin 一旦 `cancel`，这条路径整段不会走。

### 定义 2.5（字节码）

程序是有限指令序列。指令集见仓库 README，核心几条：

| 指令 | 实际作用 |
|------|----------|
| `PUSH_LONG` / `MUL` | 把「合成次数 × 每份消耗」变成栈上的数 |
| `CALL` / `CALL_BY_KEY` | 进入子样板。后者按物品 Key 运行时懒解析 |
| `EXTRACT_INGREDIENT` | 从模拟库存扣原料，扣不够的记入缺失 |
| `INSERT_OUTPUT` | 把子样板产物写回模拟库存，供后续 EXTRACT 使用 |
| `RECORD_PATTERN` | 告诉 AE2「这个样板要跑 $k$ 次」，否则 CPU 不会派工 |
| `CATALYST_SEED` / `DURABILITY_TOOL` | 催化剂只计一次种子；耐久工具按 $\lceil t / u \rceil$ 计件 |
| `FUZZY_SLOT` | 仅标记**下一个** `CALL_BY_KEY` 为替换槽 |
| `HALT` | 停机，吐出计划表 |

### 定义 2.6（VM 状态）

$\sigma = (\pi, pc, s, m)$：当前程序、程序计数器、BigInteger 栈、计划表。

### 定义 2.7（编译 $\mathcal{C}$）

对每个输入生成「压入消耗、调用子样板、抽取库存」序列，最后 `INSERT_OUTPUT` + `RETURN`。对应 `PatternCompiler.compilePattern()`。

---

## 3. 递归算法的复杂度

### 定理 3.1（递归下界）

令 $T(n, d)$ 为 $\mathcal{A}_{\mathrm{rec}}$ 在 $n$ 节点、深度 $d$ 的合成树上的时间，则

$$T(n, d) = \Omega(2^d).$$

构造自指配方族 $P_k : A + B \to 2A$。请求 $R_k = (A, 2^k, S)$，$S(B)$ 充分大。每执行一次净增 1 个 $A$，下一层调用次数翻倍：

$$T(d) = 2 \cdot T(d-1),\quad T(0) = 1 \Rightarrow T(d) = 2^d.$$

每调用做 $O(1)$ 工作，总时间为 $\Omega(2^d)$。

**推论。** $d = 24$ 时约 $1.6 \times 10^7$ 次基本操作，已经超过人能等的阈值；$d = 30$ 时约 $10^9$，无法在线完成。这就是扩展包无限存储元件把原版 AE2 卡死的原因。

---

## 4. 栈式虚拟机

### 定义 4.1（执行）

$\mathrm{Exec}(\pi, N, S)$ 从栈 $[N]$、空计划表出发，反复应用转移函数直到 `HALT`。

### 定理 4.1（VM 复杂度）

设 $B$ 为请求触及的全部字节码总长，$k_P$ 为配方 $P$ 的调用次数，则

$$T_{\mathrm{VM}} = O\!\left(\sum_{P} k_P \cdot |\mathcal{C}(P)|\right).$$

每条指令 $O(1)$，帧内 $pc$ 单调递增。无 JIT 时仍可能随调用次数线性涨；JIT 的工作就是把 $k_P$ 压下去。

**推论。** 首次编译后缓存命中、$k_P = 1$ 时，$T_{\mathrm{VM}} = O(B) = \Theta(n)$。

### 定理 4.2（无自引用下的语义等价）

对无自引用请求 $R$，递归计划与 VM 计划作为多重集相等。

对合成树结构归纳。叶节点两边都是「从库存扣 $N$」。内部节点上，递归按 $k = \lceil N/d \rceil$ 展开子问题；VM 用 `PUSH_LONG(c)` + `MUL` + `CALL` 做同一件事，`RECORD_PATTERN` / `INSERT_OUTPUT` 对应递归的合并步骤。

自引用（$A+B\to 2A$ 放大器、精华催化剂）不在本定理范围内，由 v1.10.3 的种子收敛单独处理：自产出抵消自消耗，主输出按净增修正合次数。

---

## 5. 递归与虚拟机的本质区别

递归操作的对象是**子问题** $(I, N, S')$，调度在 Java 调用栈上。VM 操作的对象是**栈上的数**，调度被编码成 `CALL` / `RETURN`。

所以：

1. **复杂度阶不同。** $T_{\mathrm{rec}} = \Theta(2^d)$，$T_{\mathrm{VM}} = \Theta(B)$。当 $d = \omega(\log n)$ 时递归更差。
2. **副作用的位置不同。** 递归在调用边界扣库存、合并计划；VM 的 `EXTRACT_INGREDIENT`、`RECORD_OUTPUT` 是指令级的，可以做 `scale(k)`：执行一次、把 amount 乘 $k$，而不必真的循环 $k$ 次。
3. **状态可缓存。** 配方 $P$ 编译成 $\mathcal{C}(P)$ 之后，不同 amount、不同请求共享同一份字节码。这是 JIT bundle 能跨请求活着的前提。`AE2VMCrafting` 按 `IGrid` 缓存 `CraftingVM`，就是为了让这份缓存不要每次请求都清空。

---

## 6. JIT 优化

### 定理 6.1（线性合成函数）

无自引用时 $f_P(aN) = a \cdot f_P(N)$。子问题线性，求和仍线性。这是缩放合法的代数前提。

### 定理 6.2（cts = 1 内联）

子样板只被父配方用一次时，把 `CALL(Q)` 换成 $Q$ 的指令体：

$$|\mathcal{C}_{\mathrm{inl}}(P)| = |\mathcal{C}(P)| + |\mathcal{C}(Q)| - 1,$$

执行结果不变。省掉的是帧管理和一次间接跳转。

### 定理 6.3（cts = $k$ 缩放）

`CALL(Q)` 前插入 `PUSH_LONG(k)` + `MUL`，只执行一次 $Q$，amount 变成 $kN$。由定理 6.1，$f_Q(kN) = k f_Q(N)$。加速比趋向 $k$：

$$\frac{T_{\mathrm{unscaled}}}{T_{\mathrm{scaled}}} \to k \quad (|\mathcal{C}(Q)| \to \infty).$$

催化剂种子刻意**不**乘 $k$（`CATALYST_SEED` 写在 bundle 的 `seeds` 里，`scale()` 不碰它），否则模板/温室方块会被报成缺 $k$ 个。

### 定理 6.4（跨请求缓存）

缓存键是库存指纹与配方哈希。同一网络第二次请求的编译代价 $O(1)$，对比首次 $O(B)$。

---

## 7. 加速比

对深度 $d$、节点数 $n$、平均 cts 为 $\bar{k}$ 的树：

| 优化 | 加速比 | 条件 |
|------|--------|------|
| 栈式 VM 替代递归 | $2^d / n$（$d=24$ 时最显著） | 任意 DAG |
| cts = 1 内联 | 去掉每层栈帧常数 | 子节点不复用 |
| cts = $k$ 缩放 | $k$ | 子节点 cts $> 1$ |
| 跨请求缓存 | $B / 1$ | 同一网络重复请求 |

仓库 README 1.10.7 的实测：$d = 14$、$n \sim 10^4$ 时递归约 90 s，VM 约 38 ms，约 $2400\times$。$d = 30$ 时递归算不完，VM + JIT 约 280 ms。

---

## 8. 结论

1. **递归最坏 $\Theta(2^d)$**（定理 3.1）。瓶颈是控制流「每层展开全部子问题」，不是某次乘法慢。
2. **无自引用时 VM 与递归语义等价**（定理 4.2），时间降到 $\Theta(n)$。调度从语言运行时搬到字节码之后，编译、缓存、缩放才成为合法变换。
3. **和 ECO 的共存不靠 Mixin `order` 互抢。** 1.20.1 / 1.21.1 由闪电库（Thunderbolt Core 2.0 的 `CraftingPlanningEngine`）做引擎路由，jar 版本必须对上；**26.1 目前没有兼容措施**。没走这张表、自己再打 `beginCraftingCalculation` 的模组，仍然可能把返回值盖掉。样板预编译的 `TAIL` 和 `bytes` Accessor 是次要冲突面。

递归和 VM 的差别不在「是不是栈式」，而在**调度结构放在哪**：递归把调度交给 JVM，VM 把调度变成数据。调度一旦是数据，1.20.1 / 1.21.1 上要抢的就不再是某几行递归代码，而是闪电库那张引擎表里的 `ae2vm` 这一格——26.1 还没有这张表。
