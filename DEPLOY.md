# Docker 部署指南


## 开发数据库初始化与重建

项目尚未上线，不提供旧对话、旧记忆或旧数据库结构的兼容迁移。当前版本只使用 `applyCurrentSchema` 创建当前结构。

- 全新数据库：配置 `.env` 后执行 `pnpm init-db`，创建当前应用表和业务样例数据。
- 当前开发库迁移：`pnpm migrate:database --reset-analysis`。这会在事务中删除并重建对话、消息、任务、证据、分析状态及业务定义表，同时删除旧记忆、message_block 和废弃 retention 表。账号、数据源、权限与业务样例表保留。存在活动任务时命令拒绝重建。
- 已是当前结构时：`pnpm migrate:database` 只补齐缺失表，不回填历史数据；检测到旧结构需使用上述重建命令。
- 构建运行匹配的 API、Worker、Web。旧的 `ANALYSIS_CORE` 及 Artifact 临时开关已删除，无需配置。任务协议、权限、取消和多会话隔离检查仍保留，这些是当前运行正确性约束。

2026-09-22 已按用户授权在本机 `localhost:5432/gist_agent` 执行分析数据重建并提交，旧测试会话已清除。后续重跑 `--reset-analysis` 也会清空新增分析数据，勿将它作为日常启动命令。

快速验证：`pnpm test:analysis-cutover`、`pnpm test:analysis-core`、`pnpm test:analysis-state`、`pnpm --filter @gist/web build`。业务和交互验收仍按 [S4 walkthrough](benchmarks/saas-growth/S4-WALKTHROUGH.md) 单独进行。

## 一、服务器环境要求

- 已安装 **Docker** 和 **Docker Compose**（或 `docker compose` 插件）
- 开放 **80** 端口（或你打算映射的端口）
- 若用域名 + HTTPS，需提前把域名解析到本机 IP

检查命令：

```bash
docker --version
docker compose version
```

---

## 二、拉取代码

```bash
cd /opt   # 或你习惯的目录
git clone <你的仓库地址> gist-agent
cd gist-agent
```

---

## 三、配置环境变量

在项目根目录创建 `.env`，内容参考 `.env.example`，**必须**改成你自己的值：

```bash
cp .env.example .env
vim .env   # 或 nano / 其他编辑器
```

**必填项：**

| 变量 | 说明 | 示例 |
|------|------|------|
| `OPENAI_API_KEY` | 大模型 API Key | `sk-xxxx` |
| `OPENAI_BASE_URL` | 大模型 API 地址 | `https://api.openai.com/v1` 或第三方地址 |
| `OPENAI_MODEL` | 模型名 | `gpt-4o` |
| `DB_HOST` | 数据库地址 | `localhost` 或容器服务名 `mysql` |
| `DB_PORT` | 数据库端口 | `3306` |
| `DB_USER` | 数据库用户 | `root` |
| `DB_PASSWORD` | 数据库密码 | 强密码，不要用默认 |
| `DB_NAME` | 数据库名 | `ai_analysis` |
| `JWT_SECRET` | 登录 Token 签名密钥 | 随机长字符串，生产务必改 |
| `SMTP_HOST` | SMTP 服务器地址 | `smtp.example.com` |
| `SMTP_PORT` | SMTP 端口 | `465` |
| `SMTP_USER` | SMTP 用户名 | `your-email@example.com` |
| `SMTP_PASS` | SMTP 授权码/密码 | `your-smtp-password` |
| `SMTP_FROM` | 邮件发送者信息 | `"AI Data Analysis <your-email@example.com>"` |
| `LANGSMITH_TRACING` | 是否开启 LangSmith 追踪 | `true` / `false` |
| `LANGSMITH_API_KEY` | LangSmith API Key | `lsv2_pt_...` |
| `LANGSMITH_PROJECT` | LangSmith 项目名 | `gist-agent` |

**注意：** `.env` 不要提交到 Git，已在 `.gitignore` 中。

---

## 四、构建并启动

```bash
docker compose up -d --build
```

- 首次会拉取 MySQL 镜像并构建 web、server 镜像，可能需要几分钟。
- 启动后：MySQL 先起并做健康检查，通过后 server 再起，最后 web（Nginx）监听 80。

检查容器状态：

```bash
docker compose ps
```

应看到 `mysql`、`server`、`web` 三个服务均为 `running`。

---

## 五、初始化数据库（仅首次部署执行一次）

表结构和演示数据由 init-db 脚本创建，需在 **mysql、server 已启动** 后执行：

```bash
docker compose --profile tools run --rm init-db
```

看到 `Database initialized successfully.` 即表示成功。若报错连接不上 MySQL，可先等 30 秒再执行一次（等 MySQL 完全就绪）。

---

## 六、访问与验证

- 浏览器访问：`http://<服务器IP>`（若改过端口则用 `http://<服务器IP>:端口`）
- 应能看到登录/注册页；注册账号后即可使用。

若无法访问，可按下面「常见问题」排查。

---

## 七、端口与域名

**本机 80 端口已被占用时：**

