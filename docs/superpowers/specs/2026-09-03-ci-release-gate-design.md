# 7.3 CI/CD 双平台发布门禁设计

**日期：** 2026-09-03  
**状态：** 已确认设计，待编写实施计划  
**范围：** 仅接入 GitHub Actions 发布资格门禁，不连接或部署到生产服务器

## 1. 背景与目标

项目已经具备本地发布前验证命令，包括基础验证、构建，以及依赖原生 PostgreSQL 16 的发布门禁。当前仓库尚无 `.github/` CI 配置、Dockerfile 或生产部署配置，也没有可用的 GitHub 远程仓库。因此，本阶段先把现有验证能力接入 GitHub Actions，使每次拟合并到 `master` 的改动都必须在 Linux 和 Windows 两个平台通过相同的发布资格检查。

本设计的目标是形成一个固定、可审计的“发布资格”状态检查：任一平台失败、取消或超时，最终门禁都失败；只有两个平台全部成功，最终门禁才成功。

## 2. 范围

本阶段包含：

- 新增一个 GitHub Actions 工作流，执行 Ubuntu 24.04 与 Windows Server 2025 双平台矩阵验证。
- 在两个平台上分别执行冻结依赖安装、现有项目验证、基础测试、构建和原生 PostgreSQL 发布门禁。
- 新增一个名称固定的汇总作业，作为 GitHub 分支保护或 Ruleset 唯一要求的状态检查。
- 新增对工作流配置本身的语义契约测试，防止安全设置、平台矩阵、命令顺序和汇总逻辑被意外弱化。
- 新增运维说明，覆盖首次启用 required check、常见失败排查和安全停用顺序。

本阶段不包含：

- 生产服务器连接、生产部署、云资源创建或部署凭据配置。
- Docker 镜像构建、发布或容器编排。
- 自动修改 GitHub 分支保护或 Ruleset。
- 使用外部 PostgreSQL、生产数据库或长期共享测试数据库。
- 修改现有产品页面、业务功能或数据库业务模型。

## 3. 当前基础与约束

- 根目录使用 `pnpm@10.34.5`，依赖锁文件为 `pnpm-lock.yaml`。
- CI 使用 Node.js `24.20.0`，避免浮动主版本导致构建环境无提示变化。
- 项目现有发布资格命令为：
  1. `pnpm verify`
  2. `pnpm test:foundation`
  3. `pnpm build`
  4. `pnpm test:native-release`
- `test:native-release` 在没有 `TEST_DATABASE_URL` 时自行启动临时的嵌入式 PostgreSQL 16，并在结束时清理；它拒绝非 PostgreSQL、默认数据库和非 `_test` 数据库。
- GitHub service container 仅适用于 Linux runner，不能验证 Windows 上的嵌入式 PostgreSQL 路径，因此本设计不使用 service container。
- 当前仓库没有 GitHub remote。工作流文件和说明可以本地完成并验证，但 required check 只能在推送到 GitHub、工作流至少成功运行一次后由仓库管理员启用。

## 4. 选定架构

### 4.1 单工作流、双平台矩阵

新增 `.github/workflows/release-gate.yml`，工作流显示名称固定为 `Release Gate`。矩阵作业使用以下固定定义：

- 作业 ID：`platform-gates`
- 显示名称：`Platform gates (${{ matrix.os }})`
- runner：`ubuntu-24.04`、`windows-2025`
- `strategy.fail-fast: false`，确保一个平台失败后另一个平台仍完成并提供诊断信息。
- 作业超时：30 分钟。

每个平台按相同顺序执行：

1. 检出代码，且不持久化 GitHub 凭据。
2. 安装固定版本 pnpm。
3. 安装固定版本 Node.js，并启用 pnpm store 缓存。
4. `pnpm install --frozen-lockfile`。
5. `pnpm test:ci-config`，验证工作流配置契约。
6. `pnpm verify`。
7. `pnpm test:foundation`。
8. `pnpm build`。
9. `pnpm test:native-release`。

缓存只覆盖 pnpm store，并以根目录 `pnpm-lock.yaml` 作为依赖缓存输入；不缓存 `node_modules`。

### 4.2 固定汇总门禁

新增汇总作业：

- 作业 ID：`release-gate`
- 显示名称：`Release Gate Required`
- 依赖：`platform-gates`
- 条件：始终运行，即使矩阵作业失败、取消或超时。
- 作业超时：5 分钟。
- 成功条件：`needs.platform-gates.result` 必须严格等于 `success`，否则明确以非零状态退出。

GitHub 分支保护或 Ruleset 只要求 `Release Gate Required`。固定汇总状态隔离了矩阵作业名称变化，并避免某个平台失败时汇总作业因默认跳过规则而被误判为成功。

## 5. 触发与并发控制

工作流触发条件：

- `pull_request`：目标分支为 `master`。
- `push`：分支为 `master`。
- `workflow_dispatch`：允许人工重跑。
- `merge_group` 的 `checks_requested`：为以后启用 GitHub merge queue 保留兼容性。

并发组由工作流名称与 pull request 编号或 Git ref 组成。只对 `pull_request` 事件取消同一变更的旧运行；`push`、`workflow_dispatch` 和 `merge_group` 运行不自动取消，保证主分支和人工发布资格结果完整可追溯。

不使用 `pull_request_target`，避免在高权限上下文执行来自 pull request 的代码。

