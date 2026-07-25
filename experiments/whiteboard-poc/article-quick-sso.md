# Amazon Quick 联合登录怎么做

> cast: 主讲=narrator-female-warm, 提问=narrator-male-lively
> format: long

## 两个端，两套协议

主讲：Amazon Quick 有两个客户端，Web 和 Desktop。它们用的登录协议不一样：Web 走 SAML，Desktop 只支持 OIDC 加 PKCE。

主讲：但两端最终都按 ID token 里的 email，解析到账户内的同一个用户。email 就是整个身份集成的锚点，这一点记住了，后面所有的坑都能对上号。

![协议差异](assets/quick-doc/01-web-desktop-protocols.png)

## Desktop 的硬要求

提问（设问）：既然 Desktop 只认 OIDC，那是不是随便一个 IdP 都能接？

主讲（严肃）：不是。Desktop 对 IdP 有四条硬性要求：公共客户端不带 client secret、PKCE 用 S256、必须签发 offline_access 拿到 refresh token、ID token 里必须有 email claim。

主讲：飞书原生平台这四条一条都不满足。钉钉 IDaaS、Okta、Entra ID 是全满足的。所以用飞书就必须加一层桥接，用 Keycloak 或者 Cognito。

![素材](il:checklist,requirements,verification)

- 公共客户端
- PKCE S256
- offline_access
- email claim

## 三种集成方式

主讲：Quick Web 支持三种认证方式。第一种是 IAM Identity Center 桥接，第二种是 IAM Federation 直连，第三种是 AWS Managed AD 变通。

主讲（严肃）：这里有一个不可逆的决定：开通 Quick 服务时选定的认证方式，之后不能改。要改只能注销账户重建。所以务必在开通之前把方案调研清楚。

![三种方式](assets/quick-doc/02-three-auth-methods.png)

## 不可逆的三件事

主讲：除了认证方式，还有两个一次性决定。Extension access 创建之后不可编辑，任何一个 OIDC 端点填错，只能删掉重建。

主讲：还有 sub claim 用哪个飞书 ID。我们默认用 union_id，因为换应用之后身份还稳定；用 open_id 只在单个应用内唯一，改动会导致所有用户重新预置。

![素材](il:warning,caution,alert)

- 认证方式不可改
- Extension 不可编辑
- sub 选择不可逆

## 方式一：桥接

主讲：第一种方式，企业 IdP 作为 IAM Identity Center 的外部身份源。用户和组通过 SCIM 自动同步到 Identity Center，Quick 在订阅时把组映射成角色。

主讲：这是官方推荐的方式。好处是身份管理体系化、集中化，而且订阅的时候就能直接把用户映射成 Pro 角色。

![方式一](assets/quick-doc/03-way1-identity-center.png)

## 方式二：直连

主讲：第二种方式，把 IdP 直接注册成 AWS 的 SAML Provider，在 IdP 里配置组和 IAM 角色的映射关系。IAM Federation 里不存用户目录，所以不需要做用户同步。

主讲：用户第一次登录时，Quick 按断言里的 email 找人，找不到就按那个 IAM 角色的权限自动创建订阅。省掉了 SCIM，但代价我们马上就讲。

![方式二](assets/quick-doc/04-way2-iam-federation.png)

## 我做的一键部署

主讲：我们这边没有现成的企业 IdP，只有飞书。所以我做了一套一键部署，用 Cognito 当身份枢纽，飞书作为它的联邦上游。

主讲：中间那层适配器是 Lambda 加 API Gateway，做三件事：把飞书的授权接口代理成标准 OIDC 端点、用 KMS 的非对称密钥签发 ID token、以及剥掉 Quick Desktop 强发的 offline_access 参数，因为 Cognito 不认这个 scope。

主讲：全 Serverless，没有数据库也没有常驻服务器，两个 Lambda、一个 Cognito 用户池、一个 KMS 密钥，一条 CDK 命令部署完。

![素材](il:serverless,cloud computing,api)

- Lambda 适配协议
- KMS 签 id_token
- 剥 offline_access
- 私钥不出 KMS

## 坑一：离职回收

~~飞书禁用就等于回收~~

提问（设问）：员工从飞书离职了，是不是他就登不进 Quick 了？

主讲（严肃）：不是。这是这套方案最需要注意的一个坑。在 Cognito 的 refresh token 有效期内，登录过程不会回飞书重新校验用户状态。人已经离职了，只要 token 还没过期，他依然登得进来。

主讲：原生的 IAM Identity Center 方式是通过 SCIM 同步删除用户的，离职即失效。而 IAM Federation 这条路根本没有目录同步，也就没有这个能力。

