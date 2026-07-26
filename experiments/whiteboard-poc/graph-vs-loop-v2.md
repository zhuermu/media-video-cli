# Loop 还是 Graph

> cast: 主讲=narrator-female-warm, 吐槽=narrator-male-lively
> format: long
> cover: 7
> subtitle: 一场冷静的审计：什么真变了，什么只是换了层漆
> tagline: 一个 loop 就是 graph 里的一个节点

## Loop 工程已死？

主讲：七月十八号，OpenClaw 的作者 Peter Steinberger 在推上问了一句：我们还在聊 loop，还是已经转向 graph 了。第二天，「Loop 工程已死，Graph 工程当立」就刷满了时间线。

吐槽（轻快）：这一年里已经死过几样东西了？prompt 工程死过一次，RAG 死过两次，现在轮到 loop。

主讲：同一天，一位做 state machine 出身的工程师给这波说法的评价是：都是废话。两边都上火。这一集我们把这篇 AI Builder Club 的审计讲完：到底哪部分真变了，哪部分只是换了层漆。

```note speech
Loop 工程已死？
```

## 两个词各指什么

主讲：先把定义摆干净，两个词其实分得很清楚。loop 工程设计的是一个 agent 自己转的那个圈：discover、plan、execute、verify，直到满足停止条件。你不再手搓 prompt，改成设计这个圈和它的退出测试。

主讲：graph 工程是另一层的事——一个 loop 不够用了，你把多个专职 agent 连成一张有向图，state 沿着边流动。

```table
维度 | loop | graph
单元 | 一个圈 | 节点加边
你设计 | 停止条件 | topology
失效于 | verifier | 边接错了
```

## Loop 长什么样

主讲：loop 的形状是一个回头箭头。四步走完，verify 没过就回到开头再来一遍，过了才交付。

主讲：注意整条工程学的重心落在最后那一步——瓶颈从来不是模型，是你的 verifier。

吐槽：说白了，这活儿的本质是：写一个比你自己还严格的判卷老师。

```flow
discover
plan
execute
verify
verify -[没过]-> discover
```

## Graph 长什么样

主讲：graph 是把这些圈连起来。有个比喻我觉得最到位，来自 @rohit4verse：agent 正在从 while 循环毕业，进了组织架构图。专职节点并行干活，state 在它们之间流动。

吐槽（轻快）：等于从个体户升级成公司。好消息是产能上来了，坏消息是从此有了跨部门沟通问题。

![组织架构图](il:teamwork,organization,workflow)

## 一个人干全活

主讲：拿一个真实任务试试：每天早上读几个来源，写一页简报，核对准确再进你的收件箱。写成一个大 loop，就是一个 agent 在同一个 context 里搜索、堆原始网页、起草、然后审自己刚写的稿。

主讲：等它审稿的时候，context 已经是一锅粥：原始 HTML、写了一半的行文、它自己之前的推理，全泡在一起。而且它读来源只能一个一个读，因为 loop 的形状就是串的。

```status
error | context 成泥潭
error | 自己审自己
caution | 来源只能顺着读
```

## 自己审自己会怎样

吐槽（设问）：在写稿的那个 context 里审自己的稿，会发生什么？

主讲：它会给自己盖章通过。这跟让学生自己批自己的卷子是一回事——不是它不诚实，是它看不见自己的盲点，而那些盲点正是它刚才写下来的东西。

主讲：所以这条不是性能问题，是屁股决定脑袋的问题，光把模型换强解决不了。

![自己批卷子](il:review,approval,document)

## 同一个任务，拆成图

主讲：换成三个节点。research 并行铺开所有来源，只回结构化笔记，绝不写行文；write 只看干净笔记，看不到原始网页；review 在一个全新的 context 里，只拿到稿子和验收标准，不合格就 route 回 write。

主讲：关键在最后半句：是新的眼睛在审，不是写它的那双眼睛。

```flow
research
write
review
review -[不合格]-> write
```

## 真正新增的三件事

主讲：把这个例子一般化，graph 真正买到的能力就三样。每个节点有自己的 prompt、工具和干净 context；控制流是你提前定义好、能当图读的；还有单个 loop 在形状上做不到的那一步——fan-out 到 N 条分支并行跑，再 fan-in 汇合。

主讲：前两样是质量，第三样是新能力。LangGraph 的 StateGraph 和 Google ADK 都把这个形状做成了一等公民。

```icons
team | 专职分工
flow | 并行汇合
magnifier | 可审计
```

## 账单也要念一遍

主讲：诚实的另一半是代价，而那个大 loop 没跟你收这笔钱。三套 prompt 要维护；节点之间要定 state 契约——research 到底交给 write 哪几个字段；还有一批全新的失效模式：fan-in 时悄悄漏掉一个来源、routing 有 bug 转成死循环、state 从一个节点漏进下一个。

主讲：每天跑的任务，这笔开销换来的是真实质量。只跑一次的任务，它就是纯税。这笔账算不算得过，才是整个决定。

- ==三套== prompt
- **state 契约**
- fan-in ((漏来源))
- 死 routing

## 新范式还是新马甲

主讲：接下来是那个不客气但公道的读法：这个词是新的，这个做法不是。

~~graph 编排是刚发明的~~

主讲：LangGraph 早就用 add_node、add_edge 建 StateGraph，state 沿边传递；微软 AutoGen 的 GraphFlow 支持顺序、并行、条件和循环；Google ADK 有 graph workflow、routing 和跨系统委派。它们全都早于这个词。

吐槽：XState 的作者 @DavidKPiano 对此的感受大概是：这我们周二就在干。

- LangGraph
- AutoGen
- Google ADK
- ==全都更早==

## 四问自检

主讲：所以在你宣布「我们从 loop 升级到 graph 了」之前，先过这四问，数一下有几个「是」。

主讲：context 真的拆成专职的了吗？有没有真正的 fan-out 加 fan-in，而不是一串你画成方块的顺序步骤？routing 能不能当图读，是提前定义好的还是涌现出来的？最后一问最关键，也是怀疑派 @PawelHuryn 的原话——目标和验收标准，变了吗？

- context 拆了
- fan-out 了吗
- routing 可读
- **验收标准**变了

## 数几个是

主讲：零到一个是，你手上是一个披着 graph 图纸的 loop，那就留着它做 loop，省下那一堆失效模式。

主讲：两到三个是，你在真正地把 loop 组合成 graph，新能力开始抵得上它的成本。四个都是，那是活儿逼着你换的，不是时间线逼你换的。

```status
error | 零到一：还是 loop
caution | 二到三：在组合
success | 四个是：换范式
```

## Graph 是第五层

主讲：把它放回坐标系里就不容易吵起来了。按 @sairahul1 的框架，一个 AI 应用有五层，从模型往外一层层包：prompt、context、harness、loop、graph。

主讲：graph 是最外那层，它包住下面的层，不替换它们。所以 loop 不会被淘汰——graph 里的每个节点，本身就是一个 loop。

```mindmap
五层
prompt
context
harness
loop
graph
```

## 带走这一句

主讲：graph 工程既是真的，也被过度营销了，这两句同时成立。真正新的是并行专职节点、fan-out 加 fan-in、还有能当图读的控制流；被重新包装的是那个词本身。

主讲：留下来的框架其实很朴素：一个 loop 就是 graph 里的一个节点。先把 loop 做对，等一个 loop 真的不够用了，再把它们连成 graph。

```note cloud
先把 loop 做对
```
