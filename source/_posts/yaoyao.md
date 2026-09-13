---
title: 夭夭：没有注意力的语言模型
date: 2026-09-13 17:45:00
tech: true
categories:
  - 编程
tags:
  - Transformer
  - LSTM
  - Mamba
  - CUDA
  - 三值
  - 形式化
description: 从 Attention、LSTM、线性注意力、FWP、xLSTM/TFLA、Mamba、GRPO 与 DeepSeek-V4.1 的 KV 压缩讲起，对照 Yaoyao 的 GRU 短状态与 H2R 增量规则：写出完整前向、七条定理与解析反向，并把 CPU 逐步核、CUDA 记忆核、三值投影与 R4 校验贴进文中。
---

本文对应 [Yaoyao](https://github.com/TaoLe-si/Yaoyao/tree/main) 0.1.1。正式算子名 `dual-state-4-noffn-delta-mem-input-sqrt-d`。它**不是 Transformer**：没有 $\operatorname{softmax}(QK^{\mathrm{T}}V)$，没有随上下文增长的 KV cache。每会话循环状态固定 257 KiB。

对照论文是 *Attention Is All You Need*、LSTM、xLSTM、TFLA、Mamba、DeepSeekMath（GRPO）和 *DeepSeek-V4.1-Flash*。下面先把这些工作的**机制**写到能推公式的程度——夭夭借了什么、明确不借什么——再给出本仓库的前向、定理、解析反向，以及对应源文件。公式按仓库写法排，代码从 `src/` 展开，不是伪代码提纲。

<!-- more -->

## 1. 问题：序列混合要付什么账

语言模型逐步预测 $p(z_{t+1}\mid z_{\le t})$。困难不在 softmax 头，而在**当前位置如何看到历史**。三条主流账本：

| 路线 | 每步看到历史的方式 | 状态随长度 | 训练并行 | 代表 |
|---|---|---|---|---|
| 内容检索 | 对全部（或稀疏选出的）位置做 $QK^{\mathrm{T}}V$ | KV cache $O(n)$ | 序列维可并行 | Transformer、CSA2 |
| 固定维循环 | 门控向量 $c_t,h_t$ | $O(1)$ | 时间串行（BPTT） | LSTM、GRU、sLSTM |
| 有限充分统计量 | 矩阵 / 对角 SSM 递推 | $O(d^2)$ 或 $O(dN)$ | 扫描 / 分块 | 线性注意力、FWP、mLSTM、Mamba |

夭夭走第三条里偏 **FWP / mLSTM** 的那一支：一张运行时矩阵 $M\in\mathbb{R}^{512\times 64}$，每步秩一修正；再加一个 GRU 式短向量 $s\in\mathbb{R}^{128}$。硬约束写在架构文档里（不变量 I1–I5）：

- **I1** 无 FFN（`TAO_NO_FFN`）。配置里的 $e=1024$ 只为序列化兼容。
- **I2** 三值权重 $\{-1,0,+1\}$ + 每行尺度 $\alpha$。
- **I3–I5 / R4** 训练与推理同一算子：同一前向、同一 Padé 激活、禁止把 KQV / KV cache 接到本算子上。

`mem.key` / `mem.query` / `mem.value` 是关联记忆的写方向、读方向、载荷，**不是注意力头**。

---

## 2. Transformer：二次方换任意对齐

Vaswani et al., 2017. *Attention Is All You Need.* [arXiv:1706.03762](https://arxiv.org/abs/1706.03762)

### 2.1 主张与整体

论文主张：丢掉循环和卷积，序列混合只靠注意力。原论文是编码器–解码器：各 $N=6$ 层，模型维 $d_{\mathrm{model}}=512$，注意力头 $h=8$，每头 $d_k=d_v=64$，FFN 内维 $d_{\mathrm{ff}}=2048$。当代自回归 LM 通常只留**因果解码器**，但注意力本身没变。

一层的残差骨架（Pre-LN 变体把 Norm 挪到子层前，原论文是 Post-LN）：

$$x \leftarrow x + \operatorname{MultiHead}(x),\qquad
x \leftarrow x + \operatorname{FFN}(x).$$

### 2.2 缩放点积

对一组 query / key / value：

$$\operatorname{Attention}(Q,K,V)=\operatorname{softmax}\!\left(\frac{QK^{\mathrm{T}}}{\sqrt{d_k}}\right)V.$$

令 $q,k$ 各维独立、均值为 0、方差 1，则 $\langle q,k\rangle$ 的方差是 $d_k$。不除 $\sqrt{d_k}$ 时点积幅度随维数涨，softmax 进饱和区，梯度 $\operatorname{softmax}(z)_i(1_i-\operatorname{softmax}(z))$ 接近 0。这是**数值稳定性**，不是新的归纳偏置。归纳偏置在 softmax 本身：它把分数变成单纯形上的权重，于是每个 query 可以**把质量集中到任意一个 key**——这就是内容寻址。

因果 LM 再乘下三角掩码：位置 $i$ 只能看见 $j\le i$。训练时整段 $Q,K,V$ 一次算出，$n\times n$ 分数矩阵仍在。

### 2.3 多头

$$
\begin{aligned}
\operatorname{head}_i &= \operatorname{Attention}(QW_i^Q, KW_i^K, VW_i^V),\\
\operatorname{MultiHead}(Q,K,V) &= \operatorname{Concat}(\operatorname{head}_1,\dots,\operatorname{head}_h)W^O.
\end{aligned}
$$

原论文取 $h=8$，$W_i^Q\in\mathbb{R}^{d_{\mathrm{model}}\times d_k}$。多头的经验解释是：不同头可以学不同对齐（句法、指代、位置邻域）。总计算量和单头 $d_{\mathrm{model}}$ 相当，因为 $hd_k=d_{\mathrm{model}}$。

### 2.4 位置编码

注意力对置换等变，必须把位置注入。原论文用固定正弦：

$$\operatorname{PE}(p,2i)=\sin\bigl(p/10000^{2i/d}\bigr),\qquad
\operatorname{PE}(p,2i+1)=\cos\bigl(p/10000^{2i/d}\bigr).$$

任意固定偏移 $k$ 下，$\operatorname{PE}(p+k)$ 是 $\operatorname{PE}(p)$ 的线性函数，于是模型可以学相对位置。后来 RoPE 把旋转直接乘进 $q,k$，相对位置进点积；夭夭**没有位置编码**——循环状态的下标就是时间。

### 2.5 FFN

$$\operatorname{FFN}(x)=\max(0,xW_1+b_1)W_2+b_2.$$

原论文里 FFN 占参数的大头（$2d_{\mathrm{model}}d_{\mathrm{ff}}$ 对 $4d_{\mathrm{model}}^2$ 量级的注意力投影）。Geva 等人后来把 FFN 解成 key–value 记忆。夭夭的 I1 把整块删掉：9.5M 里没有 $W_1,W_2$，表达宽度几乎全在嵌入和几张小投影上。

### 2.6 复杂度与 KV cache

令序列长 $n$、模型维 $d$。自注意力：$QK^{\mathrm{T}}$ 是 $n\times n$，乘加 $O(n^2 d)$；对 $V$ 再 $O(n^2 d)$。FFN 是 $O(n d\,d_{\mathrm{ff}})$。$n$ 大时平方项主导。

解码第 $t$ 步若重算全部历史，每步仍 $O(t d)$，总生成 $O(n^2 d)$。工程上缓存已出现过的 $K,V$：

$$\operatorname{cache}_t=\bigl[(K_{1:t-1},V_{1:t-1})\bigr]
\;\xrightarrow{\;t\;}\;
\bigl[(K_{1:t},V_{1:t})\bigr].$$

每步只算当前行的 $q_t,k_t,v_t$，再与 cache 做 $O(t d)$。于是**逐步算力从 $O(t^2)$ 降到 $O(t)$，账单转到 cache 字节**。GQA / MLA / FP8 KV 都是在压这一项。DeepSeek-V4.1 把 agent 负载写成 input-heavy：工具调用让 prefill 与前缀复用变主路径，瓶颈从 FLOPs 转到 HBM / SSD 上的 KV。

### 2.7 夭夭借什么

保留与注意力**正交**的部分：自回归 LM、teacher forcing、逐步交叉熵、残差流、RMSNorm（不是原论文的 LayerNorm）、绑定嵌入当分类头。**不采用** $QK^{\mathrm{T}}V$、位置编码、FFN、KV cache。序列混合改成第 12 节的递归。

---

## 3. LSTM：恒定误差传送带

Hochreiter & Schmidhuber, 1997. *Long Short-Term Memory.* Neural Computation.

### 3.1 朴素 RNN 的梯度乘积

隐状态 $h_t=\tanh(Wh_{t-1}+Ux_t)$。损失对 $h_{t-k}$ 的反传要乘

$$\frac{\partial h_t}{\partial h_{t-k}}
=\prod_{i=1}^{k}\operatorname{diag}(\tanh'(z_{t-i+1}))\,W.$$

$\rho(W)>1$ 则沿时间爆炸，$\rho(W)<1$ 则指数衰减。长程学分不到，不是优化器没调好，是雅可比的谱。

### 3.2 CEC

LSTM 的对策是**恒定误差传送带**：细胞 $c_t$ 以近乎恒等映射跨步，门只决定写、读、忘。当代常用（含 Gers 的忘门）写作

$$
\begin{aligned}
i_t&=\sigma(W_i x_t+U_i h_{t-1}+b_i),\\
f_t&=\sigma(W_f x_t+U_f h_{t-1}+b_f),\\
o_t&=\sigma(W_o x_t+U_o h_{t-1}+b_o),\\
\tilde c_t&=\tanh(W_c x_t+U_c h_{t-1}+b_c),\\
c_t&=f_t\odot c_{t-1}+i_t\odot\tilde c_t,\\
h_t&=o_t\odot\tanh(c_t).
\end{aligned}
$$

若 $f_t\approx 1$，则 $\partial c_t/\partial c_{t-1}\approx 1$，误差沿 $c$ 几乎不衰减。1997 原文还没有忘门，CEC 靠输入/输出门保护；忘门让网络学会**主动清空**。计算逐步 $O(1)$，训练必须沿时间展开（BPTT），不能像注意力那样把整段一次矩阵乘完。隐–隐连接（memory mixing）让 sLSTM 一类模型能做状态跟踪，也正是它不能完全并行的原因。

### 3.3 GRU

Cho et al., 2014. *Learning Phrase Representations using RNN Encoder–Decoder.* [arXiv:1406.1078](https://arxiv.org/abs/1406.1078)

$$
\begin{aligned}
z_t&=\sigma(W_z x_t+U_z h_{t-1}),\\
r_t&=\sigma(W_r x_t+U_r h_{t-1}),\\
\tilde h_t&=\tanh\bigl(W x_t+U(r_t\odot h_{t-1})\bigr),\\
h_t&=(1-z_t)\odot h_{t-1}+z_t\odot\tilde h_t.
\end{aligned}
$$

更新门 $z_t$ 把忘与写收成一次凸组合。夭夭的短状态**再简化一档**：没有复位门 $r_t$，候选 $u_t$ 直接看完整的 $s_{t-1}$：

$$s_t=(1-\sigma(a_t))\odot s_{t-1}+\sigma(a_t)\odot\tanh(u_t).$$

定理 1 证明 $|s_t[j]|\le 1$。容量在方向和门控时间尺度上，不在细胞范数上。

---

## 4. 线性注意力是 RNN

Katharopoulos et al., 2020. *Transformers are RNNs.* [arXiv:2006.16236](https://arxiv.org/abs/2006.16236)

softmax 注意力可以看成核 $\kappa(q,k)=\exp(q^{\mathrm{T}}k/\sqrt{d})$ 的归一化。若换成特征映射 $\phi$，使 $\kappa(q,k)=\phi(q)^{\mathrm{T}}\phi(k)$，则

$$o_t=\frac{\sum_{i=1}^{t}\phi(q_t)^{\mathrm{T}}\phi(k_i)\,v_i}{\sum_{i=1}^{t}\phi(q_t)^{\mathrm{T}}\phi(k_i)}.$$

定义矩阵状态与归一化向量

$$S_t=S_{t-1}+\phi(k_t)v_t^{\mathrm{T}},\qquad
z_t=z_{t-1}+\phi(k_t),$$

就有

$$o_t=\frac{\phi(q_t)^{\mathrm{T}} S_t}{\phi(q_t)^{\mathrm{T}} z_t}.$$

$S_t$ 大小与 $t$ 无关。这证明「有限状态 RNN」与「线性注意力」是同一对象的两种写法。因果掩码变成递推；训练可改成并行前缀扫描。

夭夭**不走核特征累加**。显式维护 $M$，读写地址分开：$k$ 写、$q$ 读。没有 $\phi$，也没有 $z_t$ 那种归一化向量（xLSTM 的 $n_t$ 才有）。

---

## 5. Fast Weight Programmer 与 delta 规则

Schlag, Irie, Schmidhuber, 2021. *Linear Transformers Are Secretly Fast Weight Programmers.* [arXiv:2102.11174](https://arxiv.org/abs/2102.11174)

Schmidhuber 1992 的快权重把「慢网络」的输出当成「快网络」的权。线性注意力的 $S_t$ 就是一张快权重表。纯外积写入 $W\leftarrow W+v\phi(k)^{\mathrm{T}}$ 会在同一地址上叠加上去，旧值擦不干净。delta 规则（Widrow–Hoff）改成**误差驱动**：

$$W_t=W_{t-1}+\beta_t\bigl(v_t-W_{t-1}\phi(k_t)\bigr)\phi(k_t)^{\mathrm{T}}.$$

几何上：沿 $\phi(k_t)$ 方向，把当前读出拉向目标 $v_t$；正交方向不动。这正是夭夭 $M$ 的更新（定理 2–3）。仓库里 `mem.key/query/value` 沿用 FWP 术语。$\beta_t$ 不是超参表上的常数，而是 $h_t$ 的 sigmoid 函数，所以写入强度随内容变——这一点和 Mamba 的选择性同族，对象却是关联矩阵而不是对角 SSM。

---

## 6. xLSTM 与 TFLA

Beck et al., 2024. *xLSTM: Extended Long Short-Term Memory.* [arXiv:2405.04517](https://arxiv.org/abs/2405.04517)

xLSTM 给 LSTM 加指数门，并分成两个细胞。

### 6.1 sLSTM

标量细胞 + 归一化状态，门可以走 $\exp$：

$$
\begin{aligned}
c_t&=f_t c_{t-1}+i_t z_t,\\
n_t&=f_t n_{t-1}+i_t,\\
h_t&=o_t\,\frac{c_t}{n_t},\\
i_t&=\exp(\tilde i_t),\qquad
f_t=\sigma(\tilde f_t)\ \text{或}\ \exp(\tilde f_t).
\end{aligned}
$$

关键是 **memory mixing**：门和细胞输入仍依赖 $h_{t-1}$（隐–隐连接）。这让它能做状态跟踪，也让它**不能**完全并行。指数门用稳定器 $m_t$ 防溢出（与 log-sum-exp 同一技巧）。

### 6.2 mLSTM

细胞从标量变成矩阵，协方差写入：

$$
\begin{aligned}
C_t&=f_t C_{t-1}+i_t v_t k_t^{\mathrm{T}},\\
n_t&=f_t n_{t-1}+i_t k_t,\\
\tilde h_t&=\frac{C_t q_t}{\max\bigl(|n_t^{\mathrm{T}} q_t|,1\bigr)},\qquad
h_t=o_t\odot\tilde h_t,\\
i_t&=\exp(\tilde i_t).
\end{aligned}
$$

没有 memory mixing，递推可改写成并行。$C_t$ 与夭夭的 $M$ **同型**：矩阵状态、外积写入。差别有三条：

1. mLSTM 是**衰减 + 叠加**（$f_t C+i_t vk^{\mathrm{T}}$）；夭夭是 **delta 覆写**（$M+\beta(v-M\hat k)\hat k^{\mathrm{T}}$）。同一地址上，前者掺新值，后者按 $\beta$ 把该方向拉向 $v$。
2. mLSTM 有归一化 $n_t$ 和输出门；夭夭读出就是 $M_t q_t$，再加 $W_{rs}s_t$。
3. xLSTM 块仍带 FFN，并混叠 sLSTM；夭夭 $L=2$、无 FFN、没有 sLSTM。

### 6.3 TFLA

TFLA（*Tiled Flash Linear Attention*）不是新序列模型，是 **线性 RNN / mLSTM 的 GPU 核**：在 FLA 的分块之上再做块内 tiling，让 chunk 可以任意大，算术强度上去、中间状态不用全部物化。思路与 FlashAttention 相同——SRAM 里的 tile 对 HBM 里的矩阵做累加——对象换成 $C$ 而不是 $QK^{\mathrm{T}}$。

README 写死：若要把 TFLA 迁到夭夭，对准对象是 **$C\equiv M$ 的分块**，不能对准 Transformer 的 KV。当前 CPU 热路径 86% 的 MAC 在词表头，不在 $M$；TFLA 式分块是后手。

---

## 7. Mamba：选择性对角 SSM

Gu & Dao, 2023. *Mamba: Linear-Time Sequence Modeling with Selective State Spaces.* [arXiv:2312.00752](https://arxiv.org/abs/2312.00752)

连续时间状态空间

$$h'(t)=A h(t)+B x(t),\qquad y(t)=C h(t).$$

零阶保持离散化（步长 $\Delta$）：

$$\overline A=\exp(\Delta A),\qquad
\overline B=(\Delta A)^{-1}\bigl(\exp(\Delta A)-I\bigr)\Delta B,$$

$$h_t=\overline A\, h_{t-1}+\overline B\, x_t,\qquad y_t=C h_t.$$

S4 一类把 $A$ 结构化（对角加低秩），$\overline A,\overline B$ **与输入无关**，整段可用卷积核高效算。不能按内容决定留或忘——这是它打不过注意力的原因。

Mamba 让 $\Delta_t,B_t,C_t$ 成为 $x_t$ 的函数（selective）。选择性和卷积形式互斥，于是改用硬件感知的并行扫描：不把形状 $(B,L,D,N)$ 的状态物化到 HBM，只在 SRAM 里做分块扫描。推断逐步 $O(1)$，吞吐高于同尺寸 Transformer。

夭夭落地处只借「输入依赖的门」：$\sigma(a_t)$ 与 $\beta_t(h)$。Mamba 是对角 SSM，每步 $O(DN)$；我们的 $M$ 是 $m\times d_k$ 稠密关联表，一条地址可覆写而不涂掉正交地址（定理 3）。对角 SSM 更轻，$M$ 更凶。

---

## 8. GRPO：没有 critic 的相对策略梯度

Shao et al., 2024. *DeepSeekMath.* [arXiv:2402.03300](https://arxiv.org/abs/2402.03300)（桌面上的 `GRPO.pdf`）

PPO 最大化 clipped 重要性比值，优势 $\hat A_t$ 来自 GAE，需要一份与策略同量级的价值网络。LLM 里奖励常常只打在最后一个 token 上，价值网络既贵又难训。

GRPO 对同一提示 $q$ 从 $\pi_{\theta_{\mathrm{old}}}$ 采一组输出 $\{o_i\}_{i=1}^{G}$，用组内相对优势代替 critic：

$$\hat A_{i,t}=\frac{r_i-\operatorname{mean}(\{r_j\})}{\operatorname{std}(\{r_j\})}$$

（同一条输出的每个 token 共用这个 $\hat A_i$）。目标（论文式 (3)）是

$$
\begin{aligned}
\mathcal{J}_{\mathrm{GRPO}}(\theta)
&=\mathbb{E}_{q,\{o_i\}}\frac1G\sum_{i=1}^{G}\frac1{|o_i|}\sum_{t=1}^{|o_i|}\\
&\quad\Bigl\{\min\bigl(\rho_{i,t}\hat A_{i,t},\;
\operatorname{clip}(\rho_{i,t},1-\varepsilon,1+\varepsilon)\hat A_{i,t}\bigr)
-\beta\,\mathbb{D}_{\mathrm{KL}}[\pi_\theta\parallel\pi_{\mathrm{ref}}]\Bigr\},
\end{aligned}
$$

其中 $\rho_{i,t}=\pi_\theta(o_{i,t}\mid q,o_{i,<t})/\pi_{\theta_{\mathrm{old}}}(\cdots)$。KL 直接加在损失里，不掺进奖励，避免搅乱 $\hat A$。无偏 KL 估计用 Schulman 的

$$\mathbb{D}_{\mathrm{KL}}\approx
\frac{\pi_{\mathrm{ref}}}{\pi_\theta}-\log\frac{\pi_{\mathrm{ref}}}{\pi_\theta}-1.$$

这是**后训练**（数学推理 RL），不是序列混合算子。夭夭 0.1.1 的学习目标仍是助手位交叉熵。9.5M 也撑不起一组 rollout。写在这里是为了分清：DeepSeek 系论文里「能力」和「KV 字节」不是同一章。V4.1 的后训练仍走 GRPO 组，但报告自己说本版本几乎不引入新 RL 算法。

---

## 9. DeepSeek-V4.1-Flash：压缩 KV，而不是取消注意力

DeepSeek-AI, 2026. *DeepSeek-V4.1-Flash: Pushing the Limits of KV Cache Compression.*

仓库精读在 `docs/architecture-proposals/01-paper-reading.md`。主旨不是更快注意力：稀疏注意力（CSA/HCA）把算力降下来之后，瓶颈转到 KV 的持久化、复用与搬运。三个可乘维度：

| 维度 | 论文手段 | 夭夭 |
|---|---|---|
| 条目大小 | GQA / MLA / **FP4 main KV** | 三值权重 + 每行 $\alpha$；没有 KV |
| 序列维 | 每 $m$ 个 token 压成 1 条 | 状态与长度无关，序列维不存在 |
| 层维 | CSA2 的 Full / Reindex / Reuse | 两层独立，未做跨层复用 |

骨干：40 层 $=20$ causal encoder $+20$ decoder，$d=5120$，MoE，552B backbone + 196B Engram。同序列长度下 runtime KV 约 V4-Flash 的 $1/4$（约 890 B/token），持久 KV 约 $1/8$；decode FLOPs 从 4K 到 1M 只 $+25\%$。

**CED.** 对 decoder 层 $\ell>L/2$，KV 从 $H_{L/2}$ 用层专属投影生成，而不是复用下半层逐层缓存。本地 SWA 仍逐层算。复杂度从 $O(NL)$ 降到约 $O(NL/2)$。

**CSA2 三模式.** Full：本层生成 main KV，indexer K 由 main KV 投影，本层打分选 Top-K。Reindex：复用最近 Full 的 KV，**重新打分**。Reuse：KV 与索引都复用，本层只算 main Q + SWA。静态指派，训练/推理路径一致。

**FP4 范围论证（写法值得照抄，格式不必照搬）.** MXFP4 E2M1 + 每 16 通道 E4M3 scale，上限 $448\times 6=2688$。RMSNorm 后 512 维 latent 的 $\ell_2\le\sqrt{512}\approx 22.6$，RoPE 保范数，实测最大约 10，余量充足。SWA KV 对量化敏感，保持 FP8。纪律：RoPE **之后**再量化；QAT 在后训练引入。

**SWA Bounded Replay.** SWA KV 不再进持久缓存。miss 时只重放最近 $n_{\mathrm{win}}$ 个 token。近似的数学含义：精确重建需 $L\times n_{\mathrm{win}}$；有界重放把感受野截到重放段。**推理期近似必须在训练期原样模拟。**

对夭夭：

- **借**：R4（训练/推理同算子）；量化要有范围论证（定理 5 是三值版）；候选池若做近似必须训练期同域。
- **不借**：CSA2、层次稀疏 indexer、跨层 KV 复用、Engram 作为「当前速度」杠杆、MoE。那些是注意力家族的压缩术。夭夭把序列维**直接消掉**（每 token 0 字节 KV），代价是失去「按需检索任意历史位置」。

不要把 890 B/token 拿来和 257 KiB 循环状态做假对比——对象不同。论文路线是「保留全局注意力再压缩它」。夭夭路线是「没有注意力就没有 KV」。

---

## 10. 夭夭的对象

| 项目 | 值 |
|---|---:|
| 层数 $L$ | 2 |
| 残差通道 $d$ | 512 |
| 短状态 $s$ | 128 |
| 记忆 $M\in\mathbb{R}^{m\times d_k}$ | $512\times 64$ |
| BPE 词表 $V$ | 16384（256 字节 + 5 个特殊号 + 16123 次合并） |
| 三值矩阵元素 | 9,502,720 |
| 浮点偏置 / 归一化 | 20,482 |
| 合计参数 | 9,523,202 |
| 每层循环状态 | 32,896 个 float32（128.5 KiB） |
| 每会话（2 层） | **257 KiB，与上下文长度无关** |

0.1.0 是向量记忆（`m.candidate/m.gate`），与 0.1.1 的矩阵 schema **不兼容**。权重身份禁止混用。

---

## 11. 配置与 schema

`src/dual_state_config.hpp`。矩阵一律「输出维 $\times$ 输入维」。`TAO_DELTA_MEM` 打开时 `memory_size()` 是 $m\cdot d_k$，否则退回向量长度 $m$。

```cpp
namespace tao::dual {
struct Config {
  uint32_t layers = 2, d = 512, s = 128, m = 512, e = 1024, vocab = 16384;
  uint32_t dk = 64;
  void validate() const {
    if (!layers || !d || !s || !m || !e || vocab < 261)
      throw std::invalid_argument("model dimensions");
#ifdef TAO_DELTA_MEM
    if (!dk || dk > d) throw std::invalid_argument("key dimension");
#endif
  }
  uint64_t memory_size() const {
#ifdef TAO_DELTA_MEM
    return uint64_t(m) * dk;
#else
    return m;
#endif
  }
};

inline std::vector<TensorSpec> schema(const Config& c) {
  c.validate();
  std::vector<TensorSpec> t;
  auto add = [&](std::string name, uint32_t r, uint32_t k, bool q = true) {
    t.push_back({name, r, k, q});
  };
  add("embedding", c.vocab, c.d);
  add("vocab.bias", c.vocab, 1, false);
  add("final.norm", c.d, 1, false);
  for (uint32_t l = 0; l < c.layers; ++l) {
    auto p = "layer." + std::to_string(l) + ".";
    for (auto branch : {"s.candidate", "s.gate"}) {
      add(p + branch + ".x", c.s, c.d);
      add(p + branch + ".s", c.s, c.s);
      add(p + branch + ".bias", c.s, 1, false);
    }
#ifdef TAO_DELTA_MEM
    add(p + "mem.key", c.dk, c.d);
    add(p + "mem.query", c.dk, c.d);
    add(p + "mem.value", c.m, c.d);
    add(p + "mem.beta", 1, c.d, false);
    add(p + "mem.beta.bias", 1, 1, false);
#else
    // 0.1.0 向量记忆：m.candidate / m.gate，带 m→m 混合
#endif
    add(p + "read.s", c.d, c.s);
#ifdef TAO_NO_FFN
    for (auto norm : {"input.norm", "read.norm"})
      add(p + norm, c.d, 1, false);
#endif
  }
  return t;
}
}
```

没有 `ff.up/ff.down`。`mem.beta` 是浮点行向量：写入学习率必须落在 $(0,1)$，不能三值。

---

## 12. 完整前向

记 token 序列 $z_1,z_2,\dots$，时刻 $t$，层 $\ell=1,\dots,L$（下文省略层标）。$\odot$ 为逐元乘。

### 12.1 嵌入与 RMSNorm

共享嵌入 $E\in\mathbb{R}^{V\times d}$（三值，第 $j$ 行尺度 $\alpha_j$）。入口缩放与 RMSNorm（Zhang & Sennrich, 2019）：

$$x_t^{(0)}=\sqrt{d}\, E_{z_t,:}^{\mathrm{T}},\qquad
R_\gamma(u)=\gamma\odot u\,\rho,\qquad
\rho=\Bigl(\tfrac1n\lVert u\rVert_2^2+10^{-5}\Bigr)^{-1/2}.$$

$\sqrt{d}$ 把三值行从 $O(1)$ 抬到与通道维匹配的 RMS，对应注意力里 $1/\sqrt{d_k}$ 的**反向**方差控制，不是注意力本身。宏 `TAO_INPUT_SCALE` 打开时 CPU 逐步会乘这个因子。每层入口 $h_t=R_{\gamma_{\mathrm{in}}}(x_t^{(\ell)})$。

`CpuModel::norm` 就是 $R_\gamma$：

```cpp
Vec norm(const Vec& x, const std::string& name) const {
  const auto& g = w.at(name);
  float sum = 0;
  for (float z : x) sum += z * z;
  float inv = 1 / std::sqrt(sum / x.size() + 1e-5f);
  Vec y(x.size());
  for (size_t j = 0; j < x.size(); ++j) y[j] = x[j] * inv * g[j];
  return y;
}
```

### 12.2 短状态

$$
u_t=W_{sx}h_t+W_{ss}s_{t-1}+b_s,\qquad
a_t=G_{sx}h_t+G_{ss}s_{t-1}+b_{gs},
$$

$$
s_t=s_{t-1}+\sigma(a_t)\odot\bigl(\tanh(u_t)-s_{t-1}\bigr)
=(1-\sigma(a_t))\odot s_{t-1}+\sigma(a_t)\odot\tanh(u_t).
$$

部署与训练默认三阶 Padé，并夹紧（R4）：

$$\widehat{\tanh}(x)=\frac{x(27+x^2)}{27+9x^2},\quad
|x|>3\Rightarrow\pm 1,\qquad
\widehat{\sigma}(x)=\tfrac12\bigl(1+\widehat{\tanh}(x)\bigr).$$

这是 $\tanh$ 在 0 处的 $(3,2)$ Padé；夹紧保证 $|\widehat{\tanh}|\le 1$，定理 1 才成立。`cpu_fast_activation.hpp`：

```cpp
inline float fast_tanh(float x) {
  if (x > 3.0f) return 1.0f;
  if (x < -3.0f) return -1.0f;
  const float q = x * x;
  return x * (27.0f + q) / (27.0f + 9.0f * q);
}
inline float fast_sigmoid(float x) {
  return 0.5f * (1.0f + fast_tanh(x));
}
inline void fast_gated_update(float* state, float* cand,
                              const float* gate, size_t n) {
  for (size_t j = 0; j < n; ++j)
    state[j] += fast_sigmoid(gate[j]) * (fast_tanh(cand[j]) - state[j]);
}
```

AVX2 路径先把 $u,a$ 夹进 $[-3,3]$ 再走同一有理式，尾循环回标量，与 GPU `ds_act_tanh` 同式。记忆写入强度 $\beta_t$ **仍用精确 sigmoid**（`ds_sigmoid` / `CpuModel::sigmoid`），保证落在 $(0,1)$，不走 Padé。

参考逐步核（`dual_state_cpu.hpp`，精确 `tanh/sigmoid`，便于对账）：

```cpp
auto temp = [&](const std::string& branch) {
  Vec z = linear(p + branch + ".x", xn, c.s);
  add(z, linear(p + branch + ".s", s, c.s));
  add(z, w.at(p + branch + ".bias"));
  return z;
};
auto u = temp("s.candidate"), a = temp("s.gate");
for (size_t j = 0; j < s.size(); ++j)
  s[j] += sigmoid(a[j]) * (std::tanh(u[j]) - s[j]);
```

`s[j] += σ(tanh(u)-s)` 是凸组合的增量写法，和 $(1-\sigma)s+\sigma\tanh(u)$ 代数恒等。

### 12.3 记忆：先写后读的增量规则

会话开始 $M_0=0$。由同一 $h_t$ 投影

$$
k_t=W_k h_t\in\mathbb{R}^{d_k},\quad
q_t=W_q h_t\in\mathbb{R}^{d_k},\quad
v_t=W_v h_t\in\mathbb{R}^{m},\quad
\beta_t=\sigma(\langle w_\beta,h_t\rangle+b_\beta)\in(0,1).
$$

$$
\hat k_t=\frac{k_t}{\lVert k_t\rVert_2+10^{-6}},\qquad
a_t=M_{t-1}\hat k_t,
$$

$$
M_t=M_{t-1}+\beta_t(v_t-a_t)\hat k_t^{\mathrm{T}},\qquad
o_t=M_t q_t.
$$

$\hat k$ 写地址，$q$ 读地址，$v$ 载荷，$\beta$ 这一步的写入学习率。逐行即

$$M_t[i,:]=M_{t-1}[i,:]+\beta_t(v_t[i]-a_t[i])\,\hat k_t.$$

**融合恒等式**（少扫一次 $M$）。令 $u_t=\beta_t(v_t-a_t)$，则 $M_t=M_{t-1}+u_t\hat k_t^{\mathrm{T}}$，

$$
\begin{aligned}
o_t
&=M_t q_t
=(M_{t-1}+u_t\hat k_t^{\mathrm{T}})q_t
=M_{t-1}q_t+u_t(\hat k_t^{\mathrm{T}}q_t)\\
&=M_{t-1}q_t+\beta_t(v_t-M_{t-1}\hat k_t)\,(\hat k_t^{\mathrm{T}}q_t).
\end{aligned}
$$

$M$ 的流量从 3 次降为 2 次。行互不相交：任意按行划分线程，与串行 **bitwise 一致**。

会话状态不是「token 窗口」。`LayerState` 把 $s|M$ 收成一块 64 字节对齐的连续区，解码器可以整段预取进 L2：

```cpp
struct LayerState {
  std::unique_ptr<float, AlignedFree> raw;
  FSpan s, m;
  static size_t packed_off(size_t ns) { return (ns + 15u) & ~size_t(15); }
  void reset(size_t ns, size_t nm) {
    const size_t off = packed_off(ns);
    float* p = alloc64_floats(off + nm);
    std::memset(p, 0, (off + nm) * sizeof(float));
    raw.reset(p);
    s = {p, ns};
    m = {p + off, nm};
  }
};
```

CPU 逐步的融合写读（同一文件）：

```cpp
const uint32_t dk = c.dk, dv = c.m;
auto k = linear(p + "mem.key", xn, dk);
auto q = linear(p + "mem.query", xn, dk);
auto v = linear(p + "mem.value", xn, dv);
float kn = 0;
for (float z : k) kn += z * z;
kn = 1.0f / (std::sqrt(kn) + 1e-6f);
for (float& z : k) z *= kn;                          // k̂
float beta = sigmoid(linear(p + "mem.beta", xn, 1)[0]
                     + w.at(p + "mem.beta.bias")[0]);
float kq = 0;
for (uint32_t j = 0; j < dk; ++j) kq += k[j] * q[j]; // k̂ᵀ q
Vec o(dv, 0);
for (uint32_t i = 0; i < dv; ++i) {
  float* row = m.data() + size_t(i) * dk;
  float acc = 0, rd = 0;
  for (uint32_t j = 0; j < dk; ++j) {
    const float mv = row[j];
    acc += mv * k[j];                               // (M k̂)[i]
    rd  += mv * q[j];                               // (M q)[i]
  }
  const float g = beta * (v[i] - acc);
  o[i] = rd + g * kq;                               // 先写后读
  for (uint32_t j = 0; j < dk; ++j) row[j] += g * k[j];
}
```

CUDA 前向把同一代数拆成核（`delta_mem_kernels.cuh`）。每个 slot 一个 block，行 $i$ 一个 thread：

```cuda
__global__ void dm_normalize_fwd(const float* k, float* khat, float* norm,
                                 unsigned dk) {
  unsigned s = blockIdx.x;
  if (threadIdx.x) return;
  const float* r = k + size_t(s) * dk;
  float ss = 0;
  for (unsigned j = 0; j < dk; ++j) ss += r[j] * r[j];
  const float nr = sqrtf(ss);
  norm[s] = nr;
  const float inv = 1.0f / (nr + 1e-6f);
  float* o = khat + size_t(s) * dk;
  for (unsigned j = 0; j < dk; ++j) o[j] = r[j] * inv;
}

__global__ void dm_forward(const float* M, const float* khat, const float* q,
    const float* v, const float* beta, float* Mout, float* o, float* a,
    unsigned dv, unsigned dk) {
  unsigned s = blockIdx.x, i = threadIdx.x;
  if (i >= dv) return;
  const float* src = M + (size_t(s) * dv + i) * dk;
  const float* kh = khat + size_t(s) * dk;
  const float* qq = q + size_t(s) * dk;
  float acc = 0;
  for (unsigned j = 0; j < dk; ++j) acc += src[j] * kh[j];
  const float b = beta[s];
  const float g = b * (v[size_t(s) * dv + i] - acc);
  float* dst = Mout + (size_t(s) * dv + i) * dk;
  for (unsigned j = 0; j < dk; ++j) dst[j] = src[j] + g * kh[j];
  float rd = 0;
  for (unsigned j = 0; j < dk; ++j) rd += dst[j] * qq[j];
  o[size_t(s) * dv + i] = rd;
  a[size_t(s) * dv + i] = acc;
}
```

GPU 训练按槽位并行、时间上仍是递推：每个 slot 自己的 $M$ 沿 $t$ 走，块宽 $W=32$ 的 TBPTT。前向把 $M'$ 写到 `Mout`，下一时间步的 $M$ 就是这份缓冲。

### 12.4 读出、残差、词表头

$$r_t=W_{rs}s_t+o_t,\qquad
x_t^{(\ell+1)}=x_t^{(\ell)}+R_{\gamma_{\mathrm{read}}}(r_t).$$

无 FFN。$L$ 层后绑定嵌入作分类头：

$$\ell_t=E\,R_{\gamma_f}(x_t^{(L)})+b_V,\qquad
p(z_{t+1}=j\mid z_{\le t})=\frac{e^{\ell_{t,j}}}{\sum_i e^{\ell_{t,i}}}.$$

`CpuModel::step` 末尾：`linear("embedding", norm(x, "final.norm"), c.vocab)` 再加 `vocab.bias`。贪心解码不物化整段 logits，只在行上 argmax。特殊号 256/257/258（BOS / USER / ASSISTANT）永不作为生成 token。

会话协议 TLP2：用户字节 `loss=false`；助手字节与助手侧 `TURN_END`(259) / `EOS`(260) 的 `loss=true`。解码：`BOS`（仅新会话）→ `USER` → 提示 → `TURN_END` → 从 `ASSISTANT` 起贪心，直到 259/260 或 `max_out`。

---

## 13. 定理 1–6

以下均对单层书写；多层只是把残差串起来，证明不变。

### 定理 1（短状态 $\ell_{\infty}$ 有界）

设 $s_0=0$，激活满足 $\widehat{\sigma}\in(0,1)$、$|\widehat{\tanh}|\le 1$（夹紧区取等）。则对一切 $t$ 与坐标 $j$，

$$|s_t[j]|\le 1.$$

**证明.** 对 $t$ 归纳。$t=0$ 显然。坐标互不耦合，只看标量

$$s\leftarrow(1-\sigma)s+\sigma u,\qquad \sigma\in(0,1),\ |u|\le 1.$$

这是 $s$ 与 $u$ 的凸组合，故 $|s'|\le\max(|s|,|u|)\le 1$。Padé 在 $|x|\le 3$ 时 $|\widehat{\tanh}(x)|<1$，在 $|x|>3$ 时恰好 $\pm 1$，前提满足。∎

因此短状态不能靠发散幅值「记住」任意历史。

### 定理 2（写入是一步加权最小二乘梯度）

记 $f(M)=\frac12\lVert M\hat k_t-v_t\rVert_2^2$，Frobenius 内积 $\langle A,B\rangle=\sum_{ij}A_{ij}B_{ij}$。则

$$\nabla_M f=(M\hat k_t-v_t)\hat k_t^{\mathrm{T}},\qquad
M_t=M_{t-1}-\beta_t\nabla_M f\big|_{M_{t-1}}.$$

**证明.** 令 $a=M\hat k$。$f=\frac12\lVert a-v\rVert_2^2$。微分

$$\mathrm{d}f=\langle a-v,\,(\mathrm{d}M)\hat k\rangle
=\langle(a-v)\hat k^{\mathrm{T}},\,\mathrm{d}M\rangle.$$

故 $\nabla_M f=(a-v)\hat k^{\mathrm{T}}=(M\hat k-v)\hat k^{\mathrm{T}}$。增量规则右边

$$\beta_t(v-M\hat k)\hat k^{\mathrm{T}}=-\beta_t\nabla_M f.$$

∎

**推论（沿写地址的凸组合）.**

$$
M_t\hat k_t
=M_{t-1}\hat k_t+\beta_t(v_t-M_{t-1}\hat k_t)(\hat k_t^{\mathrm{T}}\hat k_t)
=(1-\beta_t\tau)M_{t-1}\hat k_t+\beta_t\tau v_t,
$$

其中

$$\tau=\hat k_t^{\mathrm{T}}\hat k_t
=\frac{\lVert k_t\rVert_2^2}{(\lVert k_t\rVert_2+\varepsilon)^2}.$$

$\varepsilon=10^{-6}\ll\lVert k\rVert$ 时 $\tau\approx 1$，该方向以比例 $\beta_t$ 被拉向 $v_t$。$\beta_t(h_t)$ 是输入调制的逐步学习率。

### 定理 3（正交地址不互扰）

若 $\hat k_t\perp\hat k'$，则对任意 $M_{t-1}$：

$$M_t\hat k'=M_{t-1}\hat k'.$$

**证明.**

$$M_t\hat k'=M_{t-1}\hat k'+\beta_t(v_t-M_{t-1}\hat k_t)(\hat k_t^{\mathrm{T}}\hat k').$$

正交使第二项为零。等式不依赖 $\varepsilon$。∎

所以 $M$ 是**以 key 方向为地址的有限关联存储**：可写、可覆写，容量由 $d_k$ 维球面的可分辨方向与碰撞决定。它不是无限记忆，也不是压缩版注意力。$d_k=64$，可分辨方向远小于「任意历史位置」。

### 定理 4（状态与每步计算均为 $O(1)$）

每层 $|s|+|M|=128+512\cdot 64=32896$ 个 float。两层合计 257 KiB。一层每 token 乘加

$$
\begin{aligned}
&2(sd+s^2) && \text{短状态候选/门}\\
&+\ d(2d_k+m) && k,q,v\text{ 投影}\\
&+\ 2m d_k && \text{融合写读}\\
&+\ ds && \texttt{read.s}\\
&=655360.
\end{aligned}
$$

词表头 $Vd=8388608$，约占逐步计算的 86%。上下文变长时这两项都不涨。训练是宽 $W=32$ 的截断 BPTT，块边界只延续槽位上的 $(s,M)$，不存 KV。

### 定理 5（逐行最优三值重构）

对 master 行 $w\in\mathbb{R}^n$，

$$\min_{\alpha\ge 0,\, q\in\{-1,0,1\}^n}\lVert w-\alpha q\rVert_2^2.$$

固定非零支撑 $S$ 时，$\alpha_S^\ast=\frac1{|S|}\sum_{i\in S}|w_i|$，最优值

$$J^\ast(S)=\lVert w\rVert_2^2-\frac{\bigl(\sum_{i\in S}|w_i|\bigr)^2}{|S|}.$$

故全局最优等价于在 $|w|$ 降序前缀上最大化 $A_k^2/k$。

**证明.** 固定 $S$，最优 $q_i=\operatorname{sign}(w_i)$（$i\in S$）否则 $0$（同号才能减小平方；异号只会增大）。目标对 $\alpha$ 是二次：

$$J(\alpha)=\sum_{i\in S}(w_i-\alpha\operatorname{sign}(w_i))^2+\sum_{i\notin S}w_i^2.$$

$0=\partial_\alpha J\Rightarrow \alpha=\frac1{|S|}\sum_{i\in S}|w_i|$（若 $S=\emptyset$ 则 $\alpha$ 任意、等效全零）。代入得 $J=\lVert w\rVert_2^2-A(S)^2/|S|$。最小化 $J$ 即最大化 $A(S)^2/|S|$。

支撑必是幅值序下的某个前缀：若 $i\notin S$、$j\in S$ 且 $|w_i|>|w_j|$，把 $j$ 换成 $i$，$A$ 严格增加、$|S|$ 不变，$A^2/|S|$ 上升。等幅时按下标升序打破平局，实现可复现。于是只需扫 $k=1,\dots,n$，令 $A_k=\sum_{i=1}^{k}|w|_{\downarrow i}$，取最大 $A_k^2/k$。等值取最小 $k^\ast$（更短支撑）。∎

这是实数算术下该行的全局最优，不是 TWN 论文里的阈值启发式。反传对离散 $q$ 用 identity STE（Bengio et al., 2013）：

$$\frac{\partial\mathcal L}{\partial w^{\mathrm{master}}}
\approx\frac{\partial\mathcal L}{\partial w^{\mathrm{eff}}},\qquad
w^{\mathrm{eff}}=\operatorname{diag}(\alpha)\,q.$$

磁盘 2-bit 只是序列化；Adam 走 float master。

`dual_projection_sorted.cuh` 一行一个 block，幅值降序 + 下标升序 bitonic，然后前缀最大化：

```cuda
template<int Width>
__global__ void ds_project_sorted(const float* master, float* out, float* scales,
                                  int rows, int cols) {
  int row = blockIdx.x;
  if (row >= rows) return;
  __shared__ float mag[Width];
  __shared__ int idx[Width];
  __shared__ int chosen;
  __shared__ float alpha;
  for (int i = threadIdx.x; i < Width; i += blockDim.x) {
    mag[i] = i < cols ? fabsf(master[size_t(row) * cols + i]) : -1.f;
    idx[i] = i;
  }
  __syncthreads();
  for (int k = 2; k <= Width; k *= 2)
    for (int j = k / 2; j; j /= 2) {
      for (int i = threadIdx.x; i < Width; i += blockDim.x) {
        int other = i ^ j;
        if (other > i) {
          bool before = mag[i] > mag[other]
                     || (mag[i] == mag[other] && idx[i] < idx[other]);
          bool descending = (i & k) == 0;
          if (before != descending) {
            float m = mag[i]; mag[i] = mag[other]; mag[other] = m;
            int n = idx[i]; idx[i] = idx[other]; idx[other] = n;
          }
        }
      }
      __syncthreads();
    }
  if (threadIdx.x == 0) {
    float sum = 0, best = -1;
    chosen = 0; alpha = 1;
    for (int i = 0; i < cols; ++i) {
      sum += mag[i];
      float score = sum * sum / (i + 1);
      if (score > best) { best = score; chosen = i + 1; alpha = sum / chosen; }
    }
    if (best == 0) alpha = 1;
    scales[row] = alpha;
  }
  __syncthreads();
  for (int i = threadIdx.x; i < cols; i += blockDim.x) {
    int col = idx[i];
    float v = master[size_t(row) * cols + col];
    out[size_t(row) * cols + col] = (i < chosen && v != 0) ? copysignf(alpha, v) : 0;
  }
}
```

`Width` 取 128/256/512/1024 中刚好比 `cols` 大的档；词表行 $d=512$ 走 `<512>`。

### 定理 6（参数计数）

由 schema 直接加和：

$$
P_{\mathrm{tern}}=Vd+L\bigl[2(sd+s^2)+2d_k d+md+ds\bigr]=9502720,
$$

$$
P_{\mathrm{flt}}=V+d+L(2s+d+1+2d)=20482,\qquad P=9523202.
$$

拆开一层三值：$2(sd+s^2)=163840$（候选/门），$2d_k d=65536$（$k,q$），$md=262144$（$v$），$ds=65536$（`read.s`），合计 557056；两层 1,114,112；加嵌入 $Vd=8{,}388{,}608$。与 `dsb_ledger` 对账。

---

## 14. 定理 7：增量记忆的解析反向

前向（每 slot、每层）：

$$
\hat k=\frac{k}{\lVert k\rVert+\varepsilon},\quad
a=M\hat k,\quad
u=\beta(v-a),\quad
M'=M+u\hat k^{\mathrm{T}},\quad
o=M'q.
$$

记 $\delta o=\partial\mathcal L/\partial o$，$\delta M'=\partial\mathcal L/\partial M'$。$M'$ 同时还要当下一个时间步的 $M$，所以它自己有梯度缓冲 `dMout`。源码注释把 $M'=M+u\hat k^{\mathrm{T}}$ 与 $a=M\hat k$ 全式展开后消去，只留两个 per-slot 中间向量。

**中间量.**

$$
c=\langle q,\hat k\rangle,\qquad
p=\delta M'\,\hat k,\qquad
\delta u=\delta o\cdot c+p.
$$

第一项：$\partial o/\partial u=c$（因为 $o=Mq+uc$）。第二项：$\partial M'/\partial u$ 沿 $\hat k$ 外积，故 $\delta u$ 还吃到 $\delta M'\hat k$。

令 $\Delta=v-a$。则 $u=\beta\Delta$，

$$
\delta\beta=\langle\delta u,\Delta\rangle,\qquad
\delta v+=\beta\,\delta u,\qquad
e=\langle\delta o,\Delta\rangle.
$$

对 $M$：

$$
\delta M=\delta o\, q^{\mathrm{T}}+\delta M'-\beta\,\delta u\,\hat k^{\mathrm{T}}.
$$

来源三条：$o$ 对 $M$ 的直接路（经 $M q$，注意前向是先写后读，展开后与「对 $M'$ 再链式到 $M$」合并成上式）；$\delta M'$ 的直通；以及 $u$ 对 $a=M\hat k$ 的依赖（$u=\beta(v-M\hat k)$ 给出 $-\beta\delta u\,\hat k^{\mathrm{T}}$）。

对 $\hat k$ 与 $q$：

$$
\begin{aligned}
\delta\hat k
&+=\beta e\, q+(\delta M')^{\mathrm{T}} u-\beta M^{\mathrm{T}}\delta u,\\
\delta q
&+=M^{\mathrm{T}}\delta o+\hat k\cdot(\beta e).
\end{aligned}
$$

核里 $u_i=\beta(v_i-a_i)$，所以 $(\delta M')^{\mathrm{T}}u$ 写成 $\sum_i\delta M'_{ij}\cdot\beta(v_i-a_i)$。

**归一化反向.** $\hat k=k/(\lVert k\rVert+\varepsilon)$，$\varepsilon$ 当常量，$\lVert k\rVert$ 的依赖保留。令 $n=\lVert k\rVert+\varepsilon$，$\hat k=k/n$，

$$\delta k=\frac{\delta\hat k}{n}-\hat k\cdot\frac{\langle\delta\hat k,\hat k\rangle}{\lVert k\rVert}$$

（$\lVert k\rVert$ 极小时分母夹到 $10^{-12}$）。`dm_normalize_bwd` 用 shared `dot` 算 $\langle\delta\hat k,\hat k\rangle$。

**单步特例.** $\delta M'=0$ 时 $p=0$，$\delta u=\delta o\cdot c$，全部退化成只依赖 $c,e$ 两个标量。已用有限差分逐项核对。

反向核（同一文件，按计算顺序）：

```cuda
// p[i] = sum_j dMout[i,j] k^[j]
__global__ void dm_proj_bwd(const float* dMout, const float* khat, float* p,
                            unsigned dv, unsigned dk) {
  unsigned s = blockIdx.x, i = threadIdx.x;
  if (i >= dv) return;
  const float* r = dMout + (size_t(s) * dv + i) * dk;
  const float* kh = khat + size_t(s) * dk;
  float z = 0;
  for (unsigned j = 0; j < dk; ++j) z += r[j] * kh[j];
  p[size_t(s) * dv + i] = z;
}

__global__ void dm_scalars_bwd(
    const float* q, const float* khat, const float* do_, const float* v,
    const float* a, const float* p, const float* beta,
    float* c, float* e, float* du, float* dbeta,
    unsigned dv, unsigned dk) {
  unsigned s = blockIdx.x;
  if (threadIdx.x) return;
  const float* qq = q + size_t(s) * dk;
  const float* kh = khat + size_t(s) * dk;
  float cc = 0;
  for (unsigned j = 0; j < dk; ++j) cc += qq[j] * kh[j];
  const float* dd = do_ + size_t(s) * dv;
  const float* vv = v + size_t(s) * dv;
  const float* aa = a + size_t(s) * dv;
  const float* pp = p + size_t(s) * dv;
  float* uu = du + size_t(s) * dv;
  float ee = 0, db = 0;
  for (unsigned i = 0; i < dv; ++i) {
    const float delta = vv[i] - aa[i];
    const float u = dd[i] * cc + pp[i];
    uu[i] = u;
    ee += dd[i] * delta;
    db += u * delta;
  }
  c[s] = cc; e[s] = ee; dbeta[s] = db;
}

__global__ void dm_dM_dv_bwd(
    const float* dMout, const float* khat, const float* q, const float* do_,
    const float* du, const float* beta, float* dM, float* dv_,
    unsigned dv, unsigned dk) {
  unsigned s = blockIdx.x, i = threadIdx.x;
  if (i >= dv) return;
  const float b = beta[s], u = du[size_t(s) * dv + i], d = do_[size_t(s) * dv + i];
  dv_[size_t(s) * dv + i] += b * u;
  const float* kh = khat + size_t(s) * dk;
  const float* qq = q + size_t(s) * dk;
  const float* mo = dMout + (size_t(s) * dv + i) * dk;
  float* row = dM + (size_t(s) * dv + i) * dk;
  const float s1 = d, s2 = -b * u;
  for (unsigned j = 0; j < dk; ++j)
    row[j] += s1 * qq[j] + s2 * kh[j] + mo[j];
}

__global__ void dm_dkhat_dq_bwd(
    const float* M, const float* khat, const float* q, const float* do_,
    const float* v, const float* a, const float* du, const float* e,
    const float* beta, const float* dMout,
    float* dkhat, float* dq, unsigned dv, unsigned dk) {
  unsigned s = blockIdx.x, j = threadIdx.x;
  if (j >= dk) return;
  const float b = beta[s];
  float h = 0, w = 0, z = 0;
  for (unsigned i = 0; i < dv; ++i) {
    const size_t o = (size_t(s) * dv + i) * dk + j, si = size_t(s) * dv + i;
    const float d = do_[si];
    h += M[o] * d;
    w += dMout[o] * (b * (v[si] - a[si]));
    z += du[si] * M[o];
  }
  const float be = b * e[s];
  dkhat[size_t(s) * dk + j] += be * q[size_t(s) * dk + j] + w - b * z;
  dq[size_t(s) * dk + j] += h + khat[size_t(s) * dk + j] * be;
}

__global__ void dm_normalize_bwd(const float* khat, const float* dkhat,
                                 const float* norm, float* dkout, unsigned dk) {
  __shared__ float dot;
  unsigned s = blockIdx.x, j = threadIdx.x;
  if (j == 0) {
    float z = 0;
    for (unsigned t = 0; t < dk; ++t)
      z += dkhat[size_t(s) * dk + t] * khat[size_t(s) * dk + t];
    dot = z;
  }
  __syncthreads();
  if (j < dk) {
    const float nr = norm[s];
    const float n = nr + 1e-6f;
    dkout[size_t(s) * dk + j] +=
        dkhat[size_t(s) * dk + j] / n
        - khat[size_t(s) * dk + j] * dot / (nr > 1e-12f ? nr : 1e-12f);
  }
}

__global__ void dm_sigmoid_bwd(const float* y, const float* dy, float* dx, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) {
    const float s = y[i];
    dx[i] += dy[i] * s * (1.0f - s);
  }
}
```

跨步复用时多出的三项都是 $\delta M'$ 的投影，不需要额外保存 $M'$——`dMout` 就是 $M'$ 自己的梯度缓冲，也不需要 $a$ 的梯度缓冲（前向的 $a$ 只用于算 $e$）。

---

## 15. 它是如何学习的

助手位掩码 $\mu_t\in\{0,1\}$，$N=\sum_t\mu_t$：

$$
\mathcal L=-\frac1N\sum_t\mu_t\log p(z_{t+1}\mid z_{\le t}),\qquad
\frac{\partial\mathcal L}{\partial \ell_{t,j}}
=\frac{\mu_t}{N}\bigl(p_{t,j}-\mathbf{1}[j=z_{t+1}]\bigr).
$$

实现见 `ds_ce_batch`：无监督槽位梯度为 0，有监督槽位做稳定 log-sum-exp。

Teacher forcing 喂**真实**历史，不是自己的采样。$(s,M)$ 按宽 $W=32$ 的图块反向，槽位（默认 32）之间并行。文档边界 `reset` 把该槽的 $s,M$ 清零。这是截断 BPTT，不是 Transformer 的全序列注意力反向。

**低训练 NLL 不蕴涵不循环。** 生成用自身 token，训练用金标 token，分布偏移是一阶事实。评测看空回复、复读、bigram F1、CoT 是否算对。

AdamW：$\beta_1=0.9$，$\beta_2=0.999$，主权重衰减 $0.01$（仅三值 master），$\varepsilon=10^{-8}$。梯度先按监督计数与全局 L2 范数归一，再可叠加 `TAO_GRAD_CLIP`（默认 1.0）。学习率 20 步线性 warmup，然后从 `TAO_LR_DECAY_START` 起余弦到 `TAO_LR_MIN`。

三值矩阵每步：`master --AdamW--> master'`，再 `project_sorted` 得到 $w^{\mathrm{eff}}$ 供下一前向。STE 把对 $w^{\mathrm{eff}}$ 的梯度记到 master。

---

## 16. R4：训练与推理同算子

短状态的 $\widehat{\tanh}/\widehat{\sigma}$ 在 GPU 训练核与 CPU 解码里是**同一有理式**。`act_parity_test.cu` 检验三件事：

1. 前向：`ds_act_tanh/ds_act_sigmoid`（GPU）对 `fast_tanh/fast_sigmoid`（CPU）。
2. 导数：`ds_act_tanh_grad` 对双精度中心差分（夹紧点 $\pm 3$ 附近跳过，差分无意义）。
3. 门控更新：GPU `st += σ(g)(tanh(u)-st)` 对 CPU `fast_gated_update`。

历史测量：前向一致 max $1.192\times 10^{-7}$（1 ULP）、导数对中心差分 max $1.925\times 10^{-7}$、门控更新 max $7.749\times 10^{-7}$。修复前精确 `tanhf`/`expf` 与 Padé 的偏差约为 $2.35\times 10^{-2}$ / $1.59\times 10^{-1}$。判据：语义等价 $\le 4$ ULP，而不是跨 ISA 逐位相等。1 ULP 来自 nvcc 的 FMA 收缩。

```cuda
static double ref_tanh(double x) {
  if (x > 3.0) return 1.0;
  if (x < -3.0) return -1.0;
  return x * (27.0 + x * x) / (27.0 + 9.0 * x * x);
}
__global__ void k_update(float* st, const float* u, const float* g, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) st[i] += ds_act_sigmoid(g[i]) * (ds_act_tanh(u[i]) - st[i]);
}
```

`TAO_FAST_ACT=0` 可回到精确激活，此时训练必须用 `-DTAO_TRAIN_EXACT_ACT`，否则再次违反 R4：权重会训到另一套非线性上，解码却用 Padé。

---

## 17. 解码侧（非注意力路线）

优化只允许三条轴：**少算、结果复用、算存分离**。禁止把 Transformer 的 KQV / KV cache / 层次稀疏注意力接到本算子上。

已经写进代数的复用：$s_t,M_t$ 本身就是跨 token 的状态；同一 $h_t$ 生成 $k,q,v,\beta$；融合式避免第三次扫 $M$；绑定嵌入让分类头就是 $E$。

CPU 热路径（Zen 4 AVX-512，`h2r_cpu`）：

1. **分档 VNNI**：仅 $\mathrm{rows}\cdot\mathrm{cols}\ge 10^6$ 的矩阵（词表头）走 `vpdpbusd`；层内小矩阵走 4 行打包 float 点积。
2. **`vnni8`**：8 个词表行共享一次 64B 的量化激活加载。
3. **线程池阈值 $2^{20}$**：只有词表头唤醒 8 线程；`mem.value` 恰好 262144 MAC，走单线程，避免同步比计算还贵。行不切开，阈值只改调度，bitwise 一致。
4. **`RecurBuf`**：$x,h,k,q,v,o,r$ 常驻复用。
5. **固定窗口进 L2**：每层 $s|M$ 一块 64 字节对齐（约 128.5 KiB），`T1` 预取；词表头权重走 `NTA`，减少 8.4 MiB 头把 $M$ 从 L2 挤出。这不是滑动窗口注意力。

实测（Ryzen 9 7940H，8 线程，512 forced 步）：均值约 $5.08\times 10^3$ tok/s。吞吐与上下文长度无关。钉住 257 KiB 几乎不改墙钟：窗口本来就进得了 1 MiB L2，逐步时间的 86% 仍是精确 greedy 头扫词表。

生成端重复惩罚（不是训练）：频率每出现一次 logit 减 $\lambda$；3-gram 硬阻断减 $10^6$；连写 4 次同一 token 收束为 `TURN_END`。v1 权重上 held-out 复读 $50\%\to 0\%$。内容错误仍在，那是权重问题。

---

## 18. 实证（到 2026-09-12）

硬件：Ryzen 9 7940H + RTX 4070 Laptop 8 GB。

**v1**（已冻结）：APE 2.5 万 + alpaca 1.5 万 + 逐位加减，3200 步，末步 NLL 约 2.9–3.5。旧 presence 惩罚下问答 200：空 0%，乱码 1%，**复读 50%**，bigram F1 0.008。CoT 280：格式几乎总有；APE 精确 14%；个位加法 2.5%。病根：APE 模板占比过高，9.5M 把「思考：计算…」当成万能回复。

**v2**（当前推荐 `release/L1_qa_cot_v2.dsb`）：alpaca 3.6 万 + 短 APE 8 千 + 五种问法的 1–20 加减；2800 步；末步 NLL 约 4.50。问答 200：空 0%，乱码 3.5%，复读 **0%**，bigram F1 0.0125。CoT：APE 精确 12.5%，个位加减 3.8%。内容仍弱：日常问答常串题；CoT 轨迹格式在、算术多数错。

9.5M 的诚实预期：学格式、短回复、短 CoT 外壳；不是应用题能力，也不是开放域知识。

---

## 19. 和论文的对照（只比序列混合）

| 对照 | 相对优势 | 相对缺点 |
|---|---|---|
| Transformer [1] | 无 $QK^{\mathrm{T}}V$、无 KV；257 KiB 与长度无关；本机 CPU 约 $5\times 10^3$ tok/s | 不能对全文做内容检索；无 FFN，同样宽度深度容量小 |
| LSTM / GRU [2][3] | 在有界 $s$ 之外多一张可寻址 $M$（定理 2–3） | $M$ 每步整表读+写；没有注意力那种任意对齐 |
| 线性注意力 [4] | 读写分离；融合式把 $M$ 扫描从 3 次收成 2 次 | 容量钉在 $m\times d_k$ 球面方向上，有限 |
| FWP / delta [5] | 定理 2–3 就是该更新；三值 + VNNI 落到笔记本 | 稠密扫 $M$；没有可学核 $\phi$ |
| Mamba [6] | $M$ 可按地址覆写，不涂正交方向 | 对角 SSM 更轻；没有对标规模的 LM 证据 |
| xLSTM / TFLA [7] | 与 mLSTM 的 $C$ 同型；优化应对准 $C\equiv M$ 分块 | 对方有 FFN、归一化 $n_t$、sLSTM mixing 与更大训练体量 |
| DeepSeek KV 压缩 [14] | 没有 KV 就没有 KV 压缩问题 | 买不到 CSA2 那种长程检索质量 |
| GRPO | — | 本版本只有 CE，没有组相对 RL |

稠密逐步下，总参数 $\approx$ 每步碰到的参数。稀疏（热集进 L3）只在「每步活跃集 $\ll$ 总参数」时改变速度列；本版未做。词频分片救不了全词表头和每步必用的层矩阵。

---

## 20. 结论

Transformer 用二次方注意力换任意对齐，再用 KV cache 把逐步算力从 $O(n^2)$ 降到 $O(n)$，于是 cache 本身变成部署账。LSTM 用恒定误差传送带解决沿时间的梯度，状态 $O(1)$ 但没有内容寻址。线性注意力证明有限矩阵状态与核注意力等价；FWP 的 delta 规则给出按地址覆写；xLSTM 的 $C$ 把外积写进 LSTM 框架；Mamba 让对角 SSM 的步长依赖输入；GRPO 是后训练，不管序列混合；DeepSeek-V4.1 在条目、序列、层三个维上压缩 KV，并且训练期模拟推理期近似。

夭夭把 GRU 式短状态和 FWP 的 delta 矩阵接到同一残差流上，删掉 FFN 和注意力。定理 1 管 $s$ 不爆炸；定理 2–3 管 $M$ 按地址写、正交不互扰；定理 4 管逐步 $O(1)$；定理 5 管三值投影是逐行最小二乘；定理 7 管 CUDA 反向与前向同一份代数，不存额外的 $M'$ 副本。代码路径是 `schema` → `LayerState` / `CpuModel::step` 的融合写读 → `dm_forward` / `dm_*_bwd` → `ds_project_sorted` → `act_parity_test` 钉住 R4。

没有注意力就没有 KV。这也放弃了按内容检索任意历史的能力。这是架构选择，不是尚未实现的优化。