编辑 `docker-compose.yml` 中 web 的端口映射，例如改为 8080：

```yaml
ports:
  - "8080:80"
```

然后访问 `http://<服务器IP>:8080`。

**使用域名 + HTTPS：**

1. 域名 A 记录解析到本服务器 IP。
2. 在服务器再装一个 Nginx（宿主机），用 certbot 申请证书，并反向代理到本机 `http://127.0.0.1:80`（或你映射的端口）。
   或：把 web 的 `ports` 改为 `"127.0.0.1:80:80"`，仅本机访问，由宿主机 Nginx 做 SSL 与域名。

---

## 八、常用命令

| 操作 | 命令 |
|------|------|
| 查看日志 | `docker compose logs -f`（所有）或 `docker compose logs -f server`（仅后端） |
| 停止 | `docker compose down` |
| 停止并删数据卷 | `docker compose down -v`（会清空 MySQL 数据） |
| 重启 | `docker compose restart` |
| 重新构建并启动 | `docker compose up -d --build` |

---

## 九、常见问题

**1. 访问页面 502 / 打不开**

- 执行 `docker compose ps` 看 server、web 是否都在 running。
- 执行 `docker compose logs server` 看是否有报错（如连不上 MySQL、缺环境变量）。

**2. 注册/登录一直转圈或报错**

- 看 `docker compose logs server` 是否有异常。
- 确认 `.env` 里 `JWT_SECRET`、`OPENAI_*` 已填写且未有多余空格。

**3. init-db 报错连接 MySQL 失败**

- 先执行 `docker compose up -d`，等约 30 秒再执行：
  `docker compose --profile tools run --rm init-db`。
- 确认 `.env` 中 `DB_PASSWORD`、`DB_NAME` 与 docker-compose 里 MySQL 的配置一致（compose 里数据库名、root 密码来自 `.env`）。

**4. 修改 .env 后不生效**

- 修改了 .env 必须同步在 `docker-compose.yml` 中添加对应的配置项
- 两步操作：服务器环境变量文件 .env 手动添加变量，本地代码中 `docker-compose.yml` 中添加对应的配置项
- 改完保存后执行：`docker compose up -d` 重新创建 server 容器，使新环境变量生效。
- 或者走 github action 自动 cicd 就行

---

## 十、CI/CD 自动部署

推送代码到 `main` 分支后，由 GitHub Actions 通过 SSH 登录服务器执行 `git pull` 和 `docker compose up -d --build`，无需再手动登录操作。

**前提：** 仓库在 GitHub 上，且已完成「一～五」步的首次部署（服务器上已有项目目录和 `.env`）。

### 10.1 在服务器上准备 SSH 公钥

用打算做 CI 的机器（或本机）生成一对密钥，把**公钥**放进服务器：

```bash
# 本机生成（若还没有）
ssh-keygen -t ed25519 -C "github-deploy" -f ~/.ssh/deploy -N ""

# 把公钥追加到服务器的 authorized_keys
cat ~/.ssh/deploy.pub
# 复制输出，登录服务器后执行：
# echo "粘贴的公钥" >> ~/.ssh/authorized_keys
```

或：服务器启用密码登录，用密码在 Actions 里登录（不推荐，建议用 key）。

### 10.2 在 GitHub 仓库配置 Secrets

仓库 → Settings → Secrets and variables → Actions → New repository secret，添加：

| Name | 说明 | 示例 |
|------|------|------|
| `SERVER_HOST` | 服务器 IP 或域名 | `123.45.67.89` |
| `SERVER_USER` | SSH 登录用户名 | `root` 或 `ubuntu` |
| `SSH_PRIVATE_KEY` | 上面生成的**私钥**完整内容 | 含 `-----BEGIN ... KEY-----` 整段 |
| `SERVER_PORT` | 可选，SSH 端口，不填默认 22 | `22` |
| `DEPLOY_PATH` | 可选，项目在服务器上的路径，不填默认 `/opt/gist-agent` | `/opt/gist-agent` |

`SSH_PRIVATE_KEY`：打开 `~/.ssh/deploy`，复制全部内容（包括首尾两行）粘贴到 secret 值里。

### 10.3 行为说明

- **触发条件：** 推送到 `main` 分支，或 Actions 页里手动 Run workflow。
- **执行内容：** SSH 到服务器 → 进入项目目录 → `git pull` → `docker compose up -d --build`。
- **不执行：** 不会执行 `init-db`（数据库只需首次手动跑一次）；不会覆盖服务器上的 `.env`（该文件不在 Git 里）。

若主分支名是 `master`，把 workflow 里的 `branches: [main]` 改成 `branches: [master]`。

---

## 十一、部署流程小结（复制执行）

```bash
cd /opt && git clone <仓库地址> gist-agent && cd gist-agent
cp .env.example .env
# 编辑 .env 填入真实配置
vim .env

docker compose up -d --build
sleep 30
docker compose --profile tools run --rm init-db

# 浏览器访问 http://<服务器IP>
```

按上述步骤操作即可在线上完成部署并访问。
