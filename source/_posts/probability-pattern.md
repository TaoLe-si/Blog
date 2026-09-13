---
title: 概率样板：把随机产出写成置信区间
date: 2026-09-13 17:15:00
tech: true
categories:
  - 编程
tags:
  - AE2
  - Minecraft
  - Mixin
  - 形式化
  - 概率
description: 从 Probability Pattern 的 Mixin 接管点讲起：随机产出被写成二项分布，规划尝试次数使少产风险不超过 α；小样本精确累加左尾，大样本用正态近似，并给出单调性证明与运行路径。
---

本文对应 [Probability-Pattern](https://github.com/TaoLe-si/Probability-Pattern) 的源码。模组给 AE2 加了一种**概率样板**：机器每次跑都以概率 $p$ 成功，计划里不能再按「成功一次算一次」扣材料。下面分两块写：先指出 Mixin 挂在哪、和 AE2-VM 怎么共存，再把规模计算写成公式并证明它找的是满足风险约束的最小尝试次数。

<!-- more -->

## 1. 问题与接管点

AE2 原版处理样板假定：跑 $k$ 次就得到 $k$ 份输出。GT 副产、魔法模组的概率合成都不是这样。若仍按期望 $\lceil N/p \rceil$ 下单，大约一半的计划会少产——CPU 显示完成，箱子里却不够。

概率样板把「单次尝试的输入、目标产物、成功率 $p$、显著性水平 $\alpha$」写进物品的数据组件，计算阶段再按请求量 $N$ 放大输入。默认 $p = 0.8$，$\alpha = 0.05$（少产风险不超过 5%）。

整个模组两个 Mixin，写在 `src/main/resources/statpatterns.mixins.json` 里：

```json
{
  "required": true,
  "minVersion": "0.8",
  "package": "com.tz.statpatterns.mixin",
  "compatibilityLevel": "JAVA_21",
  "mixins": [
    "CraftingTreeNodeMixin",
    "CraftingServiceMixin"
  ],
  "injectors": { "defaultRequire": 1 },
  "priority": 500
}
```

`priority: 500` 低于 AE2-VM 默认的 1000：本模组的 `HEAD` 注入先跑。`CraftingTreeNodeMixin` 负责真正的规模计算；`CraftingServiceMixin` 只在装了 AE2-VM 时把请求从 JIT 路径拧回原生合成树——二项左尾挂在树上，VM 字节码路径会整段绕开它。

### 1.1 `CraftingTreeNodeMixin`：按节点注入请求量

AE2 在 `CraftingTreeNode#request` 里先从库存扣能扣的，剩下的才 `buildChildPatterns()`。Mixin 在即将建子树之前截住这个剩余量：

```java
@ModifyVariable(
    method = "request",
    at = @At(value = "INVOKE",
        target = "Lappeng/crafting/CraftingTreeNode;buildChildPatterns()V"),
    argsOnly = true)
private long captureRequested(long requestedAmount) {
    this.probabilityTotalRequested = requestedAmount * this.amount;
    return requestedAmount;
}
```

`requestedAmount * this.amount` 的实际作用：节点上的 `amount` 是这份配方一次产出的份数，乘完才是**还缺多少个物品**。库存已经垫过的部分不会再进二项模型。

然后在 `buildChildPatterns` 里把 `ICraftingService#getCraftingFor` 的返回值包一层：

```java
if (p instanceof StatPatternsDetails spd) {
    result.add(spd.forRequest(this.probabilityTotalRequested));
} else {
    result.add(p);
}
```

`forRequest(total)` 的实际作用：造一个带了 `requestedOutputAmount` 的 `StatPatternsDetails`。后面 `getInputs()` 看到这个字段，才会按尝试次数放大材料；没注入时仍返回「单次尝试」的输入，编码终端的 tooltip 不会被算崩。

### 1.2 `StatPatternsDetails`：尝试次数变成输入乘数

```java
public IInput[] getInputs() {
    if (requestedOutputAmount != null) {
        var sizing = sizing();
        return encoded.inputsPerAttempt().stream()
            .map(input -> new Input(input.what(),
                Math.multiplyExact(input.amount(), sizing.attempts())))
            .toArray(IInput[]::new);
    }
    // 未绑定请求：编码界面只展示单次尝试
    ...
}

public StatPatternsSizingResult sizing() {
    var targetOutput = requestedOutputAmount != null
        ? requestedOutputAmount
        : encoded.output().amount();
    var successes = Math.max(1, targetOutput);
    return StatPatternsSizing.planAttempts(
        successes, encoded.successProbability(),
        encoded.alpha(), encoded.smallSampleLimit());
}
```

源码注释写明：目标成功次数用**物品个数**，不用 $\lceil N / \text{output.amount()} \rceil$。后者在单次产出大于 1 时会把置信度算在「配方次数」而不是「物品件数」上，计划能通过、箱子却少。

链式合成时每一层节点各自 `forRequest`，中间产物也按同一 $\alpha$ 放大——不是只在树根算一次再往下乘。

### 1.3 `CraftingServiceMixin`：把概率请求从 AE2-VM 拧回来

AE2-VM 对类名以 `appeng.` 开头的 requester 走 JIT，合成树整段不建，`CraftingTreeNodeMixin` 不会跑，二项放大会静默消失。本模组的应对不是抢 `order`，而是换 requester 的类名：

```java
if (!ModList.get().isLoaded("ae2vm")) return;
// 顶层产物对应的样板里没有 StatPatternsDetails 则放行，让 VM 继续加速
if (!isProbability) return;

ICraftingSimulationRequester wrapped = new StatPatternsRequester(simRequester);
STATPATTERNS_FALLBACK.set(Boolean.TRUE);
cir.setReturnValue(((CraftingService) (Object) this)
    .beginCraftingCalculation(level, wrapped, what, amount, strategy));
cir.cancel();
```

`StatPatternsRequester` 在 `com.tz.statpatterns.` 下，故意不注册进 `AE2VMCraftingRegistry`。VM 把它当未 opt-in 的第三方，回落到原生 `beginCraftingCalculation`。非概率请求原样放过。ThreadLocal 防止自己 `HEAD` 重入。检测 AE2-VM 只用 `ModList`，不引用 `com.ae2vm.*`，没装 VM 时这段代码不会碰到它的类。

---

## 2. 符号与定义

令一次尝试独立成功的概率为 $p \in (0,1]$，目标产出为 $N \in \mathbb{Z}^+$，可接受的少产风险为 $\alpha \in (0,1)$。编码时写入 `EncodedStatPatterns` 的是 $p$、$\alpha$ 和 `smallSampleLimit` $M$（默认 $30$）；$N$ 来自合成树节点，不是编码时定死的。

### 定义 2.1（尝试过程）

$n$ 次独立尝试的成功次数

$$X_n \sim \operatorname{Bin}(n, p),\qquad \Pr(X_n = k) = \binom{n}{k} p^k {(1-p)}^{n-k}.$$

$p = 1$ 时退化为确定性配方，$n = N$。

### 定义 2.2（风险约束）

可行尝试次数集合

$$\mathcal{N}(N,p,\alpha) = \{ n \geq N : \Pr(X_n < N) \leq \alpha \}.$$

规模计算要的是

$$n^\star = \min \mathcal{N}(N,p,\alpha).$$

$n \geq N$：每次尝试最多成功一次，少于 $N$ 次不可能凑满 $N$ 个成功。

### 定义 2.3（朴素期望计划）

$$n_{\mathrm{naive}} = \max\!\left(N,\ \lceil N/p \rceil\right).$$

这是 $\mathbb{E}[X_n] \geq N$ 的最小整数。它**不**在 $\mathcal{N}$ 里，除非 $\alpha \geq 1/2$ 附近——因为 $n = n_{\mathrm{naive}}$ 时均值刚好压在 $N$ 上，$\Pr(X_n < N)$ 大约一半。

---

## 3. 精确二项（$N \leq M$）

### 引理 3.1（左尾对 $n$ 单调不增）

固定 $p,N$。令 $f(n) = \Pr(X_n < N)$。则 $f(n+1) \leq f(n)$。

令 $X_{n+1} = X_n + B$，$B \sim \mathrm{Bernoulli}(p)$ 与 $X_n$ 独立。

$$\{X_{n+1} < N\} = \{X_n \leq N-2\} \cup \{X_n = N-1,\ B = 0\} \subseteq \{X_n \leq N-1\} = \{X_n < N\}.$$

因此 $f(n+1) \leq f(n)$。$n \to \infty$ 时 $f(n) \to 0$，故 $\mathcal{N}$ 非空。

### 定理 3.2（线性搜索得到 $n^\star$）

从 $n \leftarrow n_{\mathrm{naive}}$ 起，若 $f(n) > \alpha$ 则 $n \leftarrow n+1$，直到 $f(n) \leq \alpha$。停机值等于 $n^\star$。

由引理 3.1，$\{n : f(n) \leq \alpha\}$ 是某点之后的整段。$n_{\mathrm{naive}} \leq n^\star$（$\alpha < 1/2$ 的常用区制下均值必须严格大于 $N$），故不会跳过最小值。对应：

```java
private static StatPatternsSizingResult exactBinomialPlan(long N, double p, double alpha) {
    var attempts = Math.max(N, (long) Math.ceil(N / p));
    while (binomialLowerTail(attempts, p, N - 1) > alpha) {
        attempts++;
    }
    return new StatPatternsSizingResult(N, attempts);
}
```

`binomialLowerTail(n, p, N-1)` 算的就是 $f(n) = \Pr(X_n \leq N-1)$。

### 命题 3.3（相邻项递推）

令 $q = 1-p$。则 $\Pr(X_n = 0) = q^n$，且对 $k \geq 1$

$$\frac{\Pr(X_n = k)}{\Pr(X_n = k-1)} = \frac{n-k+1}{k} \cdot \frac{p}{q}.$$

由二项式系数比 $\binom{n}{k}/\binom{n}{k-1} = (n-k+1)/k$ 直接得到。源码不调 `BigInteger` 阶乘，而是累乘这个比值，避免 $n$ 到几十时 $\binom{n}{k}$ 溢出：

```java
var probability = Math.pow(q, attempts); // P(X=0)
var sum = probability;
for (long k = 1; k <= maxSuccesses; k++) {
    probability *= ((attempts - k + 1.0) / k) * (p / q);
    sum += probability;
}
return Math.min(1.0, sum);
```

浮点误差用 `Math.min(1, sum)` 截断。$N \leq 30$ 时项数少，双精度够用；这也是默认切到正态近似的界。

---

## 4. 正态近似（$N > M$）

### 定理 4.1（De Moivre–Laplace）

$n \to \infty$ 且 $p$ 固定时

$$\frac{X_n - np}{\sqrt{np(1-p)}} \ \Rightarrow \ \mathcal{N}(0,1).$$

于是

$$\Pr(X_n < N) \approx \Phi\!\left(\frac{N - np}{\sqrt{np(1-p)}}\right).$$

要求右端 $\leq \alpha$，等价于

$$\frac{np - N}{\sqrt{np(1-p)}} \geq z_{1-\alpha},\qquad z_{1-\alpha} = \Phi^{-1}(1-\alpha).$$

$\alpha = 0.05$ 时 $z_{0.95} \approx 1.645$；$\alpha = 0.01$ 时 $z_{0.99} \approx 2.326$。源码没有做连续性校正（不加 $N-\tfrac12$），偏保守还是偏冒险取决于 $N$ 落在均值哪一侧；切分点 $M = 30$ 是为了让 $np$ 与 $n(1-p)$ 都别太小。

### 定理 4.2（近似可行集仍对 $n$ 单调）

令

$$z(n) = \frac{np - N}{\sqrt{np(1-p)}}.$$

$n > N/p$ 时 $z(n)$ 对 $n$ 严格递增。因此 $\{n : z(n) \geq z_{1-\alpha}\}$ 仍是一条右射线，从 $n_{\mathrm{naive}}$ 往上加一格，停在第一个越过阈值的 $n$。

$n$ 增大时分子 $np-N$ 线性涨，分母只按 $\sqrt{n}$ 涨，$z'(n) > 0$。对应：

```java
var z = inverseStandardNormal(1.0 - alpha);
var attempts = Math.max(N, (long) Math.ceil(N / p));
while (normalZ(N, attempts, p) < z) {
    attempts++;
}

private static double normalZ(long N, long n, double p) {
    var mean = n * p;
    var variance = n * p * (1.0 - p);
    return (mean - N) / Math.sqrt(variance);
}
```

`inverseStandardNormal` 是 Acklam 有理逼近：中间用 $(a,b)$ 多项式，两侧尾用 $(c,d)$。不引入外部统计库，模组加载期也不做数值积分。

### 命题 4.3（与期望计划的差距）

解 $np - N = z\sqrt{np(1-p)}$ 取大于 $N$ 的根，得到

$$n \approx \frac{N}{p} + \frac{z^2(1-p)}{2p} + O\!\left(\frac{z}{\sqrt N}\right).$$

额外尝试次数随 $\sqrt N$ 相对变慢，但**常数项**在 $N = 100$ 已经看得见。$p = 0.8$、$\alpha = 0.05$、$N = 100$：$n_{\mathrm{naive}} = 125$，正态近似给出 $n^\star \approx 135$。那多出来的约 10 次，就是把「一半概率刚好够」抬到「少产风险 $\leq 5\%$」。

---

## 5. 一次请求怎么跑完

编码时终端写入 `EncodedStatPatterns(inputsPerAttempt, output, p, α, 30, isAlpha95)`。计算时：

1. AE2 进入 `CraftingService.beginCraftingCalculation`。若装了 AE2-VM 且顶层样板是概率样板，Mixin 把 requester 换成 `StatPatternsRequester`，取消当前调用，再调一次原生入口。
2. 原生路径建 `CraftingTreeNode`。每个节点 `request` 扣库存后，`captureRequested` 记下缺口。
3. `buildChildPatterns` 对 `StatPatternsDetails` 调用 `forRequest(缺口)`。
4. `sizing()` → `StatPatternsSizing.planAttempts`：
   - $p = 1$：直接 $n = N$；
   - $N \leq 30$：精确左尾；
   - $N > 30$：正态 $z$ 检验。
5. `getInputs()` 把每格输入乘上 $n^\star$。供应器一次性推出「单次输入 $\times$ 尝试次数」，CPU 按放大后的处理配方跑。

没有随机数。计划阶段只决定**要预备多少次尝试**；真正每次机器成功与否仍由原版／其它模组掷骰。模组保证的是：按这个计划备料，少产事件的模型概率不超过 $\alpha$。

---

## 6. 结论

- 随机产出的规划问题是 $\min\{n \geq N : \Pr(\operatorname{Bin}(n,p) < N) \leq \alpha\}$，不是 $\lceil N/p \rceil$。后者均值贴着目标，大约一半计划会少。
- $N \leq 30$ 用相邻项递推累加左尾，并由单调性证明线性搜索得到最小值；$N > 30$ 换成 $z_{1-\alpha}$ 单侧界，同样单调。
- 运行时放大发生在合成树节点上：`CraftingTreeNodeMixin` 注入缺口，`getInputs()` 按 $n^\star$ 乘材料。AE2-VM 会绕开这棵树，所以概率请求被包成第三方 requester，强迫走原生路径；普通请求不碰，JIT 照常加速。