## 6. 权限与供应链安全

- 工作流权限限定为 `contents: read`，不授予写权限。
- 检出步骤设置 `persist-credentials: false`。
- 不读取 GitHub Secrets，不设置生产数据库连接串。
- 第三方和官方 Action 全部固定到完整 commit SHA，并在配置旁注释对应版本：
  - `actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd`（v6.0.2）
  - `pnpm/action-setup@0e279bb959325dab635dd2c09392533439d90093`（v6.0.8）
  - `actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38`（v6.5.0）
- pnpm 固定为 `10.34.5`，Node.js 固定为 `24.20.0`。
- 默认不上传诊断 artifact。GitHub 日志足以支持首版排障，并可避免误上传数据库目录、环境变量或依赖目录。

## 7. 工作流配置契约测试

工作流 YAML 必须通过解析器进行语义验证，不能依赖易碎的文本搜索。根目录新增 `test:ci-config` 命令，契约测试至少断言：

- 触发事件及 `master` 分支范围正确，且不存在 `pull_request_target`。
- 工作流权限严格为只读。
- 矩阵只包含 `ubuntu-24.04` 与 `windows-2025`，且 `fail-fast` 为 false。
- 三个 Action 使用上述完整 SHA；检出凭据不持久化。
- Node.js、pnpm 和锁文件安装策略均为固定值。
- 平台作业包含规定的五个测试/构建命令，并保持顺序。
- 两个作业超时已设置。
- 汇总作业始终运行，并严格检查矩阵结果为 `success`。
- 配置不引用 secrets、生产数据库、部署动作或 GitHub 写权限。

测试所需 YAML 解析依赖应作为固定版本的开发依赖加入根目录，并更新锁文件。具体文件结构、测试框架选择和断言实现将在实施计划中确定。

## 8. 失败语义与诊断

- 依赖安装、配置契约、任一现有验证命令或数据库启动清理失败，都使当前平台作业失败。
- 某个平台失败不会提前取消另一个平台。
- 矩阵失败、取消或超时都会使 `Release Gate Required` 失败。
- PostgreSQL 生命周期由现有 native release runner 管理，并通过 `finally` 清理；CI 不保留 PGDATA。
- 首版排障以 GitHub Actions 原生日志为准。若后续证明确有需要，可单独设计仅失败时上传、经过脱敏的测试报告；不得上传 PGDATA、`node_modules` 或环境变量快照。

## 9. 启用与运维

工作流合并并推送到 GitHub 后：

1. 等待 `master` 上首次 `Release Gate Required` 成功运行，使检查名称出现在 GitHub 可选列表中。
2. 在分支保护或 Ruleset 中将 `Release Gate Required` 设为 `master` 的 required status check。
3. 用一个测试 pull request 验证未通过门禁时不能合并、通过后可以合并。

运维说明需记录：

- 如何区分依赖安装、通用测试、构建和 PostgreSQL 门禁故障。
- 如何在 GitHub 上人工重跑，以及何时应优先本地复现。
- 没有远程仓库时哪些步骤无法执行。
- 安全停用顺序：先从分支保护或 Ruleset 移除 required check，再删除或重命名工作流/汇总作业。反向操作可能永久阻塞合并。

## 10. 备选方案与取舍

### 仅 Ubuntu 门禁

执行更快、成本更低，但无法验证 Windows 上的嵌入式 PostgreSQL、本地脚本和路径行为。项目主要在 Windows 环境开发，因此不采用。

### Linux PostgreSQL service container + Windows 跳过数据库门禁

可以缩短部分启动时间，但两个平台验证的数据库路径不一致，而且 service container 不支持 Windows runner。无法满足“双平台原生发布门禁”的目标，因此不采用。

### 两个独立 required checks

配置直观，但矩阵或显示名称调整会增加分支保护维护成本，也更容易出现漏选检查。采用固定汇总作业作为唯一 required check。

### 本阶段自动配置分支保护

需要 GitHub remote、仓库权限和写入凭据，且超出“只做发布门禁、不连接生产”的最小范围。当前改为提供明确的人工启用说明。

## 11. 验收标准

- 工作流语义配置测试通过。
- Ubuntu 24.04 与 Windows Server 2025 均执行冻结安装和全部规定命令。
- 任一平台失败、取消或超时时，`Release Gate Required` 失败；两者都成功时它才成功。
- 工作流只具备读取仓库内容的权限，不使用 secrets，不执行部署。
- 所有 Action、Node.js 和 pnpm 版本均固定。
- 本地完整验证继续通过，且新增配置测试纳入验证范围。
- 运维文档明确首次启用 required check、失败排查及安全停用方式。
- 当前无 GitHub remote 的限制被明确记录，不虚报远程门禁已启用。

## 12. 参考资料

以下资料均于 2026-09-03 核验：

- [GitHub Actions 工作流语法](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [GitHub 受保护分支与 required status checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [GitHub Actions 安全使用与完整 SHA 固定](https://docs.github.com/en/actions/reference/security/secure-use)
- [GitHub PostgreSQL service container 指南](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers)
- [actions/setup-node 缓存说明](https://github.com/actions/setup-node)
- [pnpm/action-setup](https://github.com/pnpm/action-setup)
- [embedded-postgres](https://github.com/leinelissen/embedded-postgres)
- [Node.js v24 发布归档](https://nodejs.org/en/download/archive/v24)

