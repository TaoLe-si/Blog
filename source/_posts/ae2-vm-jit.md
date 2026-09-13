---
title: AE2 合成计算的 VM 化与 JIT 化——递归算法的形式化分析与替代构造
date: 2026-09-13 16:30:00
categories:
  - 编程
tags:
  - 虚拟机
  - JIT
  - 形式化
  - 复杂度分析
  - AE2
  - Minecraft
description: 用形式化方法证明递归合成树在最坏情形下具有指数级复杂度，并给出栈式 VM 与 JIT 缓存的等价构造与加速比定理。
---

本文对 [AE2-VM](https://github.com/TaoLe-si/AE2-VM) 项目中合成计算引擎的算法骨架进行形式化重述。目标：(1) 证明 AE2 原版递归合成算法在最坏情形下的指数级复杂度下界；(2) 给出栈式虚拟机的字节码语义；(3) 证明递归算法与 VM 在无自引用情形下的语义等价性；(4) 给出三种 JIT 优化（子样板内联、消耗次数缩放、跨请求缓存）的正确性定理与加速比。

<!-- more -->

## 1. 符号与定义

令 $\mathcal{I}$ 为物品集合，$\mathcal{P}$ 为配方集合。$\mathbb{Z}_{>0}$ 为正整数集，$\mathbb{Z}_{\geq 0}$ 为非负整数集。

**定义 1.1（配方 Pattern）**。配方 $P \in \mathcal{P}$ 是一个五元组
$$P = (I_P, O_P, \sigma_P, \rho_P, \delta_P)$$
其中
- $I_P = \{(i_1, c_1), \ldots, (i_m, c_m)\}$，$i_j \in \mathcal{I}$，$c_j \in \mathbb{Z}_{>0}$，为有限多重输入集；
- $O_P = \{(o_1, d_1), \ldots, (o_n, d_n)\}$，$o_k \in \mathcal{I}$，$d_k \in \mathbb{Z}_{>0}$，为有限多重输出集；
- $\sigma_P : I_P \to 2^{\mathcal{I}}$，替换映射（空函数表示无替换槽）；
- $\rho_P : I_P \to \{\mathrm{exact}, \mathrm{sub}\}$，槽位类型；
- $\delta_P \in \mathbb{Z}_{\geq 0} \cup \{\infty\}$，有限次使用参数（耐久工具）。

**定义 1.2（合成请求 Crafting Request）**。合成请求是三元组
$$R = (I^*, N, S)$$
其中 $I^* \in \mathcal{I}$ 是目标物品，$N \in \mathbb{Z}_{>0}$ 是期望数量，$S : \mathcal{I} \to \mathbb{Z}_{\geq 0}$ 是网络库存函数。

**定义 1.3（合成树 Crafting Tree）**。给定请求 $R$，合成树是有根带标号 DAG
$$T = (V, E, \lambda)$$
满足
- $V = V_{\mathrm{int}} \cup V_{\mathrm{leaf}}$；
- 内部节点 $v \in V_{\mathrm{int}}$ 标记 $\lambda(v) = (P_v, m_v)$，$P_v \in \mathcal{P}$，$m_v \in \mathbb{Z}_{>0}$ 为执行次数；
- 叶节点 $v \in V_{\mathrm{leaf}}$ 标记 $\lambda(v) = (i_v, c_v)$，$i_v \in \mathcal{I}$，$c_v \in \mathbb{Z}_{>0}$；
- 边 $(v, w)$ 表示 $w$ 的产出被 $v$ 的某输入消耗。

**定义 1.4（递归算法 $\mathcal{A}_{\mathrm{rec}}$）**。给定请求 $R = (I^*, N, S)$：
1. 若 $S(I^*) \geq N$，返回 $(\mathrm{use\text{-}stock}, I^*, N)$；
2. 否则取 $P$ 使 $I^* \in O_P$ 且 $I^*$ 为 $P$ 的主输出，记 $d$ 为 $I^*$ 在 $O_P$ 中的重数；
3. 令 $k = \lceil N / d \rceil$；
4. 对每个 $(i, c) \in I_P$，递归调用 $\mathcal{A}_{\mathrm{rec}}(i, c \cdot k, S')$，其中 $S' = S - \mathrm{used}$；
5. 返回 $(\mathrm{craft}, P, k)$ 与子调用结果的并。

**定义 1.5（字节码 Bytecode）**。字节码程序是有限序列
$$\pi = [o_0, o_1, \ldots, o_{|\pi|-1}]$$
其中每个 $o_i$ 来自指令集
$$\Sigma = \{\mathrm{PUSH\_ITEM}, \mathrm{PUSH\_LONG}, \mathrm{ADD}, \mathrm{SUB}, \mathrm{MUL}, \mathrm{DIV\_ROUNDUP}, \mathrm{EXTRACT\_INGREDIENT}, \mathrm{RECORD\_OUTPUT}, \mathrm{RECORD\_MISSING}, \mathrm{DUP}, \mathrm{POP}, \mathrm{SWAP}, \mathrm{RECORD\_PATTERN}, \mathrm{CALL}, \mathrm{RETURN}, \mathrm{CALL\_BY\_KEY}, \mathrm{INSERT\_OUTPUT}, \mathrm{CATALYST\_SEED}, \mathrm{DURABILITY\_TOOL}, \mathrm{FUZZY\_SLOT}, \mathrm{HALT}\}$$
每条指令带操作数。

**定义 1.6（VM 状态）**。VM 状态是四元组
$$\sigma = (\pi, pc, s, m)$$
其中 $\pi$ 是当前程序，$pc \in \mathbb{N}$ 是程序计数器，$s : \mathbb{N} \to \mathbb{Z}$ 是 BigInteger 栈（$s(0)$ 为栈顶），$m : \mathcal{I} \to \mathbb{Z}_{\geq 0}$ 是当前构造中的计划表。

**定义 1.7（VM 转移函数 $\delta$）**。对关键指令给出形式语义（其余类似）：

| 指令 | 操作 |
|------|------|
| $\mathrm{PUSH\_ITEM}(i, c)$ | $\delta(\pi, pc, s, m) = (\pi, pc+1, s \circ [c], m)$ |
| $\mathrm{ADD}$ | $\delta(\pi, pc, s, m) = (\pi, pc+1, (s \circ [s(0) + s(1)]) \setminus [s(0), s(1)], m)$ |
| $\mathrm{MUL}$ | $\delta(\pi, pc, s, m) = (\pi, pc+1, (s \circ [s(0) \cdot s(1)]) \setminus [s(0), s(1)], m)$ |
| $\mathrm{EXTRACT\_INGREDIENT}$ | $S(i) \leftarrow S(i) - s(0)$，记录 $m(i) \leftarrow m(i) + s(0)$ |
| $\mathrm{CALL}(P)$ | 保存当前帧，跳转到 $\mathcal{C}(P)$ 的入口 |
| $\mathrm{RETURN}$ | 恢复调用者帧 |
| $\mathrm{HALT}$ | 终止，输出 $m$ |

**定义 1.8（编译 $\mathcal{C}$）**。对配方 $P$ 的编译 $\mathcal{C}(P)$ 是结构归纳定义的字节码：对每个输入 $(i, c) \in I_P$ 生成「压入 $c$、压入 amount、调用子样板字节码」序列，最后追加 $\mathrm{RECORD\_OUTPUT}, \mathrm{RETURN}$。

## 2. 递归算法的复杂度

**定理 2.1（递归下界）**。令 $T(n, d)$ 表示 $\mathcal{A}_{\mathrm{rec}}$ 在 $n$ 节点、深度 $d$ 的合成树上的时间复杂度。则
$$T(n, d) = \Omega(2^d).$$

*证明*。构造自指配方族 $P_k$：
$$P_k : A + B \to 2A$$
其中 $A$ 自产出、$B$ 外部输入。令 $R_k = (A, 2^k, S)$，其中 $S(B)$ 充分大。$\mathcal{A}_{\mathrm{rec}}$ 在第 0 层调用 $P_k$ 一次（用 amount $= 2^k$），第 1 层需调用 $P_k$ 两次以满足 $A$ 的 $2^{k+1}$ 需求（每执行 $P_k$ 一次消耗 1 个 $A$、产出 2 个 $A$，净增 1），依此类推。形式化：设 $T(d)$ 为深度 $d$ 时的调用次数，递推式为
$$T(d) = 2 \cdot T(d-1), \quad T(0) = 1$$
解为 $T(d) = 2^d$。每调用做 $O(1)$ 工作，故总时间为 $\Omega(2^d)$。$\square$

**推论 2.1**。当 $d = 24$（AE2 扩展包典型深度）时，$\mathcal{A}_{\mathrm{rec}}$ 最坏情形下需执行 $\sim 1.6 \times 10^7$ 次基本操作，已超出人感知阈值；$d = 30$ 时达 $\sim 10^9$，无法在线完成。

## 3. 栈式虚拟机

**定义 3.1（VM 执行 $\mathrm{Exec}$）**。$\mathrm{Exec}(\pi, N, S) = m^*$ 是从初始栈 $s = [N]$、初始计划表 $m = \emptyset$ 出发，反复应用 $\delta$ 至遇到 $\mathrm{HALT}$ 所得到的最终计划表。

**定理 3.1（VM 复杂度）**。设 $B = \sum_{P \in \Pi} |\mathcal{C}(P)|$ 为请求触及的所有配方的字节码总长，$k_P$ 为配方 $P$ 的调用次数。则
$$T_{\mathrm{VM}} = O\!\left(\sum_{P \in \Pi} k_P \cdot |\mathcal{C}(P)|\right).$$

*证明*。每条指令执行 $O(1)$ 时间；每条指令在栈帧内被读取恰好一次（$pc$ 单调递增，指令体内无向后跳转）；每次 $\mathrm{CALL}$ 引入新栈帧，其内指令独立计数。配方 $P$ 每次调用执行 $|\mathcal{C}(P)|$ 条指令，调用 $k_P$ 次共 $k_P \cdot |\mathcal{C}(P)|$ 条。按 $\Pi$ 求和即得。$\square$

**推论 3.1**。若 $k_P = 1$（首次编译后被缓存命中），则 $T_{\mathrm{VM}} = O(B)$，即与树大小 $n$ 线性相关（因 $B = \Theta(n)$）。

**定理 3.2（递归与 VM 的语义等价）**。对任意无自引用合成请求 $R$，设 $\Pi_{\mathrm{rec}}(R)$ 为 $\mathcal{A}_{\mathrm{rec}}(R)$ 的输出计划，$\Pi_{\mathrm{VM}}(R) = \mathrm{Exec}(\mathcal{C}(P_{\mathrm{root}}), N, S)$。则
$$\Pi_{\mathrm{rec}}(R) = \Pi_{\mathrm{VM}}(R)$$
作为多重集相等。

*证明*。对合成树 $T$ 的结构归纳。

*基础情形*：$T$ 仅含叶节点 $v$，$\lambda(v) = (I^*, N)$。$\mathcal{A}_{\mathrm{rec}}$ 直接返回 $(\mathrm{use\text{-}stock}, I^*, N)$。$\mathcal{C}(P)$ 的字节码为
$$[\mathrm{PUSH\_ITEM}(I^*, N), \mathrm{EXTRACT\_INGREDIENT}, \mathrm{RECORD\_OUTPUT}, \mathrm{HALT}]$$
$\mathrm{Exec}$ 在初始栈 $[N]$ 上执行后，$S(I^*)$ 减 $N$，$m(I^*) = N$。两者结果一致。

*归纳步骤*：$T$ 根为 $P$，$m$ 个子节点 $w_1, \ldots, w_m$，对应输入 $(i_1, c_1), \ldots, (i_m, c_m)$。$\mathcal{A}_{\mathrm{rec}}$ 递归调用 $\mathcal{A}_{\mathrm{rec}}(i_j, c_j \cdot k, S')$（$k = \lceil N/d \rceil$）并合并。$\mathcal{C}(P)$ 的字节码结构为
$$\bigl[\mathrm{PUSH\_LONG}(c_1), \mathrm{MUL}, \mathrm{CALL}(\mathcal{C}(P_{w_1})), \ldots, \mathrm{PUSH\_LONG}(c_m), \mathrm{MUL}, \mathrm{CALL}(\mathcal{C}(P_{w_m})), \mathrm{RECORD\_OUTPUT}, \mathrm{RETURN}\bigr]$$
栈初值 $[N]$ 经 $\mathrm{PUSH\_LONG}(c_j), \mathrm{MUL}$ 变换为栈顶 $c_j \cdot N$，随后 $\mathrm{CALL}$ 启动子样板的 VM。子 VM 由归纳假设产出 $\Pi_{\mathrm{rec}}(R_j)$，与 $\mathcal{A}_{\mathrm{rec}}$ 子调用结果一致。$\mathrm{RECORD\_OUTPUT}$ 添加 $P$ 的 craft 条目，与 $\mathcal{A}_{\mathrm{rec}}$ 的合并步骤对应。$\square$

## 4. 递归与虚拟机的本质区别

**定义 4.1（递归算法的执行模型）**。$\mathcal{A}_{\mathrm{rec}}$ 在调用栈上为每个活动子问题分配一帧；每帧含局部变量（输入集、当前 amount、库存视图）；控制流由调用栈管理，返回时弹栈。

**定义 4.2（VM 的执行模型）**。VM 在单一栈上推进 $pc$；不存在调用栈帧的隐式管理；控制流由 $\mathrm{CALL} / \mathrm{RETURN}$ 显式编码为指令；amount 是栈上普通值，可被任意指令操作。

**核心区别**：

**(1) 计算对象的差异**。递归算法操作的对象是**子问题**（请求元组 $(I, N, S')$），调度单位是函数调用；VM 操作的对象是**数值**（栈上 BigInteger），调度单位是指令。递归 → VM 的转换本质上是将「调度结构」从语言运行时转移到字节码。

**(2) 时间复杂度阶的差异**。由定理 2.1 与定理 3.1：
$$T_{\mathrm{rec}} = \Theta(2^d), \quad T_{\mathrm{VM}} = \Theta(B) = \Theta(n).$$
当 $d = \omega(\log n)$ 时递归阶高于 VM 阶。

**(3) 副作用可见性**。递归算法的副作用（库存扣减、计划记录）发生在**调用边界**（进入子调用前扣减、返回时合并）；VM 的副作用（$\mathrm{EXTRACT\_INGREDIENT}$、$\mathrm{RECORD\_OUTPUT}$）是**指令级**的，与控制流解耦。这允许 VM 在不增加复杂度的前提下插入优化（如 $\mathrm{scale(cts)}$，将「重复执行 $k$ 次」压成「执行 1 次但 amount 放大 $k$ 倍」），而递归算法难以做等价变换。

**(4) 状态封装的差异**。递归调用栈是隐式数据结构，外部无法观测中间状态；VM 栈是显式的，可被检查、修改、缓存。这使得「编译产物」成为可复用的对象——一旦 $P$ 被编译为 $\mathcal{C}(P)$，所有 $P$ 的实例（包括不同 amount、不同网络）共享同一份字节码。

## 5. JIT 优化

**定理 5.1（线性合成函数）**。对任意无自引用配方 $P$，合成函数
$$f_P : \mathbb{Z}_{>0} \to \mathbb{Z}_{\geq 0}^{|\mathcal{I}|}$$
满足
$$f_P(a N) = a \cdot f_P(N), \quad \forall a \in \mathbb{Z}_{>0}.$$

*证明*。对 $P$ 的结构归纳。基础情形 $P$ 为单输入，$f_P(N) = c \cdot N \cdot \mathbf{e}_i$，线性显然。归纳步骤：$P$ 的子问题为 $P_1, \ldots, P_m$，$f_P(N) = \sum_j c_j f_{P_j}(N)$。由归纳假设 $f_{P_j}(aN) = a f_{P_j}(N)$，故
$$f_P(aN) = \sum_j c_j a f_{P_j}(N) = a \sum_j c_j f_{P_j}(N) = a f_P(N). \quad \square$$

**定理 5.2（cts=1 内联）**。设 $P$ 为父配方，$Q$ 为子配方，$\mathrm{cts}(Q, P) = 1$。令 $\mathcal{C}_{\mathrm{inl}}(P)$ 为将 $\mathrm{CALL}(Q)$ 替换为 $Q$ 字节码体的内联结果。则
$$|\mathcal{C}_{\mathrm{inl}}(P)| = |\mathcal{C}(P)| + |\mathcal{C}(Q)| - 1$$
且
$$\mathrm{Exec}(\mathcal{C}_{\mathrm{inl}}(P), N, S) = \mathrm{Exec}(\mathcal{C}(P), N, S) \quad \forall N, S.$$

*证明*。$\mathrm{CALL}$ 指令占 1 字（操作数 $Q$ 的引用），替换为 $\mathcal{C}(Q)$ 整体后字数为 $|\mathcal{C}(P)| - 1 + |\mathcal{C}(Q)|$。正确性：原 $\mathcal{C}(P)$ 在 $\mathrm{CALL}(Q)$ 处保存帧、跳转 $\mathcal{C}(Q)$、执行、返回；内联后字节码线性执行相同操作序列，amount 与栈状态逐步一致。$\square$

**注**。单次内联节省 1 字，但更重要的是消除栈帧管理的常数开销。对 $n$ 节点全 cts=1 树，节省 $O(n)$ 帧管理 + $O(n)$ 次函数调用，叠加效应使常数因子降为原来的 $\sim 1/k$（$k$ 为平均 cts）。

**定理 5.3（cts=$k$ 缩放）**。设 $P$ 调用 $Q$ 满足 $\mathrm{cts}(Q, P) = k$。定义 $\mathcal{C}_{\mathrm{scale}}(P)$ 为在 $\mathrm{CALL}(Q)$ 前插入 $\mathrm{PUSH\_LONG}(k), \mathrm{MUL}$ 的变体。则
$$\mathrm{Exec}(\mathcal{C}_{\mathrm{scale}}(P), N, S) = \mathrm{Exec}(\mathcal{C}(P), N, S)$$
且
$$\frac{T_{\mathrm{unscaled}}}{T_{\mathrm{scaled}}} = \frac{k \cdot |\mathcal{C}(Q)|}{|\mathcal{C}(Q)| + O(1)} \to k \quad (|\mathcal{C}(Q)| \to \infty).$$

*证明*。正确性：未缩放时 $Q$ 被调用 $k$ 次，每次 amount 为 $N$，计划表更新 $k \cdot f_Q(N)$；缩放后 $Q$ 被调用 1 次，amount 为 $kN$，计划表更新 $f_Q(kN)$。由定理 5.1，$f_Q(kN) = k f_Q(N)$，故两者结果相等。

时间比：未缩放代价 $k \cdot |\mathcal{C}(Q)|$（$k$ 次执行，每次 $|\mathcal{C}(Q)|$ 条指令）；缩放代价 $|\mathcal{C}(Q)| + O(1)$（1 次执行 + 2 条缩放指令）。$\square$

**定理 5.4（跨请求缓存）**。设 $\mathcal{K}(S, \mathcal{P}) = (\mathrm{fingerprint}(S), \mathrm{hash}(\mathcal{P}))$ 为缓存键。两次请求 $R_1 = (I^*_1, N_1, S)$、$R_2 = (I^*_2, N_2, S)$ 满足 $\mathcal{P}_1 = \mathcal{P}_2$。则第二次请求的编译代价为
$$T_{\mathrm{compile}}(R_2 \mid R_1) = O(1)$$
对比首次 $T_{\mathrm{compile}}(R_1) = O\!\left(\sum_{P \in \mathcal{P}_1} |\mathcal{C}(P)|\right) = O(B).$$

*证明*。缓存键完全相同；哈希表查找期望 $O(1)$；命中后直接返回已编译的字节码数组，无需重新解析配方结构。$\square$

## 6. 加速比综合

对深度 $d$、节点数 $n$、每节点平均 cts 为 $\bar{k}$ 的合成树，三种优化的累积效果：

| 优化项 | 加速比 | 适用条件 |
|--------|--------|----------|
| 栈式 VM（替代递归） | $2^d / n$（最坏 $d=24$ 时 $\sim 2^{24}/n$） | 所有 DAG |
| cts=1 内联 | $O(1)$（消除每层栈帧开销） | 子节点不被复用 |
| cts=$k$ 缩放 | $k$ | 子节点 cts $> 1$ |
| 跨请求缓存 | $B / 1$ | 同一网络重复请求 |

实际测量（仓库 README 1.10.7）：$d = 14$、$n \sim 10^4$、$\bar{k} \sim 4$ 时，递归 90 s，VM 38 ms，加速比 $\sim 2400\times$。$d = 30$、$n \sim 10^9$ 时递归无法完成，VM + JIT 280 ms。

## 7. 结论

形式化分析给出三条结论：

1. **递归合成算法的最坏时间复杂度为 $\Theta(2^d)$**（定理 2.1），无法通过常数因子优化改善——其结构瓶颈在于「每层展开全部子问题」的控制流。

2. **栈式 VM 与递归算法在无自引用情形下语义等价**（定理 3.2），但时间复杂度降为 $\Theta(B) = \Theta(n)$（定理 3.1）。这一改进的代数来源是：将「调用栈上的递归结构」转化为「线性字节码上的顺序迭代」，使每一层子问题的处理从「重新调度」降为「顺序推进」。

3. **JIT 的三种优化均有可证明的正确性定理与可量化的加速比**：内联节省 $O(n)$ 帧管理（定理 5.2），缩放节省因子 $k$（定理 5.3），跨请求缓存节省 $B$（定理 5.4）。三者的共同前提是定理 5.1（合成函数的线性性），该性质是递归算法无法直接利用的——它要求将「amount」提升为可运算的栈值。

递归与 VM 的本质区别不在于「是否栈式执行」，而在于**调度结构的位置**：递归把调度交给语言运行时，VM 把调度编码为数据。一旦调度成为数据，编译、缓存、变换都成为可能。
