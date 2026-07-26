# Loop 还是 Graph：一次冷静的审计

> cast: 主讲=narrator-male-lively, 追问=narrator-female-lively
> format: short
> background: grid

## Loop 工程已死？

主讲（轻快）：七月十八号，OpenClaw 作者 Peter Steinberger 抛出一问——我们还在聊 loop，还是转向 graph 了？

追问（设问）：一天之内，「Loop 已死，Graph 当立」就刷满时间线，真变天了？

主讲：同一天，一位 state machine 老兵回了俩字：废话。两边都上火。这条片子只做一件事——把这场审计讲冷静。

```scene discussion
两拨人吵翻了
```

## 先把两个词分清

主讲：先把定义摆干净。loop 工程，设计的是一个 agent 自己转的圈：discover、plan、execute、verify，转到停止条件为止。

主讲：graph 工程是另一层——一个 loop 不够用了，把多个专职节点连成有向图，state 沿边流动。

```table
维度 | loop | graph
单元 | 一个圈 | 节点+边
你设计 | 停止条件 | topology
失效于 | verifier | 边接错
```

## Loop 长什么样

主讲：loop 的形状就是一个回头箭头。verify 没过就回开头重来，过了才交付。

主讲：整条工程学的重心全压在最后一步——瓶颈从不是模型，是你的 verifier。

```flow
discover
plan
execute
verify
verify -[没过]-> discover
```

## 拿一个真任务试试

主讲：拿个真任务：每天读几个来源，写一页简报，核对准确再进收件箱。

追问：先用一个大 loop 写会怎样？

主讲：一个 agent 在同一个 context 里搜索、堆网页、起草、再审自己的稿。三个毛病一起冒出来。

```status
error | context 成泥潭
error | 自己审自己的稿
caution | 来源只能顺着读
```

## 自己审自己会怎样

追问（设问）：在写稿的 context 里审自己的稿，能审出问题吗？

主讲：审不出，只会给自己盖章。就像让学生批自己的卷子——盲点正好是它刚写下的东西，换强模型也没用。

![self review](il:review,approval,document)

## 同一个任务，拆成图

主讲：换成三个节点，state 沿边流动。researcher 并行铺开所有来源，只回结构化 notes，绝不写行文。

主讲：writer 只看干净 notes，看不到原始 HTML；reviewer 在全新 context 里，只拿稿子和验收标准。

追问：不合格呢？

主讲：route 回 writer。是新的眼睛在审，不是写它的那双眼睛。

```flow
research
writer
review
review -[不合格]-> writer
```

## 从 while 循环毕业

主讲：有个比喻最到位，来自 @rohit4verse——agent 正从 while 循环毕业，进了组织架构图。

追问（轻快）：等于从个体户，升级成开公司。

主讲：产能上来了，代价是——从此有了跨部门沟通的问题。

![org chart](il:teamwork,organization,collaboration)

## Graph 真正买到什么

主讲：一般化看，graph 真正新增的能力就三样：每个节点有自己的 prompt、工具、干净 context；控制流能当图读；还有 loop 做不到的——fan-out 并行，再 fan-in 汇合。

```icons
team | 专职分工
rocket | 并行汇合
magnifier | 路径可审
```

## 账单也得念一遍

主讲（严肃）：诚实的另一半是代价，那个大 loop 从没跟你收。三套 prompt 要维护，节点间还要定一份 state 契约。

主讲：外加一批全新的失效模式，全得自己扛。

- ==三套== prompt
- **state 契约**
- fan-in ((漏来源))
- routing 死循环

## 是新范式还是新马甲

主讲：不客气但公道的读法，来自 @PawelHuryn——词是新的，做法不是。

主讲：state machine 和 graph 编排早就在跑：LangGraph、AutoGen、Google ADK，全都早于这个词。

~~graph 编排是新发明~~

- 词是 ==新的==
- 做法 **不新**
- 都早于它

## 四问自检

追问：怎么判断是真换了范式，还是只换了说法？

主讲：@PawelHuryn 给了四问，数几个「是」：context 真拆成专职的了吗？有真正的 fan-out 加 fan-in 吗？routing 能当图读吗？还有最狠一问——目标和验收标准变了吗？

- context 拆了吗
- fan-out 了吗
- routing 可读
- **验收标准**变了

## 数几个是

主讲：零到一个是，你手上是披着 graph 图纸的 loop，那就留着做 loop，省下一整套失效模式。

主讲：两到三个是，你在真正把 loop 组合成 graph；四个都是，那是活儿逼你换的，不是时间线。

```status
error | 0~1：还是 loop
caution | 2~3：在组合
success | 4 个：换范式
```

## Graph 是第五层

主讲：放回坐标系就不容易吵了。按 @sairahul1 的框架，AI 应用有五层，从模型往外一层层包：prompt、context、harness、loop、graph。

主讲：graph 是最外那层，包住下面的层、不替换。所以 loop 不会被淘汰——每个节点本身就是一个 loop。

```mindmap
五层
prompt
context
harness
loop
graph
```

## 带走这一句

主讲：graph 工程既是真的，也被过度营销，两句同时成立。真正新的是并行专职节点、fan-out 加 fan-in、可当图读的控制流；被重新包装的是那个词。

主讲（轻快）：框架其实很朴素——一个 loop 就是 graph 里的一个节点。先把 loop 做对，等它真不够用，再连成 graph。

```note cloud
先把 loop 做对
```