主讲：所以上线前必须落实两件事：把 Cognito 的 refresh token 有效期按安全基线收紧，以及离职时主动禁用 Cognito 用户，配合 AdminUserGlobalSignOut 立即吊销他所有已签发的令牌。切勿只依赖飞书侧禁用账号。

- 不回源校验
- 收紧 token 有效期
- 主动禁用用户
- 全局吊销令牌

## 坑二：初始角色

主讲：第二个坑更隐蔽。Quick 有六种角色，三种人格乘以是否 Pro。Pro 和非 Pro 的差别是全部的 AI 能力：AI Chat Agents、协作空间、数据流、研究，都只有 Pro 才有。

主讲（严肃）：而 IAM Federation 自动创建用户的时候，只能创建 reader、author、admin 这三个非 Pro 角色。这三个是 QuickSight 时代留下来的 BI 权限。一个自动创建出来的 reader，是没有 AI Chat 能力的。

主讲：原因是专业版角色没有对应的 IAM 自助预置 action，我对照服务权限清单核实过。

![素材](il:permission,access control,lock)

- Pro 才有 AI 能力
- 自助预置只到非 Pro
- reader 没有 AI Chat

## 我们怎么绕过去

主讲：解法是不让 IAM 自助预置去创建用户。Web 登录门户在联邦跳转之前，先主动调一次 RegisterUser，把这个用户预注册成 reader pro。等联邦跳转到 Quick 的时候，用户已经存在了，自助预置就不会再介入。

主讲：权限上我们用 quicksight 的 IamArn 条件键做了限定，这个注册动作只能绑定本联邦角色。注册出异常时回退成对应的基础角色，不至于让人登不进去。

主讲（严肃）：但要清楚它的边界：只影响首次登录的新用户，已有用户的角色不变；而且管理员不能降级为读者，那种情况只能删掉重新预置。

![素材](il:solution,problem solving,fix)

- 跳转前预注册
- 条件键限定权限
- 只影响新用户
- 管理员不可降级

## 推荐路径：Entra ID

主讲：如果组织本来就有企业 IdP，比如 Entra ID 或者 Okta，那就走方式一。我另外写了一篇 Entra ID 加 IAM Identity Center 的完整落地文档。

主讲：走这条路，前面两个坑都不存在。SCIM 会自动同步用户的增删，离职即失效。订阅时六个角色各有一个组的输入框，可以直接把用户映射成 Reader Pro 或者 Author Pro，不需要事后改角色。整套是零代码的，纯控制台配置。

![素材](il:best practice,recommendation,award)

- SCIM 自动删除
- 直接映射 Pro
- 零代码配置

## Entra ID 的几个坑

主讲（严肃）：这条路也有几个会让你返工的地方。Issuer URL 必须带斜杠 v2 点 0 后缀，少了会报 Invalid issuer，而控制台的 Authority URL 恰好没有这个后缀，很容易复制错。

主讲：email claim 要在 Token configuration 里显式加，而且用户的 Mail 属性必须有值，光有 UPN 不够，否则登录会报 User not found。

主讲：如果 Identity Center 里已经存在同邮箱的旧用户，SCIM 会跳过这个人，得先把旧用户删掉重新同步。另外嵌套组不会被展开，只有直接分配给应用的组的直接成员才会同步。

主讲（严肃）：最后一个容易忽略的：切换身份源会影响同一个账号下所有依赖 Identity Center 的应用，包括 Kiro 的登录。相关用户也必须在 Entra 侧分配到那个企业应用里。

- Issuer 要带 v2.0
- Mail 属性必须有值
- 同邮箱阻塞同步
- 嵌套组不展开
- 会影响 Kiro 登录

## 怎么选

主讲：最后是决策路径。第一次用 Quick、又有满足条件的企业 IdP，无脑选方式一。已经在用 QuickSight 并且做过 IAM Federation，可以沿用方式二。IdP 不满足 Desktop 的 OIDC 要求，加一层 Keycloak 或者 Cognito 桥接。

主讲：云上已经部署了 AWS Managed AD 的重度用户，可以考虑方式三，但要接受 Web 和 Desktop 需要登录两次。

![决策路径](assets/quick-doc/06-decision-path.png)

## 一页总结

主讲：三句话收尾。认证方式一经选定不可更改，开通之前一定要调研清楚。

主讲：有企业 IdP 就走 IAM Identity Center，能拿到 SCIM 的自动增删和直接映射 Pro 角色这两件事。

主讲：只有飞书、必须走 IAM Federation 的话，一键部署的仓库可以直接用，但离职回收和初始角色这两个坑要自己补上。

![素材](il:summary,report,conclusion)

- 认证方式不可改
- 有 IdP 走方式一
- 补齐两个坑
